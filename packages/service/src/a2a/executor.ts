/** Official A2A executor with durable DSH context bindings and independent turns. */
import { createHash, randomUUID } from 'node:crypto';
import { Role, Task, TaskState, Message, type SendMessageRequest } from '@a2a-js/sdk';
import { ContentTypeNotSupportedError, RequestMalformedError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext, resolveUserScope } from '@a2a-js/sdk/server';
import type { FileA2AStore } from './store.js';
import type { A2ABackend, A2APrepareInput } from './types.js';

export interface A2AExecutionOptions {
  defaultCwd?: string;
  defaultAgentPreset?: string;
  workspaces?: Record<string, string>;
}

/** Validate application metadata before the SDK starts an execution. */
export function parseA2AInput(request: SendMessageRequest, options: A2AExecutionOptions): { prompt: string; input: A2APrepareInput } {
  const message = request.message;
  if (!message?.messageId.trim() || message.role !== Role.ROLE_USER) throw new RequestMalformedError('A user message with messageId is required');
  if (!message.parts.length || message.parts.some(part => part.content?.$case !== 'text' || (part.mediaType && part.mediaType !== 'text/plain'))) {
    throw new ContentTypeNotSupportedError('DSH A2A accepts text/plain parts');
  }
  const prompt = message.parts.map(part => part.content?.value as string).join('\n');
  if (!prompt.trim()) throw new RequestMalformedError('Prompt must contain text');
  const metadata: unknown = request.metadata?.['1agents'];
  if (metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))) throw new RequestMalformedError('metadata.1agents must be an object');
  const value = (metadata ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!['cwd', 'agentPreset', 'workspace'].includes(key)) throw new RequestMalformedError(`Unknown metadata.1agents field: ${key}`);
  for (const key of ['cwd', 'agentPreset', 'workspace']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !(value[key] as string).trim())) throw new RequestMalformedError(`${key} must be a nonempty string`);
  }
  if (value.cwd && value.workspace) throw new RequestMalformedError('Use cwd or workspace, not both');
  let cwd = value.cwd as string | undefined;
  if (value.workspace) {
    cwd = options.workspaces?.[value.workspace as string];
    if (!cwd) throw new RequestMalformedError(`Unknown workspace: ${value.workspace}`);
  }
  return { prompt, input: { cwd, agentPreset: value.agentPreset as string | undefined } };
}

/** SDK owns the execution lifetime; an HTTP disconnect never aborts this signal. */
export class A2ASessionExecutor implements AgentExecutor {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly awaitingInput = new Map<string, string>();
  private readonly preparing = new Map<string, Promise<void>>();
  private stopped = false;
  constructor(private readonly backend: A2ABackend, private readonly store: FileA2AStore, private readonly options: A2AExecutionOptions) {}

  isRunning(taskId: string): boolean { return this.active.has(taskId); }

  async execute(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
    if (this.stopped) throw new UnsupportedOperationError('A2A host is stopping');
    if (this.active.has(context.taskId)) throw new UnsupportedOperationError('This task already has an active execution');
    const controller = new AbortController();
    this.awaitingInput.delete(context.taskId);
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    this.active.set(context.taskId, { controller, done });
    let published = false;
    const status = (state: TaskState, text?: string): void => {
      bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId,
        status: { state, timestamp: new Date().toISOString(), message: text ? Message.fromJSON({
          messageId: randomUUID(), role: 'ROLE_AGENT', contextId: context.contextId, taskId: context.taskId, parts: [{ text }],
        }) : undefined }, metadata: undefined }));
    };
    try {
      const { prompt, input } = parseA2AInput(context.request, this.options);
      const key = JSON.stringify([context.context.tenant ?? '', resolveUserScope(context.context), context.contextId]);
      const previous = this.preparing.get(key) ?? Promise.resolve();
      let unlock!: () => void;
      const lock = new Promise<void>(resolve => { unlock = resolve; });
      this.preparing.set(key, lock);
      let target;
      try {
        await previous;
        controller.signal.throwIfAborted();
        const saved = this.store.loadTarget(context.contextId, context.context);
        target = await this.backend.prepare({ sessionId: saved?.sessionId,
          cwd: input.cwd ?? saved?.cwd ?? this.options.defaultCwd,
          agentPreset: input.agentPreset ?? saved?.agentPreset ?? this.options.defaultAgentPreset });
        this.store.saveTarget(context.contextId, target, context.context);
      } finally {
        unlock();
        if (this.preparing.get(key) === lock) this.preparing.delete(key);
      }
      const task = Task.fromJSON({ ...Task.toJSON(context.task ?? Task.fromJSON({ id: context.taskId, contextId: context.contextId })) as object,
        status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() },
        metadata: { ...context.task?.metadata, '1agents': target } });
      bus.publish(AgentEvent.task(task));
      published = true;
      controller.signal.throwIfAborted();
      status(TaskState.TASK_STATE_WORKING);
      // DSH deduplicates prompts by rpcId across the whole session. A Task can
      // have several input-required turns, each with its own message identity.
      const requestId = `a2a-${createHash('sha256').update(JSON.stringify([context.taskId, context.userMessage.messageId])).digest('hex')}`;
      const result = await this.backend.run(target, prompt, { requestId, signal: controller.signal });
      controller.signal.throwIfAborted();
      if (result.text) bus.publish(AgentEvent.artifactUpdate({ taskId: context.taskId, contextId: context.contextId,
        artifact: { artifactId: `${context.taskId}-${randomUUID()}`, name: 'DSH response', description: '',
          parts: [{ content: { $case: 'text', value: result.text }, mediaType: 'text/plain', filename: '', metadata: undefined }], metadata: undefined, extensions: [] },
        append: false, lastChunk: true, metadata: undefined }));
      if (result.outcome === 'input-required') this.awaitingInput.set(context.taskId, context.contextId);
      status(result.outcome === 'completed' ? TaskState.TASK_STATE_COMPLETED : result.outcome === 'input-required' ? TaskState.TASK_STATE_INPUT_REQUIRED : TaskState.TASK_STATE_FAILED, result.detail);
    } catch (error) {
      if (!published) bus.publish(AgentEvent.task(Task.fromJSON({ id: context.taskId, contextId: context.contextId,
        status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() } })));
      status(controller.signal.aborted ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED, error instanceof Error ? error.message : String(error));
    } finally {
      this.active.delete(context.taskId);
      finish();
    }
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    const execution = this.active.get(taskId);
    if (!execution) {
      const contextId = this.awaitingInput.get(taskId);
      if (!contextId) throw new UnsupportedOperationError('No active execution for this task');
      this.awaitingInput.delete(taskId);
      bus.publish(AgentEvent.statusUpdate({ taskId, contextId,
        status: { state: TaskState.TASK_STATE_CANCELED, timestamp: new Date().toISOString(), message: undefined }, metadata: undefined }));
      return;
    }
    execution.controller.abort(new Error('A2A task canceled'));
    await execution.done;
  }

  async close(): Promise<void> {
    this.stopped = true;
    for (const execution of this.active.values()) execution.controller.abort(new Error('A2A host stopped'));
    await Promise.all([...this.active.values()].map(execution => execution.done));
  }
}
