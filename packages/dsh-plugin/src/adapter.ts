/** Presents an external Agent's output through DSH's existing streaming surface. */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { LlmAdapter, GenerateOptions, StreamChunk, LlmModelInfo, ContentBlock, MessageId } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-user-approval';
import type {} from '@deepseek-ai/dsh-user-questions';
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type { NewSessionRequest, SessionUpdate, RequestPermissionRequest, RequestPermissionResponse, SessionConfigOption, SessionModeState, AvailableCommand } from '@agentclientprotocol/sdk';
import { connect, object, type JsonObject } from './transport.js';
import { State, type Binding } from './state.js';
import { mergeTool, type RemoteTool } from './tool-events.js';
export interface Config { serviceUrl: string; agents: string[]; stateDirectory: string; reconnectAttempts: number; reconnectDelayMs: number }
export interface Capabilities {
  agent: string;
  commands: AvailableCommand[];
  configOptions: SessionConfigOption[];
  modes?: SessionModeState;
}
type Link = Awaited<ReturnType<typeof connect>>;

/** Producer/consumer queue; errors are delivered after already received chunks. */
class Queue<T> {
  values: T[] = []; done = false; error: unknown;
  private wake = Promise.withResolvers<void>();
  push(value: T) { this.values.push(value); this.wake.resolve(); }
  end(error?: unknown) { this.done = true; this.error = error; this.wake.resolve(); }
  async *read() {
    while (true) {
      while (this.values.length) yield this.values.shift()!;
      if (this.done) { if (this.error) throw this.error; return; }
      await this.wake.promise;
      this.wake = Promise.withResolvers<void>();
    }
  }
}

export class AcpAdapter implements LlmAdapter {
  private state: State;
  private controllers = new Map<string, AbortController>();
  private jobs = new Set<Promise<void>>();
  private links = new Map<string, Promise<Link>>();
  private connections = new Map<string, Promise<Link>>();
  private capabilities = new Map<string, Capabilities>();
  private commandScopes = new Map<string, () => Promise<unknown>>();
  private commandContexts = new Map<string, Context>();
  private commandDisposers = new Map<string, (() => void)[]>();
  private output = new Map<string, (update: SessionUpdate) => void>();
  private lifetime = new AbortController();
  constructor(private ctx: Context, private config: Config) { this.state = new State(config.stateDirectory); }
  providerInfo(provider: string) { return { id: provider, name: 'ACP Agents' }; }
  providerRetryPolicy() { return { mode: 'normal' as const, maxRetries: 0, retryableCodes: [], initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 }; }
  imageRequestPricing() { return undefined; }
  async listModels(provider: string): Promise<LlmModelInfo[]> {
    return [];
  }
  async resolveModel(provider: string, model: string) {
    if (!this.config.agents.includes(model)) throw new Error(`ACP Agent is not configured: ${model}`);
    return { provider, id: model, name: `ACP · ${model}`, inputModalities: ['text' as const] };
  }
  async prepareCall(provider: string, model: string) { return { model: await this.resolveModel(provider, model), stream: (o: GenerateOptions) => this.stream(o) }; }
  async dispose() {
    for (const c of this.controllers.values()) c.abort();
    this.lifetime.abort();
    await Promise.allSettled(this.jobs);
    for (const link of await Promise.allSettled(this.links.values())) if (link.status === 'fulfilled') link.value.close();
    for (const disposers of this.commandDisposers.values()) for (const dispose of disposers) dispose();
    this.links.clear();
    await Promise.allSettled([...this.commandScopes.values()].map(dispose => dispose()));
    this.commandScopes.clear();
    this.commandContexts.clear();
  }
  agentName(agent: Agent): string | undefined {
    const preset = this.ctx.sessionProjections.stateOf(agent.session, 'agentPreset');
    if (typeof preset !== 'string' || !preset.startsWith('oneagents-acp-')) return;
    const name = preset.slice('oneagents-acp-'.length);
    return this.config.agents.includes(name) ? name : undefined;
  }
  async describe(agent: Agent): Promise<Capabilities | null> {
    if (!this.agentName(agent)) return null;
    await this.connection(agent);
    return this.capabilities.get(agent.id)!;
  }
  async configure(agent: Agent, configId: string, value: string): Promise<Capabilities> {
    if (this.controllers.has(agent.id)) throw new Error('Wait for the current ACP turn to finish before changing configuration');
    const link = await this.connection(agent);
    const sessionId = this.state.get(agent.id)!.sessionId;
    const capabilities = this.capabilities.get(agent.id)!;
    if (configId === '$mode') {
      if (!capabilities.modes?.availableModes.some(m => m.id === value)) throw new Error('Unknown ACP mode');
      await link.rpc.request('session/set_mode', { sessionId, modeId: value });
      capabilities.modes.currentModeId = value;
    } else {
      const option = capabilities.configOptions.find(o => o.id === configId);
      if (!option) throw new Error('Unknown ACP configuration');
      const result = await link.rpc.request('session/set_config_option', { sessionId, configId, value });
      capabilities.configOptions = result.configOptions;
    }
    return capabilities;
  }
  /** Import native history without prompting; callers persist the returned service identity before creating DSH history.
   * @param name Configured ACP registry identifier.
   * @param cwd Existing original working directory.
   * @param nativeSessionId Original Agent session identifier.
   * @returns Binding using the service’s new identity and resume restoration mode.
   */
  async importNative(name: string, cwd: string, nativeSessionId: string): Promise<Binding> {
    if (!this.config.agents.includes(name)) throw new Error(`ACP Agent is not configured: ${name}`);
    const endpoint = new URL(`/agents/${encodeURIComponent(name)}`, this.config.serviceUrl);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    const task = (async () => {
      const link = await connect(endpoint.href, {
        update: () => {},
        permission: async () => ({ outcome: { outcome: 'cancelled' } }),
        question: async () => ({ outcome: 'cancelled' }),
        plan: async () => ({ outcome: 'abandoned' }),
      }, this.lifetime.signal);
      try {
        const result = object(await link.rpc.request('_1agents/session/import', {
          sessionId: nativeSessionId, cwd, mcpServers: [],
          _meta: { '1agents': { permissionMode: 'approve-reads' } },
        }, { cancellationSignal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(60_000)]) }));
        if (typeof result.sessionId !== 'string' || !result.sessionId) throw new Error('ACP import returned no service session ID');
        return { agent: name, cwd, endpoint: endpoint.href, sessionId: result.sessionId, restoreMethod: 'session/resume' as const };
      } finally { link.close(); await link.closed; }
    })();
    const settled = task.then(() => {}, () => {});
    this.jobs.add(settled);
    try { return await task; } finally { this.jobs.delete(settled); }
  }
  private publishCommands(agent: Agent, commands: AvailableCommand[]): void {
    const scope = this.commandContexts.get(agent.id);
    if (!scope) return; // A final transport notification may follow Agent disposal.
    for (const dispose of this.commandDisposers.get(agent.id) ?? []) dispose();
    const disposers: (() => void)[] = [];
    this.commandDisposers.set(agent.id, disposers);
    for (const command of commands) {
      // /model is the client picker over the Agent's advertised model options.
      if (command.name === 'model' || !/^[a-z][a-z0-9_-]*$/.test(command.name)) continue;
      disposers.push(scope.commands.register({
        name: command.name, description: command.description || `ACP /${command.name}`,
        ...(command.input ? { input: { hint: command.input.hint || 'Arguments' } } : {}),
        handler: ({ rawInput }) => {
          agent.followup({ id: randomUUID() as MessageId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `/${command.name}${rawInput}` }] });
          return { kind: 'success' };
        },
      }));
    }
  }
  private async connection(agent: Agent): Promise<Link> {
    const operation = (this.connections.get(agent.id) ?? Promise.resolve())
      .catch(() => undefined).then(() => this.openConnection(agent));
    this.connections.set(agent.id, operation);
    try { return await operation; }
    finally { if (this.connections.get(agent.id) === operation) this.connections.delete(agent.id); }
  }
  private async openConnection(agent: Agent): Promise<Link> {
    const name = this.agentName(agent);
    if (!name) throw new Error('ACP is available only in an ACP Agent preset; start a new ACP session');
    const cwd = agent.session.header.cwd;
    if (!cwd) throw new Error('Create the ACP session in a workspace first');
    const endpoint = new URL(`/agents/${encodeURIComponent(name)}`, this.config.serviceUrl);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    let binding = this.state.get(agent.id);
    if (binding && (binding.agent !== name || binding.cwd !== cwd || binding.endpoint !== endpoint.href)) {
      const boundary = this.ctx.sessionProjections.stateOf(agent.session, 'turnBoundary');
      const previousEndpoint = new URL(`/agents/${encodeURIComponent(binding.agent)}`, this.config.serviceUrl);
      previousEndpoint.protocol = endpoint.protocol;
      if (binding.imported || !boundary || boundary.openTurnStartSeq !== null || boundary.lastTurn > 0
        || binding.agent === name || binding.cwd !== cwd || binding.endpoint !== previousEndpoint.href) {
        throw new Error('This session is bound to another ACP Agent or endpoint; start a new session');
      }
      // Capability discovery may bind a draft before its first turn.
      // Retire its transport and commands before initializing the selected Agent.
      (await this.links.get(agent.id))?.close();
      this.links.delete(agent.id);
      this.capabilities.delete(agent.id);
      for (const dispose of this.commandDisposers.get(agent.id) ?? []) dispose();
      this.commandDisposers.delete(agent.id);
      binding = undefined;
    }
    const existing = this.links.get(agent.id);
    if (existing) return existing;
    const operation = (async () => {
      if (!this.commandContexts.has(agent.id)) {
        const fiber = await agent.ctx.inject(['commands'], scope => {
          this.commandContexts.set(agent.id, scope);
          scope.effect(() => () => {
            this.controllers.get(agent.id)?.abort();
            void this.links.get(agent.id)?.then(link => link.close(), () => {});
            this.links.delete(agent.id);
            this.commandContexts.delete(agent.id);
            this.commandScopes.delete(agent.id);
            this.capabilities.delete(agent.id);
            this.commandDisposers.delete(agent.id);
          });
        });
        this.commandScopes.set(agent.id, async () => fiber.dispose());
      }
      const capabilities: Capabilities = { agent: name, commands: [], configOptions: [] };
      this.capabilities.set(agent.id, capabilities);
      const interactionSignal = (signal: AbortSignal) => AbortSignal.any([signal, this.lifetime.signal, ...(this.controllers.has(agent.id) ? [this.controllers.get(agent.id)!.signal] : [])]);
      const link = await connect(endpoint.href, {
        update: update => {
          if (this.capabilities.get(agent.id) !== capabilities) return;
          if (update.sessionUpdate === 'available_commands_update') {
            capabilities.commands = update.availableCommands;
            this.publishCommands(agent, update.availableCommands);
          } else if (update.sessionUpdate === 'config_option_update') capabilities.configOptions = update.configOptions;
          else if (update.sessionUpdate === 'current_mode_update' && capabilities.modes) capabilities.modes.currentModeId = update.currentModeId;
          this.output.get(agent.id)?.(update);
        },
        permission: (p, s) => this.permission(agent, p, interactionSignal(s)),
        question: (p, s) => this.question(agent, p, interactionSignal(s)),
        plan: (p, s) => this.plan(agent, p, interactionSignal(s)),
      }, this.lifetime.signal);
      try {
        const params: NewSessionRequest = { cwd, mcpServers: [], _meta: { '1agents': { permissionMode: 'approve-reads' } } };
        const cancellationSignal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(60_000)]);
        const result = binding
          ? await link.rpc.request(binding.restoreMethod ?? 'session/load', { ...params, sessionId: binding.sessionId }, { cancellationSignal })
          : await link.rpc.request('session/new', params, { cancellationSignal });
        if (!binding) this.state.save(agent.id, { agent: name, endpoint: endpoint.href, cwd, sessionId: (result as { sessionId: string }).sessionId });
        capabilities.configOptions = result.configOptions ?? capabilities.configOptions;
        capabilities.modes = result.modes ?? undefined;
        void link.closed.then(() => { if (this.links.get(agent.id) === operation) this.links.delete(agent.id); });
        return link;
      } catch (error) { link.close(); throw error; }
    })();
    this.links.set(agent.id, operation);
    try { return await operation; }
    catch (error) { if (this.links.get(agent.id) === operation) this.links.delete(agent.id); throw error; }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const agent = options.sessionId ? this.ctx.agents.get(options.sessionId) : undefined;
    if (!agent || options.purpose) throw new Error('ACP requires a foreground DSH session; auxiliary model calls are unsupported');
    if (this.controllers.has(agent.id)) throw new Error('ACP session already has a running request');
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    signal.addEventListener('abort', () => controller.abort(), { once: true });
    this.controllers.set(agent.id, controller);
    const queue = new Queue<StreamChunk>();
    const task = this.run(agent, options, signal, queue).then(() => queue.end(), error => queue.end(error));
    this.jobs.add(task);
    try { yield* queue.read(); }
    finally { controller.abort(); await task; this.jobs.delete(task); this.controllers.delete(agent.id); }
  }
  private async permission(agent: Agent, params: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    const allow = params.options.find(o => o.kind === 'allow_once');
    const deny = params.options.find(o => o.kind === 'reject_once');
    if (!allow) return { outcome: { outcome: 'cancelled' } };
    const decision = await this.ctx.approval.request({ agent, toolName: params.toolCall.title || 'ACP tool',
      reason: JSON.stringify(params.toolCall.rawInput ?? params.toolCall.content ?? {}, null, 2), signal });
    const selected = decision === 'allowed-once' ? allow : decision === 'rejected' ? deny : undefined;
    return { outcome: selected ? { outcome: 'selected', optionId: selected.optionId } : { outcome: 'cancelled' } };
  }
  private async question(agent: Agent, p: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    const questions = (Array.isArray(p.questions) ? p.questions : []).map((value, i) => {
      const q = object(value);
      return { id: String(i), question: String(q.question ?? ''), header: typeof q.header === 'string' ? q.header : undefined,
        options: Array.isArray(q.options) ? q.options.map(value => { const o = object(value); return { label: String(o.label), description: typeof o.description === 'string' ? o.description : undefined }; }) : undefined,
        multiSelect: q.multiSelect === true };
    });
    try {
      const result = await this.ctx.userQuestions.ask({ agent, questions, signal });
      return { outcome: 'accepted', answers: Object.fromEntries(result.answers.map(a => [questions[Number(a.id)].question, a.custom || (a.selected.length === 1 ? a.selected[0] : a.selected)])) };
    } catch (error) { if (signal.aborted) return { outcome: 'cancelled' }; throw error; }
  }
  private async plan(agent: Agent, p: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    try {
      const result = await this.ctx.userQuestions.ask({ agent, signal, questions: [{ id: 'plan', question: 'ACP Agent 请求执行计划', detail: String(p.planContent ?? ''), options: [{ label: '批准' }, { label: '拒绝' }], intent: { kind: 'plan-review', approve: '批准' } }] });
      return { outcome: result.answers[0]?.selected.includes('批准') ? 'approved' : 'rejected' };
    } catch (error) { if (signal.aborted) return { outcome: 'abandoned' }; throw error; }
  }
  private async run(agent: Agent, options: GenerateOptions, signal: AbortSignal, queue: Queue<StreamChunk>): Promise<void> {
    const cwd = agent.session.header.cwd;
    if (!cwd) throw new Error('Create the ACP session in a workspace first');
    // Only newly admitted input goes to the stateful remote Agent. Its native
    // conversation already owns prior turns and tool results.
    let start = options.messages.length - 1;
    while (start >= 0 && options.messages[start].role !== 'assistant') start--;
    if (this.agentName(agent) !== options.model) throw new Error('ACP is available only in its matching Agent preset; start a new ACP session');
    const importedIds = new Set(this.state.get(agent.id)?.imported?.messageIds ?? []);
    const input = options.messages.slice(start + 1).filter(m => m.role === 'user' && m.source?.kind === 'user' && (m.id === undefined || !importedIds.has(m.id)));
    const blocks = input.flatMap(m => m.content);
    if (!blocks.length || blocks.some(b => b.type !== 'text')) throw new Error('This ACP plugin currently accepts text prompts only');
    const text = blocks.map(b => (b as { text: string }).text).join('\n\n');
    const requestId = 'dsh-' + createHash('sha256').update(JSON.stringify([agent.id, input.map(m => m.id)])).digest('hex');
    const endpoint = new URL(`/agents/${encodeURIComponent(options.model)}`, this.config.serviceUrl); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    let binding = this.state.get(agent.id);
    if (binding && (binding.agent !== options.model || binding.cwd !== cwd || binding.endpoint !== endpoint.href)) throw new Error('This session is bound to another ACP Agent or endpoint; start a new session');
    const seen = new Set<number>();
    const tools = new Map<string, RemoteTool>();
    const boundary = this.ctx.sessionProjections.stateOf(agent.session, 'turnBoundary');
    const stepStart = boundary?.lastStepStartSeq == null ? undefined : agent.session.eventAt(boundary.lastStepStartSeq);
    const turn = boundary?.lastTurn ?? 0;
    const step = stepStart?.type === 'step/start' ? stepStart.data.step : 0;
    let index = 0, current: 'text' | 'reasoning' | undefined, content = '', answer = '';
    const endBlock = () => { if (current) { queue.push({ type: 'block-end', index, block: { type: current, text: content } as ContentBlock }); index++; current = undefined; content = ''; } };
    const emit = (kind: 'text' | 'reasoning', text: string) => {
      if (!text) return;
      if (current !== kind) { endBlock(); current = kind; queue.push({ type: 'block-start', index, blockType: kind }); }
      content += text; if (kind === 'text') answer += text;
      queue.push(kind === 'text' ? { type: 'text-delta', index, text } : { type: 'reasoning-delta', index, text });
    };
    const update = (u: SessionUpdate) => {
      const meta = u._meta?.['1agents'] as JsonObject | undefined;
      if (meta?.turnId !== requestId) return;
      if (typeof meta.sequence !== 'number') return;
      if (seen.has(meta.sequence)) return;
      seen.add(meta.sequence);
      if ((u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'agent_thought_chunk') && u.content.type === 'text') emit(u.sessionUpdate === 'agent_message_chunk' ? 'text' : 'reasoning', u.content.text);
      else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
        const tool = mergeTool(tools.get(u.toolCallId), u);
        tools.set(u.toolCallId, tool);
        // Known stream records preserve plugin metadata across save/reload.
        // Empty text is inert; only the plugin projects it into remote Tool cards.
        endBlock();
        const block = { type: 'text' as const, text: '', acpTool: { turn, step, requestId, sequence: meta.sequence, tool } };
        queue.push({ type: 'block-start', index, blockType: 'text' });
        queue.push({ type: 'block-end', index, block });
        index++;
      }
    };
    let active: Awaited<ReturnType<typeof connect>> | undefined;
    const cancel = () => { if (binding) void active?.rpc.notify('session/cancel', { sessionId: binding.sessionId }).catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        try {
          this.output.set(agent.id, update);
          active = await this.connection(agent);
          binding = this.state.get(agent.id)!;
          signal.throwIfAborted();
          const result = await active.rpc.request('session/prompt', { sessionId: binding.sessionId, prompt: [{ type: 'text', text }],
            _meta: { '1agents': { turnManaged: true, turnId: requestId, requestId } } }, { cancellationSignal: signal });
          signal.throwIfAborted();
          const meta = result._meta?.['1agents'] as JsonObject | undefined;
          if (!answer && typeof meta?.finalAnswer === 'string') emit('text', meta.finalAnswer);
          endBlock();
          queue.push(result.stopReason === 'cancelled' ? { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'ACP turn cancelled' } } } : { type: 'finish', reason: result.stopReason === 'max_tokens' ? { kind: 'max-tokens' } : { kind: 'stop' } });
          return;
        } catch (error) {
          if (signal.aborted) { endBlock(); queue.push({ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'ACP turn cancelled' } } }); return; }
          // Only transport loss is retried. The managed request ID makes an
          // uncertain delivery idempotent; provider errors remain errors.
          if ((active && active.ws.readyState === 1) || attempt >= this.config.reconnectAttempts) throw error;
          await delay(this.config.reconnectDelayMs, undefined, { signal });
        } finally { active = undefined; }
      }
    } finally { signal.removeEventListener('abort', cancel); this.output.delete(agent.id); }
  }
}
