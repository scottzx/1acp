/** Durable scheduled occurrences and business-processing claims over the existing gateway. */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import type { RemoteAgentGateway, RemoteAgentNotice } from './gateway.js';

const identifier = z.string().trim().min(1).max(512);
export const automationConfigSchema = z.object({
  host: identifier.default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(36815),
  token: identifier,
  schedules: z.record(identifier, z.object({
    remote: identifier,
    cwd: identifier.refine(value => path.posix.isAbsolute(value), 'cwd must be an absolute remote path'),
    agentPreset: identifier.optional(),
    notificationTarget: identifier.optional(),
  }).strict()),
  processingLeaseMs: z.number().int().min(1).max(24 * 60 * 60 * 1000).default(300_000),
}).strict();
export type A2AAutomationConfig = z.input<typeof automationConfigSchema>;
type Config = z.output<typeof automationConfigSchema>;

const submitSchema = z.object({
  scheduleId: identifier,
  scheduledFor: z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString()),
  flowRunId: identifier.optional(),
  prompt: z.string().min(1).max(256 * 1024).refine(value => Boolean(value.trim()), 'Prompt must contain text'),
  businessRef: identifier.optional(),
}).strict();
const processorSchema = z.object({ originSessionId: identifier, processorId: identifier }).strict();
const taskViewSchema = z.object({
  remote: identifier, originSessionId: identifier, taskId: identifier, contextId: identifier,
  state: identifier, result: z.string(), checkedAt: z.string(), stale: z.boolean(),
  sessionId: z.string().optional(),
}).passthrough();
type TaskView = z.output<typeof taskViewSchema>;
export type AutomationRunStatus = 'dispatching' | 'submitted' | 'submission_unknown' | 'skipped' | 'completed' | 'failed' | 'canceled' | 'rejected' | 'input_required' | 'auth_required';
export interface AutomationRun {
  runId: string;
  occurrenceKey: string;
  originSessionId: string;
  scheduleId: string;
  scheduledFor: string;
  flowRunId?: string;
  businessRef?: string;
  prompt: string;
  remote: string;
  cwd: string;
  agentPreset?: string;
  notificationTarget?: string;
  status: AutomationRunStatus;
  reason?: 'schedule_busy' | 'submission_unconfirmed' | 'ambiguous_submission';
  blockedBy?: string;
  taskId?: string;
  contextId?: string;
  sessionId?: string;
  state?: string;
  result?: string;
  checkedAt?: string;
  stale?: boolean;
  createdAt: string;
  updatedAt: string;
}
interface ProcessingRecord {
  noticeId: string;
  originSessionId: string;
  runId: string;
  notice: RemoteAgentNotice;
  processorId: string;
  leaseUntil: string;
  businessCompletedAt?: string;
  gatewayAcknowledgedAt?: string;
}
interface State { version: 1; runs: AutomationRun[]; notices: ProcessingRecord[] }
const active = new Set<AutomationRunStatus>(['dispatching', 'submitted', 'submission_unknown', 'input_required', 'auth_required']);
const statuses: Record<string, AutomationRunStatus> = {
  TASK_STATE_COMPLETED: 'completed', TASK_STATE_FAILED: 'failed', TASK_STATE_CANCELED: 'canceled',
  TASK_STATE_REJECTED: 'rejected', TASK_STATE_INPUT_REQUIRED: 'input_required', TASK_STATE_AUTH_REQUIRED: 'auth_required',
};
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function atomicJson(file: string, state: State): void {
  const temp = `${file}.${randomUUID()}.tmp`, fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
  const directory = openSync(path.dirname(file), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/** The gateway owns remote polling and delivery; this ledger owns occurrence admission and business acknowledgement. */
export class A2AAutomation {
  private readonly file: string;
  private readonly state: State;
  private readonly admissions = new Map<string, Promise<unknown>>();

  constructor(private readonly gateway: RemoteAgentGateway, readonly config: Config) {
    this.file = path.join(gateway.config.stateDirectory, 'automation.json');
    try {
      this.state = JSON.parse(readFileSync(this.file, 'utf8')) as State;
      if (this.state.version !== 1 || !Array.isArray(this.state.runs) || !Array.isArray(this.state.notices)) throw new Error('Invalid automation state');
      const runIds = new Set<string>(), occurrences = new Set<string>();
      for (const run of this.state.runs) {
        identifier.parse(run.runId); identifier.parse(run.remote);
        identifier.refine(value => path.posix.isAbsolute(value)).parse(run.cwd);
        const input = submitSchema.parse({ scheduleId: run.scheduleId, scheduledFor: run.scheduledFor,
          flowRunId: run.flowRunId, prompt: run.prompt, businessRef: run.businessRef });
        const key = createHash('sha256').update(JSON.stringify([input.scheduleId, input.scheduledFor])).digest('hex');
        if (run.occurrenceKey !== key || run.scheduledFor !== input.scheduledFor ||
          !['dispatching', 'submitted', 'submission_unknown', 'skipped', 'completed', 'failed', 'canceled', 'rejected', 'input_required', 'auth_required'].includes(run.status) ||
          run.originSessionId !== `automation:${run.runId}` || runIds.has(run.runId) || occurrences.has(run.occurrenceKey)) throw new Error('Invalid automation occurrence');
        runIds.add(run.runId); occurrences.add(run.occurrenceKey);
      }
      const noticeIds = new Set<string>();
      for (const record of this.state.notices) {
        identifier.parse(record.noticeId); identifier.parse(record.processorId);
        z.string().datetime().parse(record.leaseUntil);
        if (record.businessCompletedAt) z.string().datetime().parse(record.businessCompletedAt);
        if (record.gatewayAcknowledgedAt) z.string().datetime().parse(record.gatewayAcknowledgedAt);
        const run = this.state.runs.find(value => value.runId === record.runId);
        if (!run || run.originSessionId !== record.originSessionId || noticeIds.has(record.noticeId) ||
          record.notice.noticeId !== record.noticeId || record.notice.originSessionId !== record.originSessionId ||
          record.notice.remote !== run.remote || record.notice.taskId !== run.taskId || (record.gatewayAcknowledgedAt && !record.businessCompletedAt)) throw new Error('Invalid automation processing record');
        noticeIds.add(record.noticeId);
      }
      // A crash may occur after remote acceptance and before either local ledger is saved.
      // Preserve that uncertainty and never turn recovery into a second SendMessage.
      let changed = false;
      for (const run of this.state.runs) if (run.status === 'dispatching') {
        run.status = 'submission_unknown'; run.reason = 'submission_unconfirmed'; run.updatedAt = new Date().toISOString(); changed = true;
      }
      if (changed) this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = { version: 1, runs: [], notices: [] };
    }
  }
  private save(): void { atomicJson(this.file, this.state); }
  private run(runId: string): AutomationRun {
    const run = this.state.runs.find(value => value.runId === runId);
    if (!run) throw new HttpError(404, 'Run not found');
    return run;
  }
  private apply(run: AutomationRun, task: TaskView): void {
    if (task.originSessionId !== run.originSessionId || task.remote !== run.remote || (run.taskId && task.taskId !== run.taskId)) throw new Error('Gateway task does not match automation run');
    const status = statuses[task.state] ?? 'submitted';
    if (!active.has(run.status) && run.status !== 'skipped' && active.has(status)) return;
    Object.assign(run, { taskId: task.taskId, contextId: task.contextId, sessionId: task.sessionId,
      state: task.state, result: task.result, checkedAt: task.checkedAt, stale: task.stale,
      status, updatedAt: new Date().toISOString() });
    delete run.reason;
    this.save();
  }
  private async refresh(run: AutomationRun): Promise<void> {
    if (run.status === 'skipped' || run.status === 'dispatching') return;
    if (!run.taskId) {
      const response = await this.gateway.invoke('remote_agent_list', { originSessionId: run.originSessionId }) as { tasks: unknown[] };
      const tasks = response.tasks.map(value => taskViewSchema.parse(value)).filter(value => value.remote === run.remote);
      if (tasks.length === 1) this.apply(run, tasks[0]!);
      else if (tasks.length > 1) { run.status = 'submission_unknown'; run.reason = 'ambiguous_submission'; this.save(); }
    }
    if (run.taskId) this.apply(run, taskViewSchema.parse(await this.gateway.invoke('remote_agent_get', {
      originSessionId: run.originSessionId, remote: run.remote, taskId: run.taskId,
    })));
  }
  async submit(params: unknown): Promise<{ run: AutomationRun; created: boolean }> {
    const input = submitSchema.parse(params);
    if (!Object.hasOwn(this.config.schedules, input.scheduleId)) throw new HttpError(404, 'Unknown schedule');
    const schedule = this.config.schedules[input.scheduleId]!;
    const occurrenceKey = createHash('sha256').update(JSON.stringify([input.scheduleId, input.scheduledFor])).digest('hex');
    const duplicate = this.state.runs.find(value => value.occurrenceKey === occurrenceKey);
    if (duplicate) { await this.refresh(duplicate); return { run: duplicate, created: false }; }
    const previous = this.admissions.get(input.scheduleId) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const existing = this.state.runs.find(value => value.occurrenceKey === occurrenceKey);
      if (existing) { await this.refresh(existing); return { run: existing, created: false }; }
      // Refresh under the same admission queue: terminal gateway state can release a schedule
      // even if its notification has not yet been processed by Activepieces.
      for (const value of this.state.runs.filter(value => value.scheduleId === input.scheduleId && active.has(value.status))) await this.refresh(value);
      const busy = this.state.runs.find(value => value.scheduleId === input.scheduleId && active.has(value.status));
      const runId = randomUUID(), timestamp = new Date().toISOString();
      const run: AutomationRun = { ...input, ...schedule, runId, occurrenceKey, originSessionId: `automation:${runId}`,
        status: busy ? 'skipped' : 'dispatching', ...(busy ? { reason: 'schedule_busy', blockedBy: busy.runId } : {}), createdAt: timestamp, updatedAt: timestamp };
      this.state.runs.push(run);
      // Synchronous write and fsync happen before the first remote operation.
      this.save();
      if (!busy) {
        try {
          this.apply(run, taskViewSchema.parse(await this.gateway.invoke('remote_agent_spawn', {
            ...schedule, originSessionId: run.originSessionId, prompt: input.prompt,
            title: `${input.scheduleId} @ ${input.scheduledFor}`.slice(0, 512),
          })));
        } catch {
          run.status = 'submission_unknown'; run.reason = 'submission_unconfirmed'; run.updatedAt = new Date().toISOString(); this.save();
        }
      }
      return { run, created: true };
    });
    this.admissions.set(input.scheduleId, pending);
    try { return await pending; } finally { if (this.admissions.get(input.scheduleId) === pending) this.admissions.delete(input.scheduleId); }
  }
  async list(limit: number): Promise<{ runs: AutomationRun[] }> {
    const runs = this.state.runs.slice(-limit).reverse();
    await Promise.all(runs.map(run => this.refresh(run)));
    return { runs };
  }
  async get(runId: string): Promise<{ run: AutomationRun }> {
    const run = this.run(runId); await this.refresh(run); return { run };
  }
  async cancel(runId: string): Promise<{ run: AutomationRun }> {
    const run = this.run(runId); await this.refresh(run);
    if (!run.taskId) throw new HttpError(409, 'Run has no confirmed remote task to cancel');
    this.apply(run, taskViewSchema.parse(await this.gateway.invoke('remote_agent_cancel', {
      originSessionId: run.originSessionId, remote: run.remote, taskId: run.taskId,
    })));
    return { run };
  }
  private async knownNotice(noticeId: string, originSessionId: string): Promise<{ run: AutomationRun; notice: RemoteAgentNotice }> {
    const run = this.state.runs.find(value => value.originSessionId === originSessionId);
    if (!run) throw new HttpError(404, 'Notice not found');
    const response = await this.gateway.invoke('remote_agent_inbox', { originSessionId }) as { notices: RemoteAgentNotice[] };
    const notice = response.notices.find(value => value.noticeId === noticeId && value.remote === run.remote && (!run.taskId || value.taskId === run.taskId));
    if (!notice) throw new HttpError(404, 'Notice not found');
    // A notice can arrive before the submit HTTP response. Adopt the gateway task using the
    // origin correlation first, without accepting untrusted task IDs from a webhook body.
    this.apply(run, { remote: notice.remote, originSessionId, taskId: notice.taskId, contextId: notice.contextId,
      state: notice.state, result: notice.result, checkedAt: notice.createdAt, stale: false });
    return { run, notice };
  }
  async claim(noticeId: string, params: unknown) {
    const input = processorSchema.parse(params);
    const completed = this.state.notices.find(value => value.noticeId === noticeId && value.originSessionId === input.originSessionId && value.businessCompletedAt);
    if (completed) return { claimed: false, runId: completed.runId, reason: 'acknowledged' };
    const { run, notice } = await this.knownNotice(noticeId, input.originSessionId);
    let record = this.state.notices.find(value => value.noticeId === noticeId);
    if (record?.businessCompletedAt) return { claimed: false, runId: run.runId, reason: 'acknowledged' };
    if (record && record.processorId !== input.processorId && Date.parse(record.leaseUntil) > Date.now()) return { claimed: false, runId: run.runId, reason: 'processing', leaseUntil: record.leaseUntil };
    const leaseUntil = new Date(Date.now() + this.config.processingLeaseMs).toISOString();
    if (record) Object.assign(record, { processorId: input.processorId, leaseUntil });
    else { record = { noticeId, originSessionId: input.originSessionId, runId: run.runId, notice, processorId: input.processorId, leaseUntil }; this.state.notices.push(record); }
    this.save();
    return { claimed: true, runId: run.runId, notice, leaseUntil };
  }
  async ack(noticeId: string, params: unknown) {
    const input = processorSchema.parse(params);
    const record = this.state.notices.find(value => value.noticeId === noticeId && value.originSessionId === input.originSessionId);
    if (!record || record.processorId !== input.processorId) throw new HttpError(409, 'Notice must be claimed by this processor');
    if (!record.businessCompletedAt) {
      if (Date.parse(record.leaseUntil) <= Date.now()) throw new HttpError(409, 'Processing claim expired');
      await this.knownNotice(noticeId, input.originSessionId);
      // Recheck after the await: another processor may have acquired an expired lease.
      if (record.processorId !== input.processorId || Date.parse(record.leaseUntil) <= Date.now()) throw new HttpError(409, 'Processing claim expired');
      record.businessCompletedAt = new Date().toISOString();
    }
    // Retry this write even if an earlier attempt failed after the in-memory mutation.
    // Gateway acknowledgement is safe only after business completion is on disk.
    this.save();
    if (!record.gatewayAcknowledgedAt) {
      try { await this.gateway.invoke('remote_agent_ack', { originSessionId: input.originSessionId, noticeId }); }
      catch { throw new HttpError(503, 'Business completion saved; retry acknowledgement'); }
      record.gatewayAcknowledgedAt = new Date().toISOString(); this.save();
    }
    return { acknowledged: true, runId: record.runId, noticeId };
  }
  /** Retry only local inbox acknowledgement after durable business completion, never business effects. */
  async reconcileAcknowledgements(): Promise<void> {
    for (const record of this.state.notices.filter(value => value.businessCompletedAt && !value.gatewayAcknowledgedAt)) {
      try {
        this.save();
        await this.gateway.invoke('remote_agent_ack', { originSessionId: record.originSessionId, noticeId: record.noticeId });
        record.gatewayAcknowledgedAt = new Date().toISOString(); this.save();
      } catch { /* Keep the completion record; the gateway's existing reconcile tick will retry. */ }
    }
  }
}

async function body(req: IncomingMessage): Promise<unknown> {
  if (Number(req.headers['content-length']) > 1024 * 1024) throw new HttpError(413, 'Request body too large');
  const chunks: Buffer[] = []; let length = 0;
  for await (const data of req.iterator({ destroyOnReturn: false })) {
    length += data.length;
    if (length > 1024 * 1024) throw new HttpError(413, 'Request body too large');
    chunks.push(Buffer.from(data));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON body'); }
}
function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data));
}
export function createAutomationServer(automation: A2AAutomation): http.Server {
  return http.createServer((req, res) => { void (async () => {
    try {
      const expected = Buffer.from(`Bearer ${automation.config.token}`), supplied = Buffer.from(req.headers.authorization ?? '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new HttpError(401, 'Unauthorized');
      if (req.headers.origin !== undefined) throw new HttpError(403, 'Browser-origin invocation is not allowed');
      const url = new URL(req.url ?? '/', 'http://automation.local'), pathname = url.pathname;
      if (pathname === '/automation/runs' && req.method === 'POST') {
        const result = await automation.submit(await body(req)); return json(res, result.created ? 201 : 200, result);
      }
      if (pathname === '/automation/runs' && req.method === 'GET') {
        const limit = z.coerce.number().int().min(1).max(500).parse(url.searchParams.get('limit') ?? 100);
        return json(res, 200, await automation.list(limit));
      }
      const run = /^\/automation\/runs\/([^/]+)(\/cancel)?$/.exec(pathname);
      if (run && req.method === (run[2] ? 'POST' : 'GET')) return json(res, 200, await (run[2] ? automation.cancel(run[1]!) : automation.get(run[1]!)));
      const notice = /^\/automation\/notices\/([^/]+)\/(claim|ack)$/.exec(pathname);
      if (notice && req.method === 'POST') return json(res, 200, await (notice[2] === 'claim' ? automation.claim(notice[1]!, await body(req)) : automation.ack(notice[1]!, await body(req))));
      throw new HttpError(404, 'No route');
    } catch (error) {
      if (error instanceof HttpError && error.status === 413) res.setHeader('Connection', 'close');
      json(res, error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500,
        { error: error instanceof HttpError ? error.message : error instanceof z.ZodError ? 'Invalid automation parameters' : 'Automation operation failed' });
    }
  })(); });
}
