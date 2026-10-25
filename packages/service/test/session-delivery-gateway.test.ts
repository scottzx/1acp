import { testCapacity } from './capacity-fixture.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { RemoteAgentGateway } from '../src/a2a/gateway.js';
import { createA2AServer } from '../src/a2a/server.js';
import type { A2ABackend, A2APrepareInput, A2ARunResult, A2ATarget } from '../src/a2a/types.js';

class Backend implements A2ABackend {
  private nextSession = 0;
  readonly runs: Array<{ finish: (result: A2ARunResult) => void }> = [];

  async prepare(input: A2APrepareInput): Promise<A2ATarget> {
    return { sessionId: input.sessionId ?? `remote-session-${++this.nextSession}`, cwd: input.cwd!, agentPreset: input.agentPreset };
  }

  async run(_target: A2ATarget, _prompt: string, options: { signal: AbortSignal }): Promise<A2ARunResult> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(options.signal.reason);
      options.signal.addEventListener('abort', abort, { once: true });
      this.runs.push({ finish: result => { options.signal.removeEventListener('abort', abort); resolve(result); } });
      if (options.signal.aborted) abort();
    });
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function stop(server: Server): Promise<void> {
  const done = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeAllConnections();
  await done;
}

async function until<T>(operation: () => Promise<T>, predicate: (result: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const result = await operation();
    if (predicate(result)) return result;
    if (Date.now() >= deadline) throw new Error('Session delivery test condition deadline');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

type GatewayConfig = ConstructorParameters<typeof RemoteAgentGateway>[0];
type RecordedRequest = { url: string; authorization?: string; body: any };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'session-delivery-gateway-'));
  const backend = new Backend();
  const dsh = { mode: 'accept' as 'accept' | 'reject' | 'disconnect', requests: [] as RecordedRequest[], webhooks: [] as RecordedRequest[] };
  const localHost = createServer((req, res) => {
    void (async () => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const request = { url: req.url!, authorization: req.headers.authorization, body: JSON.parse(raw) };
      if (req.method === 'POST' && req.url === '/notice') {
        dsh.webhooks.push(request);
        res.writeHead(204); res.end();
        return;
      }
      if (req.method !== 'POST' || req.url !== '/api/session/prompt') {
        res.writeHead(404); res.end();
        return;
      }
      dsh.requests.push(request);
      if (dsh.mode === 'disconnect') { req.socket.destroy(); return; }
      if (dsh.mode === 'reject') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'server-response', rpcId: request.body.rpcId,
          result: { ok: false, error: { code: 'temporarily-unavailable', message: 'retry later' } } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'server-response', rpcId: request.body.rpcId, result: { ok: true, value: { accepted: true } } }));
    })().catch(() => { res.writeHead(400); res.end(); });
  });
  const dshUrl = await listen(localHost);
  let host: Awaited<ReturnType<typeof createA2AServer>>;
  const remoteHost = createServer((req, res) => {
    if (req.url === '/.well-known/agent-card.json') host.cardHandler(req, res);
    else void host.handler(req, res);
  });
  const remoteUrl = await listen(remoteHost);
  host = await createA2AServer({ backend, capacity: testCapacity(root), publicUrl: remoteUrl, stateDirectory: join(root, 'remote'), token: 'synthetic-remote-token', defaultAgentPreset: 'coding' });
  const config: GatewayConfig = {
    stateDirectory: join(root, 'gateway'), port: 0,
    remotes: { remote: { url: remoteUrl, token: 'synthetic-remote-token' } },
    sessionHosts: {
      dsh: { kind: 'dsh', url: dshUrl, headers: { Authorization: 'Bearer synthetic-dsh-token' }, timeoutMs: 1000 },
      other: { kind: 'dsh', url: dshUrl, timeoutMs: 1000 },
    },
    notificationTargets: { legacy: { url: `${dshUrl}/notice`, token: 'synthetic-notice-token' } },
    pollIntervalMs: 50,
  };
  const gateways = new Set<RemoteAgentGateway>();
  t.after(async () => {
    for (const gateway of gateways) await gateway.close();
    await host.close();
    await Promise.all([stop(remoteHost), stop(localHost)]);
    await rm(root, { recursive: true, force: true });
  });
  return { root, backend, dsh, config, gateway: (input: GatewayConfig = config) => {
    const gateway = new RemoteAgentGateway(input);
    gateways.add(gateway);
    return gateway;
  } };
}

const originSessionId = 'synthetic-parent-a';
const binding = { originSessionId, host: 'dsh', sessionId: 'existing-dsh-session' };
const spawn = { originSessionId, remote: 'remote', cwd: '/synthetic/project', prompt: 'Produce a synthetic result', agentPreset: 'coding' };
const delivery = (gateway: RemoteAgentGateway, messageId: string, origin = originSessionId): Promise<any> =>
  gateway.invoke('session_delivery_get', { originSessionId: origin, messageId });
const hostMessageId = (messageId: string, origin = originSessionId): string =>
  `1agents-session:${createHash('sha256').update(JSON.stringify([origin, messageId])).digest('hex')}`;

async function accepted(gateway: RemoteAgentGateway, messageId: string, origin = originSessionId): Promise<any> {
  return until(async () => { await gateway.reconcile(); return delivery(gateway, messageId, origin); }, receipt => receipt.status === 'accepted');
}

test('bound A2A completion queues to the existing host session and remains in inbox until business acknowledgement', { timeout: 10000 }, async t => {
  const f = await fixture(t), gateway = f.gateway();
  await gateway.invoke('session_bind', binding);
  const task = await gateway.invoke('remote_agent_spawn', { ...spawn, notificationTarget: 'legacy' }) as any;
  await until(async () => f.backend.runs.length, count => count === 1);
  const finalAnswer = 'Synthetic PPT output is ready\n[Download PPT](https://example.test/synthetic.pptx)';
  f.backend.runs[0]!.finish({ outcome: 'completed', text: finalAnswer });
  const inbox = await until(async () => {
    await gateway.reconcile();
    return gateway.invoke('remote_agent_inbox', { originSessionId }) as Promise<any>;
  }, result => result.notices.length === 1);
  const notice = inbox.notices[0], messageId = `a2a-notice:${notice.noticeId}`;
  const receipt = await accepted(gateway, messageId);
  assert.equal(receipt.attempts, 1);
  assert.equal(receipt.messageId, messageId);
  assert.equal(receipt.hostReceiptId, hostMessageId(messageId));
  assert.equal(receipt.processedAt, undefined);
  assert.equal(f.dsh.requests.length, 1);
  const request = f.dsh.requests[0]!;
  assert.equal(request.authorization, 'Bearer synthetic-dsh-token');
  assert.equal(request.body.type, 'client-request');
  assert.equal(request.body.method, 'session/prompt');
  assert.equal(request.body.rpcId, hostMessageId(messageId));
  assert.equal(request.body.payload.args.request.requestId, hostMessageId(messageId));
  assert.equal(request.body.payload.args.request.sessionId, binding.sessionId);
  assert.equal(request.body.payload.args.request.mode, 'queue');
  assert.ok(request.body.payload.args.request.content[0].text.includes(notice.noticeId));
  assert.ok(request.body.payload.args.request.content[0].text.includes(task.taskId));
  assert.match(request.body.payload.args.request.content[0].text, /remote_agent_get|remote_agent_inbox/);
  const deliveredText = request.body.payload.args.request.content[0].text;
  assert.ok(deliveredText.includes(finalAnswer));
  assert.ok(deliveredText.indexOf(finalAnswer) < deliveredText.indexOf(notice.noticeId));
  assert.equal(JSON.parse(deliveredText.split('\n').at(-1)).taskId, task.taskId);
  assert.equal(notice.taskId, task.taskId);
  assert.equal(notice.result, finalAnswer);
  assert.deepEqual(await gateway.invoke('remote_agent_inbox', { originSessionId }), inbox);
  assert.deepEqual(await gateway.invoke('remote_agent_inbox', { originSessionId: 'synthetic-parent-b' }), { notices: [] });
  await gateway.reconcile();
  assert.equal(f.dsh.webhooks.length, 0, 'A bound origin uses session delivery without also posting its legacy webhook');
  await assert.rejects(gateway.invoke('remote_agent_ack', { originSessionId: 'synthetic-parent-b', noticeId: notice.noticeId }));
  assert.equal((await delivery(gateway, messageId)).processedAt, undefined);
  await gateway.invoke('remote_agent_ack', { originSessionId, noticeId: notice.noticeId });
  assert.deepEqual(await gateway.invoke('remote_agent_inbox', { originSessionId }), { notices: [] });
  assert.ok((await delivery(gateway, messageId)).processedAt);
});

test('bindings and receipts enforce origin scope, immutable destinations, and message content idempotency', { timeout: 10000 }, async t => {
  const f = await fixture(t), gateway = f.gateway();
  await assert.rejects(gateway.invoke('session_bind', { ...binding, host: 'missing' }));
  await gateway.invoke('session_bind', binding);
  await gateway.invoke('session_bind', binding);
  await assert.rejects(gateway.invoke('session_bind', { ...binding, host: 'other' }));
  await assert.rejects(gateway.invoke('session_bind', { ...binding, sessionId: 'another-session' }));
  const message = { originSessionId, messageId: 'synthetic-message-id', text: 'Synthetic content A' };
  await assert.rejects(gateway.invoke('session_send', { ...message, originSessionId: 'synthetic-parent-b' }));
  const initial = await gateway.invoke('session_send', message) as any;
  assert.equal(initial.status, 'pending');
  await accepted(gateway, message.messageId);
  await assert.rejects(delivery(gateway, message.messageId, 'synthetic-parent-b'));
  const repeated = await gateway.invoke('session_send', message) as any;
  assert.equal(repeated.status, 'accepted');
  await assert.rejects(gateway.invoke('session_send', { ...message, text: 'Conflicting synthetic content' }));
  await assert.rejects(gateway.invoke('session_delivery_resolve', {
    originSessionId, messageId: message.messageId, accepted: false, note: 'An accepted delivery cannot be reset',
  }));
  await gateway.reconcile();
  assert.equal(f.dsh.requests.length, 1);
});

test('two origins sharing one host session can use the same business message ID without host deduplication collisions', { timeout: 10000 }, async t => {
  const f = await fixture(t), gateway = f.gateway();
  const otherOrigin = 'synthetic-parent-b';
  await gateway.invoke('session_bind', binding);
  await gateway.invoke('session_bind', { ...binding, originSessionId: otherOrigin });
  const messageId = 'synthetic-shared-business-id';
  const messages = [
    { originSessionId, messageId, text: 'Synthetic origin A result' },
    { originSessionId: otherOrigin, messageId, text: 'Synthetic origin B result' },
  ];
  for (const message of messages) await gateway.invoke('session_send', message);
  const receipts = await Promise.all(messages.map(message => accepted(gateway, messageId, message.originSessionId)));
  assert.equal(f.dsh.requests.length, 2);
  assert.equal(new Set(f.dsh.requests.map(request => request.body.rpcId)).size, 2);
  for (const [index, message] of messages.entries()) {
    const expected = hostMessageId(messageId, message.originSessionId);
    const request = f.dsh.requests.find(item => item.body.rpcId === expected);
    assert.ok(request, 'Each origin must have a distinct stable host request identity');
    assert.equal(request.body.payload.args.request.requestId, expected);
    assert.equal(request.body.payload.args.request.sessionId, binding.sessionId);
    assert.equal(request.body.payload.args.request.content[0].text, message.text);
    assert.equal(receipts[index].messageId, messageId);
    assert.equal(receipts[index].hostReceiptId, expected);
    assert.equal(receipts[index].status, 'accepted');
    assert.equal(receipts[index].attempts, 1);
  }
  await gateway.reconcile();
  assert.equal(f.dsh.requests.length, 2);
});

test('accepted automatic deliveries survive gateway restart without requeueing or acknowledging the notice', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  let gateway = f.gateway();
  await gateway.invoke('session_bind', binding);
  await gateway.invoke('remote_agent_spawn', spawn);
  await until(async () => f.backend.runs.length, count => count === 1);
  f.backend.runs[0]!.finish({ outcome: 'completed', text: 'Synthetic durable completion' });
  const inbox = await until(async () => {
    await gateway.reconcile();
    return gateway.invoke('remote_agent_inbox', { originSessionId }) as Promise<any>;
  }, result => result.notices.length === 1);
  const messageId = `a2a-notice:${inbox.notices[0].noticeId}`;
  await accepted(gateway, messageId);
  await gateway.close();
  gateway = f.gateway();
  await gateway.reconcile();
  const restored = await delivery(gateway, messageId);
  assert.equal(restored.status, 'accepted');
  assert.equal(restored.attempts, 1);
  assert.equal(restored.processedAt, undefined);
  assert.deepEqual(await gateway.invoke('remote_agent_inbox', { originSessionId }), JSON.parse(JSON.stringify(inbox)));
  await gateway.reconcile();
  assert.equal(f.dsh.requests.length, 1);
});

test('upgrading notification format preserves already queued legacy text and keeps the original acknowledgement flow', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  let gateway = f.gateway();
  await gateway.invoke('session_bind', binding);
  await gateway.invoke('remote_agent_spawn', spawn);
  await until(async () => f.backend.runs.length, count => count === 1);
  f.backend.runs[0]!.finish({ outcome: 'completed', text: 'Synthetic completion before upgrade' });
  const inbox = await until(async () => {
    await gateway.reconcile();
    return gateway.invoke('remote_agent_inbox', { originSessionId }) as Promise<any>;
  }, result => result.notices.length === 1);
  const noticeId = inbox.notices[0].noticeId, messageId = `a2a-notice:${noticeId}`;
  await accepted(gateway, messageId);
  await gateway.close();
  const file = join(f.root, 'gateway', 'session-delivery.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.deliveries[0].text = '[A2A任务通知]\nSynthetic legacy locator-only message';
  await writeFile(file, JSON.stringify(saved));
  gateway = f.gateway();
  await gateway.reconcile();
  assert.equal((await delivery(gateway, messageId)).status, 'accepted');
  assert.equal(f.dsh.requests.length, 1, 'A format upgrade must not resend an admitted notice');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).deliveries[0].text, saved.deliveries[0].text);
  assert.deepEqual(await gateway.invoke('remote_agent_inbox', { originSessionId }), JSON.parse(JSON.stringify(inbox)));
  await gateway.invoke('remote_agent_ack', { originSessionId, noticeId });
  assert.ok((await delivery(gateway, messageId)).processedAt);
  assert.deepEqual(await gateway.invoke('remote_agent_inbox', { originSessionId }), { notices: [] });
});

test('explicit host HTTP rejection retries with one stable queue request identity', { timeout: 10000 }, async t => {
  const f = await fixture(t), gateway = f.gateway();
  f.dsh.mode = 'reject';
  await gateway.invoke('session_bind', binding);
  const message = { originSessionId, messageId: 'synthetic-retry-id', text: 'Synthetic retryable message' };
  await gateway.invoke('session_send', message);
  const rejected = await until(async () => { await gateway.reconcile(); return delivery(gateway, message.messageId); }, receipt => receipt.status === 'retrying');
  assert.ok(rejected.attempts >= 1);
  f.dsh.mode = 'accept';
  const receipt = await accepted(gateway, message.messageId);
  assert.ok(receipt.attempts >= 2);
  assert.ok(f.dsh.requests.length >= 2);
  assert.equal(receipt.messageId, message.messageId);
  assert.equal(receipt.hostReceiptId, hostMessageId(message.messageId));
  for (const request of f.dsh.requests) {
    assert.equal(request.body.rpcId, hostMessageId(message.messageId));
    assert.equal(request.body.payload.args.request.requestId, hostMessageId(message.messageId));
    assert.equal(request.body.payload.args.request.sessionId, binding.sessionId);
  }
  const count = f.dsh.requests.length;
  await gateway.reconcile();
  assert.equal(f.dsh.requests.length, count);
});

test('a disconnected DSH receipt stays unknown across restart until explicitly resolved', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  f.dsh.mode = 'disconnect';
  let gateway = f.gateway();
  await gateway.invoke('session_bind', binding);
  const message = { originSessionId, messageId: 'synthetic-disconnected-id', text: 'Synthetic uncertain delivery' };
  await gateway.invoke('session_send', message);
  await until(async () => { await gateway.reconcile(); return delivery(gateway, message.messageId); }, receipt => receipt.status === 'unknown');
  assert.equal(f.dsh.requests.length, 1);
  await gateway.close();
  gateway = f.gateway();
  f.dsh.mode = 'accept';
  await gateway.reconcile();
  assert.equal((await delivery(gateway, message.messageId)).status, 'unknown');
  assert.equal(f.dsh.requests.length, 1);
  await assert.rejects(gateway.invoke('session_delivery_resolve', {
    originSessionId: 'synthetic-parent-b', messageId: message.messageId, accepted: true, note: 'Synthetic wrong-origin resolution',
  }));
  await gateway.invoke('session_delivery_resolve', {
    originSessionId, messageId: message.messageId, accepted: true, note: 'Synthetic independent acceptance confirmation', hostReceiptId: 'synthetic-confirmed-receipt',
  });
  const receipt = await delivery(gateway, message.messageId);
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.hostReceiptId, 'synthetic-confirmed-receipt');
  await gateway.reconcile();
  assert.equal(f.dsh.requests.length, 1);
});

test('unbound completions retain legacy notification routing when their origin is bound later', { timeout: 10000 }, async t => {
  const f = await fixture(t), gateway = f.gateway();
  await gateway.invoke('remote_agent_spawn', { ...spawn, notificationTarget: 'legacy' });
  await until(async () => f.backend.runs.length, count => count === 1);
  f.backend.runs[0]!.finish({ outcome: 'completed', text: 'Synthetic legacy completion' });
  await until(async () => { await gateway.reconcile(); return f.dsh.webhooks.length; }, count => count === 1);
  const inbox = await gateway.invoke('remote_agent_inbox', { originSessionId }) as any;
  assert.equal(inbox.notices.length, 1);
  assert.equal(f.dsh.webhooks[0]!.authorization, 'Bearer synthetic-notice-token');
  await gateway.invoke('session_bind', binding);
  await gateway.reconcile();
  assert.equal(f.dsh.requests.length, 0);
  await assert.rejects(delivery(gateway, `a2a-notice:${inbox.notices[0].noticeId}`));
  assert.deepEqual(await gateway.invoke('remote_agent_inbox', { originSessionId }), inbox);
});

test('an uncertain synthetic Codex queue result is never retried automatically and explicit rejection permits one retry', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const executable = join(f.root, 'synthetic-codex.mjs');
  const callsFile = join(f.root, 'synthetic-codex-calls.jsonl');
  const readyFile = join(f.root, 'synthetic-codex-ready');
  const hostSession = '11111111-1111-4111-8111-111111111111';
  const hostReceipt = '22222222-2222-4222-8222-222222222222';
  await writeFile(executable, `#!${process.execPath}\nimport { appendFileSync, existsSync } from 'node:fs';\nappendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nif (existsSync(${JSON.stringify(readyFile)})) console.log('Queued message ${hostReceipt} for thread ${hostSession}.');\nelse console.log('Synthetic host output with no acceptance receipt');\n`, { mode: 0o700 });
  const config: GatewayConfig = { ...f.config, sessionHosts: { desk: { kind: 'codex', executable, timeoutMs: 2000 } } };
  let gateway = f.gateway(config);
  await gateway.invoke('session_bind', { originSessionId, host: 'desk', sessionId: hostSession });
  const message = { originSessionId, messageId: 'synthetic-codex-id', text: 'Synthetic Codex handoff' };
  await gateway.invoke('session_send', message);
  await until(async () => { await gateway.reconcile(); return delivery(gateway, message.messageId); }, receipt => receipt.status === 'unknown');
  const calls = async (): Promise<string[][]> => (await readFile(callsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(await calls(), [['queue', `--thread=${hostSession}`, `--message=${message.text}`]]);
  await gateway.close();
  gateway = f.gateway(config);
  await gateway.reconcile();
  await gateway.invoke('session_send', message);
  await gateway.reconcile();
  assert.equal((await delivery(gateway, message.messageId)).status, 'unknown');
  assert.equal((await calls()).length, 1);
  await writeFile(readyFile, 'Synthetic acceptance receipt is now available');
  await gateway.invoke('session_delivery_resolve', {
    originSessionId, messageId: message.messageId, accepted: false, note: 'Synthetic test confirmed the first queue request was not accepted',
  });
  const receipt = await accepted(gateway, message.messageId);
  assert.equal(receipt.hostReceiptId, hostReceipt);
  assert.equal(receipt.attempts, 2);
  assert.equal((await calls()).length, 2);
  await gateway.reconcile();
  assert.equal((await calls()).length, 2);
});
