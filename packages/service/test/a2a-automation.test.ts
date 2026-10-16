import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createA2AServer } from '../src/a2a/server.js';
import { RemoteAgentGateway, serveA2AGateway, type A2AGatewayConfig } from '../src/a2a/gateway.js';
import type { A2ABackend, A2APrepareInput, A2ARunResult, A2ATarget } from '../src/a2a/types.js';

const token = 'automation-test-bearer';
const occurrence = { scheduleId: 'daily-report', scheduledFor: '2026-10-16T09:00:00+08:00',
  flowRunId: 'activepieces-flow-run-1', businessRef: 'project:test', prompt: 'Produce the scheduled project report.' };

/** Execution deliberately waits for the test, without an agent process or provider credentials. */
class DeferredBackend implements A2ABackend {
  readonly preparations: A2APrepareInput[] = [];
  readonly runs: Array<{ target: A2ATarget; prompt: string; signal: AbortSignal; finish: (value: A2ARunResult) => void }> = [];

  async prepare(input: A2APrepareInput): Promise<A2ATarget> {
    this.preparations.push(structuredClone(input));
    return { sessionId: input.sessionId ?? `session-${this.preparations.length}`, cwd: input.cwd!, agentPreset: input.agentPreset };
  }

  async run(target: A2ATarget, prompt: string, options: { signal: AbortSignal }): Promise<A2ARunResult> {
    return new Promise((resolve, reject) => {
      const abort = (): void => reject(options.signal.reason);
      options.signal.addEventListener('abort', abort, { once: true });
      this.runs.push({ target, prompt, signal: options.signal, finish: value => {
        options.signal.removeEventListener('abort', abort); resolve(value);
      } });
      if (options.signal.aborted) abort();
    });
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function stop(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections(); await closed;
}

async function until<T>(operation: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await operation();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error(`Automation condition deadline: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function request(origin: string, path: string, options: { body?: unknown; method?: string; token?: string | null; headers?: Record<string, string> } = {}) {
  const response = await fetch(origin + path, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', ...(options.token === null ? {} : { Authorization: `Bearer ${options.token ?? token}` }), ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json() as any };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'a2a-automation-'));
  const backend = new DeferredBackend();
  let host: Awaited<ReturnType<typeof createA2AServer>> | undefined;
  let loseNextResponse = false;
  let lostResponses = 0;
  const server = createServer((req, res) => {
    if (!host) { res.writeHead(503); res.end(); return; }
    if (req.url === '/.well-known/agent-card.json') { void host.cardHandler(req, res); return; }
    if (req.url !== '/a2a') { res.writeHead(404); res.end(); return; }
    if (loseNextResponse) {
      loseNextResponse = false;
      // The server accepts and persists SendMessage before its response is lost.
      // Dropping the socket in end() models the ambiguous cross-system boundary.
      res.end = (() => { lostResponses++; res.destroy(); return res; }) as typeof res.end;
    }
    void host.handler(req, res).catch(error => res.destroy(error));
  });
  const url = await listen(server);
  host = await createA2AServer({ backend, publicUrl: url, stateDirectory: join(root, 'host'), token: 'remote-test-token', defaultAgentPreset: 'coding' });
  const config: A2AGatewayConfig = { stateDirectory: join(root, 'gateway'), port: 0,
    remotes: { wsl: { url, token: 'remote-test-token' } }, pollIntervalMs: 50,
    automation: { host: '127.0.0.1', port: 0, token, schedules: {
      'daily-report': { remote: 'wsl', cwd: '/home/scott/report-project', agentPreset: 'coding' },
      'other-report': { remote: 'wsl', cwd: '/home/scott/other-project', agentPreset: 'coding' },
    } },
  };
  const gateways = new Set<Awaited<ReturnType<typeof serveA2AGateway>>>();
  t.after(async () => {
    for (const gateway of gateways) await gateway.close();
    await host!.close(); await stop(server); await rm(root, { recursive: true, force: true });
  });
  return { backend, config, loseResponse: () => { loseNextResponse = true; }, lostResponses: () => lostResponses,
    start: async (input: A2AGatewayConfig = config) => {
      const gateway = await serveA2AGateway(input, { report: false }); gateways.add(gateway);
      assert.ok(gateway.automationPort, 'automation receiver should have its own port');
      return { ...gateway, url: `http://127.0.0.1:${gateway.automationPort}` };
    },
  };
}

test('automation receiver authenticates and rejects browser calls, arbitrary targets and local tool routes', { timeout: 10000 }, async t => {
  const f = await fixture(t), gateway = await f.start();
  assert.equal((await request(gateway.url, '/automation/runs', { token: null })).status, 401);
  assert.equal((await request(gateway.url, '/automation/runs', { token: 'wrong-token' })).status, 401);
  assert.equal((await request(gateway.url, '/automation/runs', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await request(gateway.url, '/invoke', { body: { method: 'remote_agent_spawn', params: {} } })).status, 404);
  assert.equal((await request(gateway.url, '/automation/runs', { body: { ...occurrence, scheduleId: 'unknown' } })).status, 404);
  assert.equal((await request(gateway.url, '/automation/runs', { body: { ...occurrence, remote: 'evil', cwd: '/tmp/override' } })).status, 400);
  assert.equal((await request(gateway.url, '/automation/runs', { body: { ...occurrence, scheduledFor: 'not-a-date' } })).status, 400);
  assert.deepEqual((await request(gateway.url, '/automation/runs')).body, { runs: [] });
  assert.equal(f.backend.runs.length, 0);

  await gateway.close();
  await assert.rejects(f.start({ ...f.config, automation: { ...f.config.automation!, schedules: {
    bad: { remote: 'unconfigured', cwd: '/home/scott/project' },
  } } }), /remote/i);
});

test('concurrent scheduled dispatch deduplicates canonical occurrences and skips overlapping runs', { timeout: 10000 }, async t => {
  const f = await fixture(t), gateway = await f.start();
  const replies = await Promise.all(Array.from({ length: 8 }, (_, index) => request(gateway.url, '/automation/runs', {
    body: { ...occurrence, scheduledFor: index % 2 ? '2026-10-16T01:00:00.000Z' : occurrence.scheduledFor, flowRunId: `retry-${index}` },
  })));
  assert.equal(replies.filter(reply => reply.status === 201).length, 1);
  assert.equal(replies.filter(reply => reply.body.created).length, 1);
  assert.ok(replies.every(reply => reply.status === 200 || reply.status === 201));
  const runId = replies[0].body.run.runId;
  assert.ok(runId); assert.ok(replies.every(reply => reply.body.run.runId === runId));
  await until(async () => f.backend.runs.length, count => count === 1);
  assert.equal(f.backend.runs[0].target.cwd, '/home/scott/report-project');
  assert.equal(f.backend.runs[0].target.agentPreset, 'coding');
  assert.equal(f.backend.runs[0].prompt, occurrence.prompt);
  const submitted = (await request(gateway.url, `/automation/runs/${runId}`)).body.run;
  assert.equal(submitted.status, 'submitted'); assert.ok(submitted.taskId);
  assert.equal(submitted.scheduledFor, '2026-10-16T01:00:00.000Z');
  assert.equal(submitted.originSessionId, `automation:${runId}`);
  assert.equal(submitted.businessRef, occurrence.businessRef);

  const skipped = await request(gateway.url, '/automation/runs', { body: { ...occurrence, scheduledFor: '2026-10-17T09:00:00+08:00' } });
  assert.equal(skipped.status, 201); assert.equal(skipped.body.run.status, 'skipped');
  assert.notEqual(skipped.body.run.runId, runId); assert.equal(skipped.body.run.taskId, undefined);
  const skippedAgain = await request(gateway.url, '/automation/runs', { body: { ...occurrence, scheduledFor: '2026-10-17T01:00:00Z' } });
  assert.equal(skippedAgain.status, 200); assert.equal(skippedAgain.body.run.runId, skipped.body.run.runId);
  assert.equal(f.backend.runs.length, 1);

  const other = await request(gateway.url, '/automation/runs', { body: { ...occurrence, scheduleId: 'other-report' } });
  assert.equal(other.status, 201); assert.equal(other.body.run.status, 'submitted');
  await until(async () => f.backend.runs.length, count => count === 2);
  f.backend.runs[0].finish({ outcome: 'completed', text: 'Scheduled report complete.' });
  const completed = await until(async () => (await request(gateway.url, `/automation/runs/${runId}`)).body.run,
    run => run.status === 'completed');
  assert.equal(completed.result, 'Scheduled report complete.');
  const next = await request(gateway.url, '/automation/runs', { body: { ...occurrence, scheduledFor: '2026-10-18T09:00:00+08:00' } });
  assert.equal(next.status, 201); assert.equal(next.body.run.status, 'submitted');
  await until(async () => f.backend.runs.length, count => count === 3);
});

test('gateway restart preserves the occurrence ledger and resumes tracking detached remote execution', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  let gateway = await f.start();
  const first = await request(gateway.url, '/automation/runs', { body: occurrence });
  assert.equal(first.status, 201);
  const run = first.body.run;
  await until(async () => f.backend.runs.length, count => count === 1);
  await gateway.close();
  assert.equal(f.backend.runs[0].signal.aborted, false, 'stopping the gateway must not abort remote execution');
  f.backend.runs[0].finish({ outcome: 'completed', text: 'Finished while dispatcher was offline.' });
  gateway = await f.start();
  const duplicate = await request(gateway.url, '/automation/runs', { body: { ...occurrence, flowRunId: 'retried-after-restart' } });
  assert.equal(duplicate.status, 200); assert.equal(duplicate.body.created, false);
  assert.equal(duplicate.body.run.runId, run.runId); assert.equal(duplicate.body.run.taskId, run.taskId);
  const final = await until(async () => (await request(gateway.url, `/automation/runs/${run.runId}`)).body.run,
    current => current.status === 'completed');
  assert.equal(final.result, 'Finished while dispatcher was offline.');
  assert.equal(f.backend.runs.length, 1);
  const runs = (await request(gateway.url, '/automation/runs?limit=10')).body.runs;
  assert.equal(runs.length, 1); assert.equal(runs[0].runId, run.runId);
});

test('shutdown keeps the storage lease until an automation HTTP continuation has saved its task linkage', { timeout: 10000 }, async t => {
  const f = await fixture(t), gateway = await f.start();
  let submitted!: () => void, release!: () => void;
  const accepted = new Promise<void>(resolve => { submitted = resolve; });
  const continueSubmission = new Promise<void>(resolve => { release = resolve; });
  const invoke = gateway.gateway.invoke.bind(gateway.gateway);
  gateway.gateway.invoke = async (method, params) => {
    const result = await invoke(method, params);
    if (method === 'remote_agent_spawn') {
      // The gateway operation has settled, but the automation handler has not
      // yet saved the returned task ID in its separate occurrence ledger.
      submitted(); await continueSubmission;
    }
    return result;
  };
  const dispatch = request(gateway.url, '/automation/runs', { body: occurrence });
  await accepted;
  let closeFinished = false;
  const closing = gateway.close().then(() => { closeFinished = true; });
  const concurrentClose = gateway.close();
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closeFinished, false, 'shutdown must wait for the automation response');
    let contender: RemoteAgentGateway | undefined;
    try {
      assert.throws(() => { contender = new RemoteAgentGateway(f.config); }, /already in use/, 'a second owner must not acquire storage while the handler can still write');
    } finally { await contender?.close(); }
  } finally { release(); }
  const response = await dispatch;
  assert.equal(response.status, 201); assert.equal(response.body.run.status, 'submitted');
  await Promise.all([closing, concurrentClose]);
  assert.equal(f.backend.runs[0].signal.aborted, false, 'draining must not cancel the detached remote task');
  const restored = await f.start();
  const duplicate = await request(restored.url, '/automation/runs', { body: occurrence });
  assert.equal(duplicate.status, 200); assert.equal(duplicate.body.run.taskId, response.body.run.taskId);
  assert.equal(f.backend.runs.length, 1);
});

test('a completion claim recovers an accepted gateway task when a crash interrupted the automation ledger update', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  let gateway = await f.start();
  const run = (await request(gateway.url, '/automation/runs', { body: occurrence })).body.run;
  await until(async () => f.backend.runs.length, count => count === 1);
  await gateway.close();
  // Recreate the durable boundary: gateway.json has the Task, while automation.json
  // retains the pre-submission record because the process stopped before apply().
  const ledgerPath = join(f.config.stateDirectory, 'automation.json');
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  const interrupted = ledger.runs.find((value: any) => value.runId === run.runId);
  interrupted.status = 'dispatching';
  for (const key of ['taskId', 'contextId', 'sessionId', 'state', 'result', 'checkedAt', 'stale']) delete interrupted[key];
  await writeFile(ledgerPath, JSON.stringify(ledger));
  f.backend.runs[0].finish({ outcome: 'completed', text: 'Completed across the ledger crash window.' });
  gateway = await f.start();
  const inbox = await until(async () => {
    await gateway.gateway.reconcile();
    return await gateway.gateway.invoke('remote_agent_inbox', { originSessionId: run.originSessionId }) as { notices: any[] };
  }, value => value.notices.length === 1);
  const claimed = await request(gateway.url, `/automation/notices/${inbox.notices[0].noticeId}/claim`, {
    body: { originSessionId: run.originSessionId, processorId: 'recovering-result-flow' },
  });
  assert.equal(claimed.status, 200); assert.equal(claimed.body.claimed, true);
  assert.equal(claimed.body.runId, run.runId);
  const recovered = (await request(gateway.url, `/automation/runs/${run.runId}`)).body.run;
  assert.equal(recovered.taskId, run.taskId); assert.equal(recovered.status, 'completed');
  assert.equal(f.backend.runs.length, 1);
});

test('lost submission response becomes durable submission_unknown and never blindly resends the occurrence', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  let gateway = await f.start(); f.loseResponse();
  const first = await request(gateway.url, '/automation/runs', { body: occurrence });
  assert.equal(first.status, 201); assert.equal(first.body.run.status, 'submission_unknown');
  assert.equal(first.body.run.taskId, undefined);
  await until(async () => f.backend.runs.length, count => count === 1);
  assert.equal(f.lostResponses(), 1);
  const duplicate = await request(gateway.url, '/automation/runs', { body: occurrence });
  assert.equal(duplicate.status, 200); assert.equal(duplicate.body.run.runId, first.body.run.runId);
  assert.equal(duplicate.body.run.status, 'submission_unknown');
  await gateway.close(); gateway = await f.start();
  const restored = await request(gateway.url, '/automation/runs', { body: occurrence });
  assert.equal(restored.status, 200); assert.equal(restored.body.run.status, 'submission_unknown');
  const overlapping = await request(gateway.url, '/automation/runs', { body: { ...occurrence, scheduledFor: '2026-10-17T09:00:00+08:00' } });
  assert.equal(overlapping.body.run.status, 'skipped', 'unknown acceptance must conservatively hold the schedule slot');
  await gateway.gateway.reconcile(); assert.equal(f.backend.runs.length, 1);
});

test('canceling one scheduled task releases its schedule and leaves other schedules running', { timeout: 10000 }, async t => {
  const f = await fixture(t), gateway = await f.start();
  const first = (await request(gateway.url, '/automation/runs', { body: occurrence })).body.run;
  const other = (await request(gateway.url, '/automation/runs', { body: { ...occurrence, scheduleId: 'other-report' } })).body.run;
  await until(async () => f.backend.runs.length, count => count === 2);
  const canceled = await request(gateway.url, `/automation/runs/${first.runId}/cancel`, { body: {} });
  assert.equal(canceled.status, 200); assert.equal(canceled.body.run.status, 'canceled');
  assert.equal(f.backend.runs[0].signal.aborted, true);
  assert.equal(f.backend.runs[1].signal.aborted, false);
  assert.equal((await request(gateway.url, `/automation/runs/${other.runId}`)).body.run.status, 'submitted');
  const next = await request(gateway.url, '/automation/runs', { body: { ...occurrence, scheduledFor: '2026-10-17T09:00:00+08:00' } });
  assert.equal(next.status, 201); assert.equal(next.body.run.status, 'submitted');
  await until(async () => f.backend.runs.length, count => count === 3);
  assert.equal((await request(gateway.url, '/automation/runs/nonexistent/cancel', { body: {} })).status, 404);
});

test('expired result-processing claims can be taken over and a stale processor cannot acknowledge completion', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const gateway = await f.start({ ...f.config, automation: { ...f.config.automation!, processingLeaseMs: 250 } });
  const run = (await request(gateway.url, '/automation/runs', { body: occurrence })).body.run;
  await until(async () => f.backend.runs.length, count => count === 1);
  f.backend.runs[0].finish({ outcome: 'completed', text: 'Result ready to process.' });
  const inbox = await until(async () => {
    await gateway.gateway.reconcile();
    return await gateway.gateway.invoke('remote_agent_inbox', { originSessionId: run.originSessionId }) as { notices: any[] };
  }, value => value.notices.length === 1);
  const noticePath = `/automation/notices/${inbox.notices[0].noticeId}`;
  const first = { originSessionId: run.originSessionId, processorId: 'interrupted-processor' };
  const replacement = { ...first, processorId: 'replacement-processor' };
  assert.equal((await request(gateway.url, noticePath + '/ack', { body: first })).status, 409);
  const claimed = await request(gateway.url, noticePath + '/claim', { body: first });
  assert.equal(claimed.body.claimed, true);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(claimed.body.leaseUntil) - Date.now()) + 25));
  assert.equal((await request(gateway.url, noticePath + '/ack', { body: first })).status, 409);
  const takeover = await request(gateway.url, noticePath + '/claim', { body: replacement });
  assert.equal(takeover.status, 200); assert.equal(takeover.body.claimed, true);
  assert.equal((await request(gateway.url, noticePath + '/claim', { body: first })).body.claimed, false);
  assert.equal((await request(gateway.url, noticePath + '/ack', { body: first })).status, 409);
  assert.equal((await request(gateway.url, noticePath + '/claim', { body: replacement })).body.claimed, true);
  assert.equal((await request(gateway.url, noticePath + '/ack', { body: replacement })).body.acknowledged, true);
});

test('restart retries only local gateway acknowledgement after durable business completion', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  let gateway = await f.start();
  const run = (await request(gateway.url, '/automation/runs', { body: occurrence })).body.run;
  await until(async () => f.backend.runs.length, count => count === 1);
  f.backend.runs[0].finish({ outcome: 'completed', text: 'Business result already saved.' });
  const inbox = await until(async () => {
    await gateway.gateway.reconcile();
    return await gateway.gateway.invoke('remote_agent_inbox', { originSessionId: run.originSessionId }) as { notices: any[] };
  }, value => value.notices.length === 1);
  const notice = inbox.notices[0];
  const noticePath = `/automation/notices/${notice.noticeId}`;
  const processor = { originSessionId: run.originSessionId, processorId: 'completed-business-flow' };
  assert.equal((await request(gateway.url, noticePath + '/claim', { body: processor })).body.claimed, true);
  const invoke = gateway.gateway.invoke.bind(gateway.gateway);
  let failedAcknowledgements = 0;
  gateway.gateway.invoke = async (method, params) => {
    if (method === 'remote_agent_ack') { failedAcknowledgements++; throw new Error('Injected local acknowledgement failure'); }
    return invoke(method, params);
  };
  const failedAck = await request(gateway.url, noticePath + '/ack', { body: processor });
  assert.equal(failedAck.status, 503); assert.ok(failedAcknowledgements > 0);
  const saved = JSON.parse(await readFile(join(f.config.stateDirectory, 'automation.json'), 'utf8'));
  const processing = saved.notices.find((value: any) => value.noticeId === notice.noticeId);
  assert.ok(processing.businessCompletedAt, 'business completion must be durable before gateway acknowledgement');
  assert.equal(processing.gatewayAcknowledgedAt, undefined);
  assert.equal((await request(gateway.url, noticePath + '/claim', { body: { ...processor, processorId: 'duplicate-business-flow' } })).body.claimed, false);
  await gateway.close(); gateway = await f.start();
  await until(async () => {
    await gateway.gateway.reconcile();
    return await gateway.gateway.invoke('remote_agent_inbox', { originSessionId: run.originSessionId }) as { notices: any[] };
  }, value => value.notices.length === 0);
  const restored = JSON.parse(await readFile(join(f.config.stateDirectory, 'automation.json'), 'utf8'));
  const acknowledged = restored.notices.find((value: any) => value.noticeId === notice.noticeId);
  assert.equal(acknowledged.businessCompletedAt, processing.businessCompletedAt);
  assert.ok(acknowledged.gatewayAcknowledgedAt);
  const duplicateClaim = await request(gateway.url, noticePath + '/claim', { body: processor });
  assert.equal(duplicateClaim.body.claimed, false); assert.equal(duplicateClaim.body.reason, 'acknowledged');
  assert.equal((await request(gateway.url, noticePath + '/ack', { body: processor })).body.acknowledged, true);
  assert.equal(f.backend.runs.length, 1, 'acknowledgement recovery must not rerun the agent');
});

test('business-completion persistence failure keeps the gateway notice until a durable retry succeeds', { timeout: 10000 }, async t => {
  const f = await fixture(t), gateway = await f.start();
  const run = (await request(gateway.url, '/automation/runs', { body: occurrence })).body.run;
  await until(async () => f.backend.runs.length, count => count === 1);
  f.backend.runs[0].finish({ outcome: 'completed', text: 'Result awaiting durable confirmation.' });
  const inbox = await until(async () => {
    await gateway.gateway.reconcile();
    return await gateway.gateway.invoke('remote_agent_inbox', { originSessionId: run.originSessionId }) as { notices: any[] };
  }, value => value.notices.length === 1);
  const noticePath = `/automation/notices/${inbox.notices[0].noticeId}`;
  const processor = { originSessionId: run.originSessionId, processorId: 'durable-result-flow' };
  assert.equal((await request(gateway.url, noticePath + '/claim', { body: processor })).body.claimed, true);
  const automation = gateway.gateway.automation as unknown as { save: () => void };
  const save = automation.save.bind(automation);
  const invoke = gateway.gateway.invoke.bind(gateway.gateway);
  let writes = 0, gatewayAcknowledgements = 0;
  automation.save = () => {
    // Permit knownNotice's task refresh, then fail business completion and all
    // subsequent ledger writes while the real gateway state remains writable.
    if (++writes > 1) throw new Error('Injected automation ledger write failure');
    save();
  };
  gateway.gateway.invoke = async (method, params) => {
    if (method === 'remote_agent_ack') gatewayAcknowledgements++;
    return invoke(method, params);
  };
  try {
    assert.equal((await request(gateway.url, noticePath + '/ack', { body: processor })).status, 500);
    await gateway.gateway.reconcile();
    assert.equal(gatewayAcknowledgements, 0, 'gateway inbox must remain intact while business completion cannot be persisted');
    const pending = await invoke('remote_agent_inbox', { originSessionId: run.originSessionId }) as { notices: any[] };
    assert.equal(pending.notices.length, 1);
    const ledger = JSON.parse(await readFile(join(f.config.stateDirectory, 'automation.json'), 'utf8'));
    assert.equal(ledger.notices[0].businessCompletedAt, undefined);
  } finally { automation.save = save; }
  await gateway.gateway.reconcile();
  assert.ok(gatewayAcknowledgements > 0);
  assert.deepEqual(await invoke('remote_agent_inbox', { originSessionId: run.originSessionId }), { notices: [] });
  const saved = JSON.parse(await readFile(join(f.config.stateDirectory, 'automation.json'), 'utf8'));
  assert.ok(saved.notices[0].businessCompletedAt); assert.ok(saved.notices[0].gatewayAcknowledgedAt);
});

test('completion webhook retries a stable notice ID, and claim plus owner-only acknowledgement survives restarts', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  let ready = false;
  const received: Array<{ notice: any; authorization: string | undefined; idempotencyKey: string | string[] | undefined; accepted: boolean }> = [];
  const sink = createServer((req, res) => { void (async () => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    received.push({ notice: JSON.parse(raw), authorization: req.headers.authorization, idempotencyKey: req.headers['idempotency-key'], accepted: ready });
    res.writeHead(ready ? 204 : 503); res.end();
  })().catch(error => res.destroy(error)); });
  const sinkUrl = await listen(sink); t.after(() => stop(sink));
  const config: A2AGatewayConfig = { ...f.config, notificationTargets: { activepieces: { url: sinkUrl, token: 'webhook-test-token' } },
    automation: { ...f.config.automation!, schedules: {
      'daily-report': { ...f.config.automation!.schedules['daily-report'], notificationTarget: 'activepieces' },
    } },
  };
  let gateway = await f.start(config);
  const response = await request(gateway.url, '/automation/runs', { body: occurrence });
  const run = response.body.run;
  await until(async () => f.backend.runs.length, count => count === 1);
  f.backend.runs[0].finish({ outcome: 'completed', text: 'Report for Activepieces.' });
  await until(async () => { await gateway.gateway.reconcile(); return received.length; }, count => count > 0);
  await gateway.close(); ready = true; gateway = await f.start(config);
  await until(async () => { await gateway.gateway.reconcile(); return received.some(value => value.accepted); }, value => value);
  const notice = received[0].notice;
  assert.ok(received.every(value => value.notice.noticeId === notice.noticeId));
  assert.ok(received.every(value => value.idempotencyKey === notice.noticeId));
  assert.ok(received.every(value => value.authorization === 'Bearer webhook-test-token'));
  assert.equal(notice.originSessionId, run.originSessionId); assert.equal(notice.taskId, run.taskId);
  assert.equal(notice.result, 'Report for Activepieces.');
  const deliveredCount = received.length;
  await gateway.gateway.reconcile(); assert.equal(received.length, deliveredCount);

  const noticePath = `/automation/notices/${notice.noticeId}`;
  const owner = { originSessionId: run.originSessionId, processorId: 'activepieces-result-run-1' };
  assert.equal((await request(gateway.url, noticePath + '/claim', { body: { ...owner, originSessionId: 'automation:another-run' } })).status, 404);
  assert.equal((await request(gateway.url, '/automation/notices/fabricated/claim', { body: owner })).status, 404);
  const claimed = await request(gateway.url, noticePath + '/claim', { body: owner });
  assert.equal(claimed.status, 200); assert.equal(claimed.body.claimed, true);
  assert.equal(claimed.body.runId, run.runId); assert.equal(claimed.body.notice.noticeId, notice.noticeId);
  assert.equal((await request(gateway.url, noticePath + '/claim', { body: owner })).body.claimed, true);
  const otherOwner = { ...owner, processorId: 'duplicate-result-flow' };
  assert.equal((await request(gateway.url, noticePath + '/claim', { body: otherOwner })).body.claimed, false);
  const wrongAck = await request(gateway.url, noticePath + '/ack', { body: otherOwner });
  assert.equal(wrongAck.status, 409);
  await gateway.close(); gateway = await f.start(config);
  assert.equal((await request(gateway.url, noticePath + '/claim', { body: otherOwner })).body.claimed, false);
  const acknowledged = await request(gateway.url, noticePath + '/ack', { body: owner });
  assert.equal(acknowledged.status, 200); assert.equal(acknowledged.body.acknowledged, true);
  assert.equal(acknowledged.body.runId, run.runId);
  assert.deepEqual((await request(gateway.url, noticePath + '/ack', { body: owner })).body, acknowledged.body);
  await gateway.close(); gateway = await f.start(config);
  assert.deepEqual((await request(gateway.url, noticePath + '/ack', { body: owner })).body, acknowledged.body);
  assert.equal((await request(gateway.url, noticePath + '/claim', { body: otherOwner })).body.claimed, false);
  const inbox = await gateway.gateway.invoke('remote_agent_inbox', { originSessionId: run.originSessionId });
  assert.deepEqual(inbox, { notices: [] });
  await gateway.gateway.reconcile(); assert.equal(received.length, deliveredCount);
});
