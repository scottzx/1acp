/** DSH session execution behind the shared A2A service's transport-independent backend. */
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock, MessageId, UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionId, TurnEndReason } from '@deepseek-ai/dsh-session';
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller';
import type { A2ABackend, A2APrepareInput, A2ARunResult, A2ATarget } from '@1agents/acp-service/a2a';

function resultOf(reason: TurnEndReason, text: string, finalAnswerExpected: boolean): A2ARunResult {
  switch (reason.kind) {
    case 'completed': return finalAnswerExpected && !text.trim()
      ? { outcome: 'failed', text, detail: 'DSH completed the task without a final answer; ACP final-answer metadata contained no final output' }
      : { outcome: 'completed', text };
    case 'blocked': return { outcome: 'input-required', text, detail: 'DSH blocked the task before its next model step' };
    case 'error': return { outcome: 'failed', text, detail: reason.error.message };
    case 'max-tokens': return { outcome: 'failed', text, detail: 'DSH reached the model output token limit' };
    case 'aborted': return { outcome: 'failed', text, detail: 'DSH task execution was canceled' };
    case 'interrupted': return { outcome: 'failed', text, detail: 'DSH task execution was interrupted' };
    case 'forked': return { outcome: 'failed', text, detail: 'DSH task turn was closed by a session fork' };
    // DSH's turn reasons are merge-extensible; an unknown ending cannot report success.
    default: return { outcome: 'failed', text, detail: 'DSH returned an unsupported turn ending' };
  }
}

/** Read durable ACP metadata, leaving ordinary DSH messages compatible. */
function answerOf(content: readonly ContentBlock[], turn: number): { text: string; authoritative: boolean; phased: boolean } {
  const blocks = content.filter(part => part.type === 'text') as (ContentBlock & {
    text: string;
    acpResult?: { turn?: number; finalAnswer?: unknown };
    acpStream?: { turn?: number; messagePhase?: unknown };
  })[];
  const terminal = blocks.findLast(part => part.acpResult?.turn === turn && typeof part.acpResult.finalAnswer === 'string');
  if (terminal) return { text: terminal.acpResult!.finalAnswer as string, authoritative: true, phased: true };
  const phased = blocks.some(part => part.acpStream?.turn === turn && typeof part.acpStream.messagePhase === 'string');
  return {
    text: blocks.filter(part => !phased || (part.acpStream?.turn === turn && part.acpStream.messagePhase === 'final_answer')).map(part => part.text).join(''),
    authoritative: false, phased,
  };
}

/** Uses public session-controller and inbox events to account for one A2A prompt's exact DSH turn. */
export class DshA2ABackend implements A2ABackend {
  private readonly executions = new Map<string, Promise<void>>();
  /** @param ctx DSH plugin context that owns session-controller and execution event registrations. */
  constructor(private readonly ctx: Context) {}

  /** Create a new session or restore an explicitly addressed session without changing its workspace or preset.
   * @param input Remote host directory, preset, and optional existing DSH session identity.
   * @returns The resolved DSH session and its durable workspace and preset.
   */
  async prepare(input: A2APrepareInput): Promise<A2ATarget> {
    const previous = input.sessionId === undefined
      ? undefined
      : await this.ctx.sessionController.inspect(input.sessionId as SessionId);
    const requestedCwd = input.cwd ?? previous?.meta.cwd ?? process.cwd();
    if (!isAbsolute(requestedCwd)) throw new Error('A2A cwd must be an absolute directory on the DSH host');
    const cwd = await realpath(requestedCwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error('A2A cwd must point to a directory on the DSH host');
    const agentPreset = input.agentPreset ?? previous?.meta.agentPreset;
    const created = await this.ctx.sessionController.create({
      cwd,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId as SessionId }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
    });
    const agent = await this.agent(created.sessionId);
    return {
      sessionId: created.sessionId,
      cwd: agent.session.header.cwd ?? cwd,
      ...(created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset }),
    };
  }

  /** Admit one identified queued prompt and wait only for its own turn, independent of the HTTP connection.
   * @param target Previously prepared DSH session.
   * @param prompt Plain-text A2A message content.
   * @param options Task-owned request identity and cancellation signal.
   * @returns The exact turn's ending and its final assistant text.
   */
  async run(target: A2ATarget, prompt: string, options: { requestId: string; signal: AbortSignal }): Promise<A2ARunResult> {
    options.signal.throwIfAborted();
    const queuedAbort = Promise.withResolvers<A2ARunResult>();
    const abort = (): void => { queuedAbort.reject(options.signal.reason); };
    options.signal.addEventListener('abort', abort, { once: true });
    const operation = (this.executions.get(target.sessionId) ?? Promise.resolve()).then(() => {
      options.signal.removeEventListener('abort', abort);
      options.signal.throwIfAborted();
      return this.execute(target, prompt, options);
    });
    const tail = operation.then(() => undefined, () => undefined);
    this.executions.set(target.sessionId, tail);
    void tail.then(() => { if (this.executions.get(target.sessionId) === tail) this.executions.delete(target.sessionId); });
    try { return await Promise.race([operation, queuedAbort.promise]); }
    finally { options.signal.removeEventListener('abort', abort); }
  }

  private async execute(target: A2ATarget, prompt: string, options: { requestId: string; signal: AbortSignal }): Promise<A2ARunResult> {
    const agent = await this.agent(target.sessionId as SessionId);
    options.signal.throwIfAborted();
    const completion = Promise.withResolvers<A2ARunResult>();
    const listeners: (() => void)[] = [];
    let messageId: MessageId | undefined;
    let turn: number | undefined;
    let text = '';
    let finalAnswerExpected = false;
    let authoritativeAnswer = false;
    let settled = false;
    const owns = (message: UserMessage): boolean => message.source.kind === 'user'
      && 'rpcId' in message.source && message.source.rpcId === options.requestId;
    const settle = (result: A2ARunResult): void => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener('abort', cancel);
      completion.resolve(result);
    };
    const cancel = (): void => {
      if (settled) return;
      if (turn !== undefined) agent.cancel({ kind: 'user' }, { keepInbox: true });
      else if (messageId !== undefined) agent.inbox.remove(messageId);
    };
    // The session owns these temporary listeners until its turn settles. Plugin
    // unloading removes plugin effects concurrently with the server's cancel/drain.
    listeners.push(agent.ctx.on('agent/inbox/inserted', event => {
      if (event.agent !== agent || !owns(event.message)) return;
      messageId = event.message.id;
      if (options.signal.aborted) cancel();
    }));
    listeners.push(agent.ctx.on('agent/inbox/claimed', event => {
      if (event.agent !== agent || !owns(event.message)) return;
      messageId = undefined;
      turn = event.turn;
      if (options.signal.aborted) cancel();
    }));
    listeners.push(agent.ctx.on('agent/inbox/discarded', event => {
      if (event.agent === agent && owns(event.message)) {
        settle({ outcome: 'failed', text, detail: 'DSH discarded the queued task before execution' });
      }
    }));
    listeners.push(agent.ctx.on('agent/disposed', event => {
      if (event.agent === agent) settle({ outcome: 'failed', text, detail: 'DSH session was disposed before the task finished' });
    }));
    listeners.push(agent.ctx.on('session/event', (session, event) => {
      if (session !== agent.session || turn === undefined) return;
      if (event.type === 'assistant/message' && event.data.turn === turn) {
        const next = answerOf(event.data.message.content, turn);
        if (next.authoritative) { text = next.text; authoritativeAnswer = true; finalAnswerExpected = true; }
        else if (!authoritativeAnswer && next.phased) { text = next.text; finalAnswerExpected = true; }
        else if (!finalAnswerExpected && next.text.length > 0) text = next.text;
      } else if (event.type === 'turn/end' && event.data.turn === turn) {
        settle(resultOf(event.data.reason, text, finalAnswerExpected));
      }
    }));
    options.signal.addEventListener('abort', cancel, { once: true });
    try {
      // Recheck after event registration; cancellation can arrive during Agent restoration.
      options.signal.throwIfAborted();
      await this.ctx.sessionController.prompt({
        requestId: options.requestId as SessionRequestId,
        sessionId: agent.id,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      }, options.signal);
      if (options.signal.aborted) cancel();
      return await completion.promise;
    } finally {
      options.signal.removeEventListener('abort', cancel);
      for (const dispose of listeners.reverse()) dispose();
    }
  }

  private async agent(sessionId: SessionId): Promise<Agent> {
    const resolved = await this.ctx.sessionController.resolveAgent(sessionId);
    if ('error' in resolved) throw resolved.error;
    return resolved.agent;
  }
}
