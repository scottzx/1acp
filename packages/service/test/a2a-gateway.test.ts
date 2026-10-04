import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createA2AServer } from '../src/a2a/server.js';
import { RemoteAgentGateway, serveA2AGateway } from '../src/a2a/gateway.js';
import type { A2ABackend, A2APrepareInput, A2ARunResult, A2ATarget } from '../src/a2a/types.js';

class Backend implements A2ABackend {
  readonly runs: Array<{ target: A2ATarget; prompt: string; signal: AbortSignal; finish: (result: A2ARunResult) => void }> = [];
  async prepare(input: A2APrepareInput): Promise<A2ATarget> {
    return { sessionId: input.sessionId ?? `session-${Math.random()}`, cwd: input.cwd!, agentPreset: input.agentPreset };
  }
  async run(target: A2ATarget, prompt: string, options: { signal: AbortSignal }): Promise<A2ARunResult> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(options.signal.reason);
      options.signal.addEventListener('abort', abort, { once: true });
      this.runs.push({ target, prompt, signal: options.signal, finish: result => { options.signal.removeEventListener('abort', abort); resolve(result); } });
      if (options.signal.aborted) abort();
    });
  }
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function stop(server: Server): Promise<void> {
  const done = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeAllConnections(); await done;
}
async function until<T>(operation: () => Promise<T>, predicate: (result: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const result = await operation(); if (predicate(result)) return result;
    if (Date.now() > deadline) throw new Error('Test condition deadline');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'a2a-gateway-'));
  const backend = new Backend();
  let host: Awaited<ReturnType<typeof createA2AServer>>;
  const server = createServer((req, res) => {
    if (req.url === '/.well-known/agent-card.json') host.cardHandler(req, res);
    else void host.handler(req, res);
  });
  const url = await listen(server);
  host = await createA2AServer({ backend, publicUrl: url, stateDirectory: join(root, 'host'), token: 'remote-test-token', defaultAgentPreset: 'coding' });
  const config = { stateDirectory: join(root, 'client'), port: 0, remotes: { wsl: { url, token: 'remote-test-token' } }, pollIntervalMs: 50 };
  const gateways = new Set<RemoteAgentGateway>();
  t.after(async () => {
    for (const gateway of gateways) await gateway.close();
    await host.close(); await stop(server); await rm(root, { recursive: true, force: true });
  });
  return { root, backend, config, server, gateways, gateway: (input: ConstructorParameters<typeof RemoteAgentGateway>[0] = config) => {
    const gateway = new RemoteAgentGateway(input); gateways.add(gateway); return gateway;
  } };
}
const spawn = { remote: 'wsl', originSessionId: 'parent-a', cwd: '/home/scott/project', prompt: 'read pwd', agentPreset: 'coding' };

test('spawn returns before execution; detached completion reconciles after gateway restart and inbox is scoped and durable', async t => {
  const f = await fixture(t);
  const gateway = f.gateway();
  t.after(() => gateway.close());
  const first = await gateway.invoke('remote_agent_spawn', spawn) as any;
  assert.ok(first.taskId); assert.equal(first.cwd, spawn.cwd); assert.ok(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'].includes(first.state));
  const second = await gateway.invoke('remote_agent_spawn', spawn) as any;
  assert.notEqual(first.contextId, second.contextId); assert.notEqual(first.sessionId, second.sessionId);
  assert.throws(() => new RemoteAgentGateway(f.config), /already in use/);
  await until(async () => f.backend.runs.length, value => value === 2);
  await gateway.close();
  assert.equal(f.backend.runs[0]!.signal.aborted, false);
  f.backend.runs[0]!.finish({ outcome: 'completed', text: '/home/scott/project' });
  const restored = f.gateway(); t.after(() => restored.close());
  const final = await until(() => restored.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-a', taskId: first.taskId }) as Promise<any>, value => value.state === 'TASK_STATE_COMPLETED');
  assert.equal(final.result, '/home/scott/project');
  await assert.rejects(restored.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-b', taskId: first.taskId }), /not found/);
  assert.deepEqual(await restored.invoke('remote_agent_inbox', { originSessionId: 'parent-b' }), { notices: [] });
  const inbox = await restored.invoke('remote_agent_inbox', { originSessionId: 'parent-a' }) as any;
  assert.equal(inbox.notices.length, 1); assert.equal(inbox.notices[0].taskId, first.taskId);
  await restored.receivePush({ statusUpdate: { taskId: first.taskId, status: { state: 'TASK_STATE_FAILED' } } });
  assert.deepEqual(await restored.invoke('remote_agent_inbox', { originSessionId: 'parent-a' }), inbox);
  await restored.invoke('remote_agent_ack', { originSessionId: 'parent-a', noticeId: inbox.notices[0].noticeId });
  await restored.close();
  const again = f.gateway(); t.after(() => again.close());
  assert.deepEqual(await again.invoke('remote_agent_inbox', { originSessionId: 'parent-a' }), { notices: [] });
});

test('follow-up reuses remote session, cancellation only aborts the requested task, and offline is stale', async t => {
  const f = await fixture(t), gateway = f.gateway(); t.after(() => gateway.close());
  await assert.rejects(gateway.invoke('remote_agent_spawn', { ...spawn, cwd: 'relative' }));
  const first = await gateway.invoke('remote_agent_spawn', spawn) as any;
  await until(async () => f.backend.runs.length, value => value === 1);
  f.backend.runs[0]!.finish({ outcome: 'completed', text: 'first result' });
  await until(() => gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-a', taskId: first.taskId }) as Promise<any>, value => value.state === 'TASK_STATE_COMPLETED');
  const follow = await gateway.invoke('remote_agent_message', { remote: 'wsl', originSessionId: 'parent-a', taskId: first.taskId, prompt: 'continue' }) as any;
  assert.equal(follow.contextId, first.contextId); assert.equal(follow.sessionId, first.sessionId); assert.notEqual(follow.taskId, first.taskId);
  const other = await gateway.invoke('remote_agent_spawn', spawn) as any;
  await until(async () => f.backend.runs.length, value => value === 3);
  const canceled = await gateway.invoke('remote_agent_cancel', { remote: 'wsl', originSessionId: 'parent-a', taskId: follow.taskId }) as any;
  assert.equal(canceled.state, 'TASK_STATE_CANCELED'); assert.equal(f.backend.runs[1]!.signal.aborted, true); assert.equal(f.backend.runs[2]!.signal.aborted, false);
  await gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-a', taskId: other.taskId });
  await stop(f.server);
  const offline = await gateway.invoke('remote_agent_get', { remote: 'wsl', originSessionId: 'parent-a', taskId: other.taskId }) as any;
  assert.equal(offline.stale, true); assert.equal(offline.state, 'TASK_STATE_WORKING');
});

test('completion delivery retries across restarts with a stable notice ID and origin routing', async t => {
  const f = await fixture(t); let ready = false;
  const received: any[] = [];
  const sink = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer sink-token');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const notice = JSON.parse(raw); assert.equal(req.headers['idempotency-key'], notice.noticeId); received.push(notice);
    res.writeHead(ready ? 204 : 503); res.end();
  });
  const sinkUrl = await listen(sink); t.after(() => stop(sink));
  const config = { ...f.config, notificationTargets: { phone: { url: sinkUrl, token: 'sink-token' } } };
  let gateway = f.gateway(config); t.after(() => gateway.close());
  await assert.rejects(gateway.invoke('remote_agent_spawn', { ...spawn, notificationTarget: 'unknown' }), /Unknown notificationTarget/);
  const task = await gateway.invoke('remote_agent_spawn', { ...spawn, notificationTarget: 'phone' }) as any;
  await until(async () => f.backend.runs.length, value => value === 1);
  f.backend.runs[0]!.finish({ outcome: 'completed', text: 'delivery result' });
  await until(async () => { await gateway.reconcile(); return received.length; }, value => value > 0);
  await gateway.close(); ready = true; gateway = f.gateway(config);
  await until(async () => { await gateway.reconcile(); return received.length; }, value => value > 1);
  assert.equal(received[0].noticeId, received.at(-1).noticeId); assert.equal(received.at(-1).originSessionId, spawn.originSessionId);
  assert.equal(received.at(-1).taskId, task.taskId); assert.equal(received.at(-1).result, 'delivery result');
  const deliveredCount = received.length; await gateway.reconcile(); assert.equal(received.length, deliveredCount);
});

test('local HTTP tools reject browser calls; authenticated callback listener exposes no invocation route', async t => {
  const f = await fixture(t);
  const host = await serveA2AGateway({ ...f.config, callback: { host: '127.0.0.1', port: 0, url: 'http://127.0.0.1:1/events', token: 'callback-test-token' } }, { report: false });
  f.gateways.add(host.gateway);
  t.after(() => host.close());
  const url = `http://127.0.0.1:${host.port}`;
  assert.equal((await fetch(url + '/health')).status, 200);
  assert.equal((await fetch(url + '/invoke', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  const response = await fetch(url + '/invoke', { method: 'POST', body: JSON.stringify({ method: 'remote_agent_inbox', params: { originSessionId: 'parent-a' } }) });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { notices: [] });
  assert.equal((await fetch(url + '/events', { method: 'POST', body: '{}' })).status, 404);
  const callback = `http://127.0.0.1:${host.callbackPort}`;
  assert.equal((await fetch(callback + '/events', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(callback + '/invoke', { method: 'POST', headers: { Authorization: 'Bearer callback-test-token' }, body: '{}' })).status, 404);
  assert.equal((await fetch(callback + '/events', { method: 'POST', headers: { Authorization: 'Bearer callback-test-token' }, body: JSON.stringify({ statusUpdate: { taskId: 'unknown-task' } }) })).status, 202);
});
