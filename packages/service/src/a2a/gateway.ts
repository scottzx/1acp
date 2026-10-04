/** Main-agent tools backed by standard A2A, with a durable completion inbox. */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { CancelTaskRequest, GetTaskRequest, SendMessageRequest, Task } from '@a2a-js/sdk';
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory, type Client } from '@a2a-js/sdk/client';
import { reportAndHoldRegistration } from '@1agents/dreammate-node/client';
import { z } from 'zod';
import { FileA2AStore } from './store.js';

const string = z.string().trim().min(1).max(512);
const endpoint = z.string().url().refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
}, 'Expected an HTTP(S) URL without embedded credentials');
const configSchema = z.object({
  stateDirectory: string,
  port: z.number().int().min(0).max(65535).default(36814),
  remotes: z.record(string, z.object({ url: endpoint, token: string }).strict()),
  callback: z.object({ host: string, port: z.number().int().min(0).max(65535), url: endpoint, token: string }).strict().optional(),
  notificationTargets: z.record(string, z.object({ url: endpoint, token: string }).strict()).default({}),
  pollIntervalMs: z.number().int().min(50).max(60_000).default(3000),
}).strict();
export type A2AGatewayConfig = z.input<typeof configSchema>;
type Config = z.output<typeof configSchema>;

const originFields = { originSessionId: string };
const taskFields = { ...originFields, remote: string, taskId: string };
const prompt = z.string().min(1).max(256 * 1024).refine(value => Boolean(value.trim()), 'Prompt must contain text');
const spawnSchema = z.object({ ...originFields, remote: string, prompt,
  cwd: string.refine(value => path.posix.isAbsolute(value), 'cwd must be an absolute remote path'),
  agentPreset: string.optional(), notificationTarget: string.optional(), title: string.optional(),
}).strict();
const taskSchema = z.object(taskFields).strict();
const messageSchema = z.object({ ...taskFields, prompt }).strict();
const inboxSchema = z.object(originFields).strict();
const ackSchema = z.object({ ...originFields, noticeId: string }).strict();

export const REMOTE_AGENT_METHODS = {
  remote_agent_spawn: { description: '在配置的远端 DSH 工作目录中派发独立任务，立即返回 taskId。prompt 必须包含完整上下文。cwd 是远端绝对路径；每次 spawn 创建新会话。完成事件进入 originSessionId 的持久收件箱。', parameters: z.toJSONSchema(spawnSchema) },
  remote_agent_get: { description: '查询当前主会话派发的远端任务。离线时返回缓存与 stale 标记，离线不等于任务失败。', parameters: z.toJSONSchema(taskSchema) },
  remote_agent_cancel: { description: '取消指定远端任务，只取消这项任务自己的执行。', parameters: z.toJSONSchema(taskSchema) },
  remote_agent_message: { description: '向同一个远端 DSH 会话发送后续指令，返回新 taskId，复用 contextId 与 cwd。', parameters: z.toJSONSchema(messageSchema) },
  remote_agent_list: { description: '列出当前主会话派发的远端任务。', parameters: z.toJSONSchema(inboxSchema) },
  remote_agent_inbox: { description: '读取当前主会话未确认的完成或需要输入通知。读取不删除；处理后调用 remote_agent_ack。', parameters: z.toJSONSchema(inboxSchema) },
  remote_agent_ack: { description: '确认主会话已处理指定通知。noticeId 稳定，重复确认安全。', parameters: z.toJSONSchema(ackSchema) },
};

interface Job {
  remote: string;
  originSessionId: string;
  taskId: string;
  contextId: string;
  cwd: string;
  agentPreset?: string;
  title?: string;
  notificationTarget?: string;
  task: unknown;
  checkedAt: string;
  stale?: boolean;
}
export interface RemoteAgentNotice {
  noticeId: string;
  originSessionId: string;
  remote: string;
  taskId: string;
  contextId: string;
  cwd: string;
  agentPreset?: string;
  title?: string;
  state: string;
  result: string;
  createdAt: string;
}
interface NoticeRecord { notice: RemoteAgentNotice; target?: string; acknowledged?: boolean; delivered?: boolean }
interface State { version: 1; jobs: Job[]; notices: NoticeRecord[] }
const terminal = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED']);
const actionable = new Set([...terminal, 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED']);
const wire = (task: Task): Record<string, any> => Task.toJSON(task) as Record<string, any>;
const taskState = (job: Job): string => wire(Task.fromJSON(job.task)).status?.state ?? 'TASK_STATE_UNSPECIFIED';
const resultText = (task: Task): string => task.artifacts.flatMap(artifact => artifact.parts
  .filter(part => part.content?.$case === 'text').map(part => part.content!.value)).join('\n') ||
  task.status?.message?.parts.filter(part => part.content?.$case === 'text').map(part => part.content!.value).join('\n') || '';

function atomicJson(file: string, value: unknown): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
  const dir = openSync(path.dirname(file), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

export class RemoteAgentGateway {
  readonly config: Config;
  private readonly lease: FileA2AStore;
  private readonly stateFile: string;
  private readonly state: State;
  private readonly clients = new Map<string, Promise<Client>>();
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly delivering = new Set<string>();
  private readonly controllers = new Set<AbortController>();
  private readonly operations = new Set<Promise<unknown>>();
  private reconciling?: Promise<void>;
  private readonly timer: NodeJS.Timeout;
  private closed = false;

  constructor(input: A2AGatewayConfig) {
    this.config = configSchema.parse(input);
    if (!path.isAbsolute(this.config.stateDirectory)) throw new Error('stateDirectory must be absolute');
    mkdirSync(this.config.stateDirectory, { recursive: true, mode: 0o700 });
    // Reuse the A2A store's tested single-owner lease, in a separate empty
    // directory: local restarts must never mark remote executions failed.
    this.lease = new FileA2AStore(path.join(this.config.stateDirectory, 'lease'));
    this.stateFile = path.join(this.config.stateDirectory, 'gateway.json');
    try {
      this.state = JSON.parse(readFileSync(this.stateFile, 'utf8')) as State;
      if (this.state.version !== 1 || !Array.isArray(this.state.jobs) || !Array.isArray(this.state.notices)) throw new Error('Invalid gateway state');
      for (const job of this.state.jobs) {
        string.parse(job.originSessionId); string.parse(job.remote); string.parse(job.taskId);
        if (Task.fromJSON(job.task).id !== job.taskId) throw new Error('Invalid gateway task ID');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.lease.close(); throw error; }
      this.state = { version: 1, jobs: [], notices: [] };
    }
    this.timer = setInterval(() => { void this.reconcile(); }, this.config.pollIntervalMs);
    this.timer.unref();
    void this.reconcile();
  }

  private save(): void { atomicJson(this.stateFile, this.state); }
  private client(remote: string): Promise<Client> {
    const config = this.config.remotes[remote];
    if (!config) throw new Error(`Unknown remote: ${remote}`);
    let pending = this.clients.get(remote);
    if (!pending) {
      const fetchImpl: typeof fetch = async (input, init) => {
        if (this.closed) throw new Error('Gateway is closed');
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== new URL(config.url).origin) throw new Error('Agent Card endpoint must use the configured remote origin');
        const controller = new AbortController();
        this.controllers.add(controller);
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000), ...(init?.signal ? [init.signal] : [])]);
        try { return await fetch(input, { ...init, signal, redirect: 'error' }); }
        finally { this.controllers.delete(controller); }
      };
      pending = new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })],
        cardResolver: new DefaultAgentCardResolver({ fetchImpl }), clientConfig: { polling: true } }).createFromUrl(config.url);
      this.clients.set(remote, pending);
      void pending.catch(() => { if (this.clients.get(remote) === pending) this.clients.delete(remote); });
    }
    return pending;
  }
  private auth(remote: string) { return { serviceParameters: { Authorization: `Bearer ${this.config.remotes[remote]!.token}` } }; }
  private job(params: z.output<typeof taskSchema>): Job {
    const job = this.state.jobs.find(value => value.remote === params.remote && value.taskId === params.taskId && value.originSessionId === params.originSessionId);
    if (!job) throw new Error('Task not found for this origin session');
    return job;
  }
  private view(job: Job) {
    const task = Task.fromJSON(job.task);
    return { remote: job.remote, taskId: job.taskId, contextId: job.contextId, originSessionId: job.originSessionId,
      cwd: job.cwd, agentPreset: job.agentPreset, sessionId: task.metadata?.['1agents']?.sessionId,
      state: taskState(job), result: resultText(task), checkedAt: job.checkedAt, stale: Boolean(job.stale) };
  }
  private accept(task: Task, fields: Omit<Job, 'task' | 'taskId' | 'contextId' | 'checkedAt'>): Job {
    const target = task.metadata?.['1agents'] as Record<string, unknown> | undefined;
    const job: Job = { ...fields, taskId: task.id, contextId: task.contextId, task: wire(task), checkedAt: new Date().toISOString(),
      cwd: typeof target?.cwd === 'string' ? target.cwd : fields.cwd,
      agentPreset: typeof target?.agentPreset === 'string' ? target.agentPreset : fields.agentPreset };
    this.state.jobs.push(job);
    this.update(job, task);
    return job;
  }
  private update(job: Job, task: Task): void {
    if (task.id !== job.taskId || task.contextId !== job.contextId) throw new Error('Remote returned a different task');
    const previous = Task.fromJSON(job.task);
    if ((terminal.has(taskState(job)) && !terminal.has(wire(task).status?.state)) ||
      Date.parse(previous.status?.timestamp ?? '') > Date.parse(task.status?.timestamp ?? '')) return;
    job.task = wire(task); job.checkedAt = new Date().toISOString(); job.stale = false;
    const state = taskState(job);
    if (actionable.has(state)) {
      const noticeId = createHash('sha256').update(JSON.stringify([job.remote, job.taskId, state, task.status?.timestamp])).digest('hex');
      if (!this.state.notices.some(value => value.notice.noticeId === noticeId)) this.state.notices.push({ target: job.notificationTarget,
        notice: { noticeId, originSessionId: job.originSessionId, remote: job.remote, taskId: job.taskId, contextId: job.contextId,
          cwd: job.cwd, agentPreset: job.agentPreset, title: job.title, state, result: resultText(task), createdAt: new Date().toISOString() } });
    }
    this.save();
  }
  private async refresh(job: Job): Promise<void> {
    const key = `${job.remote}:${job.taskId}`;
    const previous = this.refreshing.get(key);
    if (previous) return previous;
    const pending = (async () => {
      try { const client = await this.client(job.remote); this.update(job, await client.getTask(GetTaskRequest.fromJSON({ id: job.taskId }), this.auth(job.remote))); }
      catch { job.stale = true; this.save(); }
    })();
    this.refreshing.set(key, pending);
    try { await pending; } finally { this.refreshing.delete(key); }
  }
  async reconcile(): Promise<void> {
    if (this.closed) return;
    if (this.reconciling) return this.reconciling;
    const pending = (async () => {
      await Promise.allSettled(this.state.jobs.filter(job => !terminal.has(taskState(job))).map(job => this.refresh(job)));
      if (this.closed) return;
      await Promise.allSettled(this.state.notices.filter(record => record.target && !record.delivered && !record.acknowledged).map(record => this.deliver(record)));
    })();
    this.reconciling = pending;
    try { await pending; } finally { this.reconciling = undefined; }
  }
  private async deliver(record: NoticeRecord): Promise<void> {
    const id = record.notice.noticeId;
    const target = this.config.notificationTargets[record.target!];
    if (!target || this.delivering.has(id)) return;
    this.delivering.add(id);
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      const response = await fetch(target.url, { method: 'POST', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.token}`, 'Idempotency-Key': id }, body: JSON.stringify(record.notice) });
      await response.body?.cancel();
      if (response.ok) { record.delivered = true; this.save(); }
    } catch { /* Durable outbox retries on the next tick, with the same ID. */ }
    finally { this.controllers.delete(controller); this.delivering.delete(id); }
  }
  async invoke(method: string, params: unknown): Promise<unknown> {
    if (this.closed) throw new Error('Gateway is closed');
    const operation = this.invokeMethod(method, params);
    this.operations.add(operation);
    try { return await operation; } finally { this.operations.delete(operation); }
  }
  private async invokeMethod(method: string, params: unknown): Promise<unknown> {
    if (method === 'remote_agent_spawn') {
      const input = spawnSchema.parse(params);
      if (input.notificationTarget && !this.config.notificationTargets[input.notificationTarget]) throw new Error('Unknown notificationTarget');
      const client = await this.client(input.remote);
      const task = await client.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: input.prompt }] },
        metadata: { '1agents': { cwd: input.cwd, ...(input.agentPreset ? { agentPreset: input.agentPreset } : {}) } },
        configuration: { returnImmediately: true, ...(this.config.callback ? { taskPushNotificationConfig: { url: this.config.callback.url,
          authentication: { scheme: 'Bearer', credentials: this.config.callback.token } } } : {}) } }), this.auth(input.remote));
      if (!('id' in task)) throw new Error('Remote did not return an A2A Task');
      return this.view(this.accept(task, { remote: input.remote, originSessionId: input.originSessionId, cwd: input.cwd, agentPreset: input.agentPreset, title: input.title, notificationTarget: input.notificationTarget }));
    }
    if (method === 'remote_agent_get' || method === 'remote_agent_cancel') {
      const job = this.job(taskSchema.parse(params));
      if (method === 'remote_agent_cancel') {
        const client = await this.client(job.remote);
        this.update(job, await client.cancelTask(CancelTaskRequest.fromJSON({ id: job.taskId }), this.auth(job.remote)));
      } else await this.refresh(job);
      return this.view(job);
    }
    if (method === 'remote_agent_message') {
      const input = messageSchema.parse(params), previous = this.job(input);
      const client = await this.client(input.remote);
      const task = await client.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), role: 'ROLE_USER', contextId: previous.contextId, parts: [{ text: input.prompt }] },
        configuration: { returnImmediately: true, ...(this.config.callback ? { taskPushNotificationConfig: { url: this.config.callback.url,
          authentication: { scheme: 'Bearer', credentials: this.config.callback.token } } } : {}) } }), this.auth(input.remote));
      if (!('id' in task)) throw new Error('Remote did not return an A2A Task');
      return this.view(this.accept(task, { remote: previous.remote, originSessionId: previous.originSessionId, cwd: previous.cwd, agentPreset: previous.agentPreset,
        title: previous.title, notificationTarget: previous.notificationTarget }));
    }
    if (method === 'remote_agent_list' || method === 'remote_agent_inbox') {
      const { originSessionId } = inboxSchema.parse(params);
      return method === 'remote_agent_list' ? { tasks: this.state.jobs.filter(job => job.originSessionId === originSessionId).map(job => this.view(job)) } :
        { notices: this.state.notices.filter(record => record.notice.originSessionId === originSessionId && !record.acknowledged).map(record => record.notice) };
    }
    if (method === 'remote_agent_ack') {
      const input = ackSchema.parse(params);
      const notice = this.state.notices.find(record => record.notice.originSessionId === input.originSessionId && record.notice.noticeId === input.noticeId);
      if (!notice) throw new Error('Notice not found for this origin session');
      notice.acknowledged = true; this.save(); return { acknowledged: true, noticeId: input.noticeId };
    }
    throw new Error(`Unknown method: ${method}`);
  }
  /** Push events are hints. GetTask remains authoritative, including after missed callbacks. */
  async receivePush(event: unknown): Promise<void> {
    const value = z.object({ task: z.object({ id: string }).passthrough().optional(), statusUpdate: z.object({ taskId: string }).passthrough().optional(),
      artifactUpdate: z.object({ taskId: string }).passthrough().optional() }).passthrough().parse(event);
    const taskId = value.task?.id ?? value.statusUpdate?.taskId ?? value.artifactUpdate?.taskId;
    if (!taskId) throw new Error('Missing A2A event task ID');
    await Promise.allSettled(this.state.jobs.filter(job => job.taskId === taskId).map(job => this.refresh(job)));
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer);
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.refreshing.values(), ...this.operations, ...(this.reconciling ? [this.reconciling] : [])]);
    // Delivery promises release their controllers after abort; HTTP requests
    // may have already succeeded, so any retry keeps the stable notice ID.
    this.lease.close();
  }
}

async function body(req: IncomingMessage): Promise<unknown> {
  let length = 0; const chunks: Buffer[] = [];
  for await (const data of req) {
    length += data.length;
    if (length > 1024 * 1024) throw new Error('Request body too large');
    chunks.push(Buffer.from(data));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data));
}
function authenticated(req: IncomingMessage, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`), supplied = Buffer.from(req.headers.authorization ?? '');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function listen(server: http.Server, port: number, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return (server.address() as AddressInfo).port;
}
async function stop(server: http.Server): Promise<void> {
  server.closeIdleConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
export async function serveA2AGateway(input: A2AGatewayConfig, options: { report?: boolean } = {}) {
  const gateway = new RemoteAgentGateway(input);
  const server = http.createServer((req, res) => { void (async () => {
    try {
      if (req.method === 'GET' && req.url === '/health') return json(res, 200, { status: 'ok', service: 'a2a-gateway', remotes: Object.keys(gateway.config.remotes) });
      if (req.method !== 'POST' || req.url !== '/invoke') return json(res, 404, { error: 'No route' });
      // Local tools are trusted. The separate tailnet receiver below never exposes /invoke.
      if (req.headers.origin) return json(res, 403, { error: 'Browser-origin invocation is not allowed' });
      const request = z.object({ method: string.optional(), capability: string.optional(), params: z.unknown() }).parse(await body(req));
      return json(res, 200, await gateway.invoke(request.method ?? request.capability ?? '', request.params));
    } catch (error) { json(res, 400, { error: error instanceof z.ZodError ? 'Invalid method parameters' : error instanceof Error ? error.message : 'Invocation failed' }); }
  })(); });
  let receiver: http.Server | undefined;
  let callbackPort: number | undefined;
  try {
    const port = await listen(server, gateway.config.port, '127.0.0.1');
    if (gateway.config.callback) {
      const callback = gateway.config.callback;
      receiver = http.createServer((req, res) => { void (async () => {
        if (!authenticated(req, callback.token)) return json(res, 401, { error: 'Unauthorized' });
        if (req.method !== 'POST' || req.url !== new URL(callback.url).pathname) return json(res, 404, { error: 'No route' });
        try { const event = await body(req); json(res, 202, { accepted: true }); void gateway.receivePush(event).catch(() => {}); }
        catch { json(res, 400, { error: 'Invalid A2A event' }); }
      })(); });
      callbackPort = await listen(receiver, callback.port, callback.host);
    }
    const entry = { id: 'a2a-gateway', name: 'DSH 远端智能体', kind: 'agent_runtime' as const,
      capabilities: Object.keys(REMOTE_AGENT_METHODS), execution: 'http', port, reachability: 'localhost' as const, health: '/health', methods: REMOTE_AGENT_METHODS };
    const registration = options.report === false ? undefined : await reportAndHoldRegistration(entry);
    let stopped = false;
    return { gateway, port, callbackPort, registration, close: async () => {
      if (stopped) return; stopped = true;
      await gateway.close(); await Promise.all([stop(server), ...(receiver ? [stop(receiver)] : [])]);
    } };
  } catch (error) { await gateway.close(); await Promise.all([stop(server), ...(receiver ? [stop(receiver)] : [])]); throw error; }
}
