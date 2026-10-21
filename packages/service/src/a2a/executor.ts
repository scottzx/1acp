/** Official A2A executor with durable DSH context bindings and independent turns. */
import { randomUUID } from 'node:crypto';
import { Role, Task, TaskState, Message, type SendMessageRequest } from '@a2a-js/sdk';
import { ContentTypeNotSupportedError, RequestMalformedError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext, resolveUserScope } from '@a2a-js/sdk/server';
import { a2aRequestId } from './request-id.js';
import { toSafeError, type SafeError } from '@1agents/acp-service/runtime';
import type { FileA2AStore } from './store.js';
import type { A2ABackend, A2APrepareInput, A2ARunResult, A2ATarget } from './types.js';
import { A2APreflightError, a2aPreflightRequirementsSchema } from './preflight.js';
import { a2aResultContractSchema, A2AResultValidationError, createA2AResultMetadata, saveA2AResultMetadata,
  type A2AResultContract, type A2AResultMetadata } from './result-metadata.js';

const FAILURE_MESSAGES: Record<NonNullable<A2ARunResult['failureReason']>, string> = {
  'missing-final-answer': 'DSH completed the task without a final answer; ACP final-answer metadata contained no final output',
  'max-tokens': 'DSH reached the model output token limit',
  forked: 'DSH task turn was closed by a session fork',
  'unsupported-ending': 'DSH returned an unsupported turn ending',
  discarded: 'DSH discarded the queued task before execution',
  disposed: 'DSH session was disposed before the task finished',
  aborted: 'DSH task execution was canceled',
  interrupted: 'DSH task execution was interrupted',
};

export interface A2AExecutionOptions {
  defaultCwd?: string;
  defaultAgentPreset?: string;
  workspaces?: Record<string, string>;
}

/** Validate application metadata before the SDK starts an execution. */
export function parseA2AInput(request: SendMessageRequest, options: A2AExecutionOptions): {
  prompt: string; input: A2APrepareInput; resultContract?: A2AResultContract;
} {
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
  for (const key of Object.keys(value)) if (!['cwd', 'agentPreset', 'workspace', 'preflight', 'resultContract'].includes(key)) throw new RequestMalformedError(`Unknown metadata.1agents field: ${key}`);
  for (const key of ['cwd', 'agentPreset', 'workspace']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !(value[key] as string).trim())) throw new RequestMalformedError(`${key} must be a nonempty string`);
  }
  if (value.cwd && value.workspace) throw new RequestMalformedError('Use cwd or workspace, not both');
  let cwd = value.cwd as string | undefined;
  if (value.workspace) {
    cwd = options.workspaces?.[value.workspace as string];
    if (!cwd) throw new RequestMalformedError(`Unknown workspace: ${value.workspace}`);
  }
  const preflight = value.preflight === undefined ? undefined : a2aPreflightRequirementsSchema.safeParse(value.preflight);
  if (preflight && !preflight.success) throw new RequestMalformedError('Invalid preflight requirements');
  const resultContract = value.resultContract === undefined ? undefined : a2aResultContractSchema.safeParse(value.resultContract);
  if (resultContract && !resultContract.success) throw new RequestMalformedError('Invalid result contract');
  return { prompt, input: { cwd, agentPreset: value.agentPreset as string | undefined,
    ...(preflight?.success ? { preflight: preflight.data } : {}) },
    ...(resultContract?.success ? { resultContract: resultContract.data } : {}) };
}

/** SDK owns the execution lifetime; an HTTP disconnect never aborts this signal. */
export class A2ASessionExecutor implements AgentExecutor {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly awaitingInput = new Map<string, { contextId: string; target: A2ATarget; result: A2AResultMetadata }>();
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
    let target: A2ATarget | undefined;
    let returnedError: SafeError | undefined;
    let returnedFailureMessage: string | undefined;
    const startedAt = new Date().toISOString();
    let resultContract: A2AResultContract | undefined;
    let resultMetadata: A2AResultMetadata | undefined;
    // DSH deduplicates prompts by rpcId across the whole session. A Task can
    // have several input-required turns, each with its own message identity.
    const requestId = a2aRequestId(context.taskId, context.userMessage.messageId);
    const status = (state: TaskState, text?: string, error?: SafeError): void => {
      bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId,
        status: { state, timestamp: new Date().toISOString(), message: text ? Message.fromJSON({
          messageId: randomUUID(), role: 'ROLE_AGENT', contextId: context.contextId, taskId: context.taskId, parts: [{ text }],
        }) : undefined }, metadata: error || resultMetadata ? { '1agents': {
          ...target, ...(resultMetadata ? { result: resultMetadata } : {}), ...(error ? { error } : {}),
        } } : undefined }));
    };
    try {
      const parsed = parseA2AInput(context.request, this.options);
      const { prompt, input } = parsed;
      resultContract = parsed.resultContract;
      const key = JSON.stringify([context.context.tenant ?? '', resolveUserScope(context.context), context.contextId]);
      const previous = this.preparing.get(key) ?? Promise.resolve();
      let unlock!: () => void;
      const lock = new Promise<void>(resolve => { unlock = resolve; });
      this.preparing.set(key, lock);
      try {
        await previous;
        controller.signal.throwIfAborted();
        const saved = this.store.loadTarget(context.contextId, context.context);
        target = await this.backend.prepare({ sessionId: saved?.sessionId,
          cwd: input.cwd ?? saved?.cwd ?? this.options.defaultCwd,
          agentPreset: input.agentPreset ?? saved?.agentPreset ?? this.options.defaultAgentPreset,
          ...(input.preflight ? { preflight: input.preflight } : {}) });
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
      const result = await this.backend.run(target, prompt, { requestId, signal: controller.signal });
      returnedError = result.outcome === 'failed' && result.error !== undefined
        ? toSafeError(result.error, { origin: 'a2a', operationId: requestId }) : undefined;
      returnedFailureMessage = result.outcome === 'failed' && typeof result.failureReason === 'string' && Object.hasOwn(FAILURE_MESSAGES, result.failureReason)
        ? FAILURE_MESSAGES[result.failureReason] : undefined;
      controller.signal.throwIfAborted();
      // Publish the final answer first so failed artifact validation remains diagnosable.
      if (result.text) bus.publish(AgentEvent.artifactUpdate({ taskId: context.taskId, contextId: context.contextId,
        artifact: { artifactId: `${context.taskId}-${randomUUID()}`, name: 'DSH response', description: '',
          parts: [{ content: { $case: 'text', value: result.text }, mediaType: 'text/plain', filename: '', metadata: undefined }], metadata: undefined, extensions: [] },
        append: false, lastChunk: true, metadata: undefined }));
      resultMetadata = await createA2AResultMetadata({ taskId: context.taskId, contextId: context.contextId,
        requestId, startedAt, outcome: result.outcome, target, contract: resultContract });
      await saveA2AResultMetadata(resultMetadata, target);
      if (resultMetadata.artifacts.some(artifact => artifact.url)) {
        bus.publish(AgentEvent.artifactUpdate({ taskId: context.taskId, contextId: context.contextId,
          artifact: { artifactId: `${context.taskId}-verified-artifacts`, name: 'Verified artifacts', description: '',
            parts: resultMetadata.artifacts.filter(artifact => artifact.url).map(artifact => ({
              content: { $case: 'url' as const, value: artifact.url! }, mediaType: artifact.mediaType ?? 'application/octet-stream',
              filename: '', metadata: { sha256: artifact.sha256, size: artifact.size },
            })), metadata: { verifiedBy: '1agents/a2a-host' }, extensions: [] },
          append: false, lastChunk: true, metadata: undefined }));
      }
      if (result.outcome === 'input-required') this.awaitingInput.set(context.taskId, {
        contextId: context.contextId, target, result: resultMetadata,
      });
      const error = result.outcome === 'failed'
        ? toSafeError(returnedError, { origin: 'a2a', operationId: requestId }) : undefined;
      status(result.outcome === 'completed' ? TaskState.TASK_STATE_COMPLETED : result.outcome === 'input-required' ? TaskState.TASK_STATE_INPUT_REQUIRED : TaskState.TASK_STATE_FAILED, returnedFailureMessage ?? error?.message ?? result.detail, error);
    } catch (error) {
      if (!published) bus.publish(AgentEvent.task(Task.fromJSON({ id: context.taskId, contextId: context.contextId,
        status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() } })));
      const projected = controller.signal.aborted && returnedError ? returnedError : toSafeError(error, { origin: 'a2a', operationId: requestId });
      const cancellationOnly = controller.signal.aborted && !returnedError && error === controller.signal.reason;
      const safe = toSafeError(cancellationOnly ? new DOMException('A2A task canceled', 'AbortError') : projected, {
        origin: 'a2a', operationId: requestId, outcomeUnknown: projected.outcomeUnknown,
      });
      resultMetadata = await createA2AResultMetadata({ taskId: context.taskId, contextId: context.contextId,
        requestId, startedAt, outcome: controller.signal.aborted ? 'canceled' : 'failed', target, contract: resultContract,
        validationCode: error instanceof A2AResultValidationError ? error.code : undefined,
        ...(error instanceof A2APreflightError ? { preflight: error.report } : {}) });
      try { await saveA2AResultMetadata(resultMetadata, target); }
      catch { resultMetadata.validation = { status: 'failed', code: 'result-record-write-failed' }; delete resultMetadata.recordPath; }
      status(controller.signal.aborted ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED, returnedFailureMessage ?? safe.message, safe);
    } finally {
      this.active.delete(context.taskId);
      finish();
    }
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    const execution = this.active.get(taskId);
    if (!execution) {
      const pending = this.awaitingInput.get(taskId);
      if (!pending) throw new UnsupportedOperationError('No active execution for this task');
      this.awaitingInput.delete(taskId);
      const result: A2AResultMetadata = { ...pending.result, finishedAt: new Date().toISOString(), outcome: 'canceled' };
      try { await saveA2AResultMetadata(result, pending.target); }
      catch { result.validation = { status: 'failed', code: 'result-record-write-failed' }; delete result.recordPath; }
      bus.publish(AgentEvent.statusUpdate({ taskId, contextId: pending.contextId,
        status: { state: TaskState.TASK_STATE_CANCELED, timestamp: result.finishedAt, message: undefined },
        metadata: { '1agents': { ...pending.target, result } } }));
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
