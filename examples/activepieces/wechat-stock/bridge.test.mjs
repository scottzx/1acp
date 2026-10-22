import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StockBridge, minimumIntervalMs } from './bridge.mjs';
import { evaluateStock } from './policy.mjs';
import { bridgeServer } from './server.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'wechat-stock-')); t.after(() => rm(root, { recursive: true, force: true }));
  let clock = Date.parse('2026-10-23T00:00:00+08:00'), completed = false, failWrite = false, loseSubmit = false;
  const count = { submitted: 0, uniqueExecutions: 0, verified: 0, ingested: 0, reads: 0 }, executions = new Map();
  const config = { stateDirectory: root, policy: { policyId: 'stock-test', scopeId: 'reserve-pool', enabled: true, paused: false,
    lowWatermark: 10, targetStock: 15, maxConcurrent: 1, checkIntervalMs: minimumIntervalMs },
    catalog: Array.from({ length: 20 }, (_, n) => ({ articleKey: `article-${n}`, revision: 1, sourceSha256: 'a'.repeat(64), ready: true })) };
  const facts = { complete: true, stale: false, digest: 'unchanged-business-facts' };
  const adapter = {
    async readFacts() { count.reads++; return facts; }, async cachedFacts() { return facts; },
    async prepare(article, key) { return { request: { clientRequestId: key, originSessionId: key }, outputDirectory: root }; },
    async submit(operation) {
      count.submitted++;
      if (!executions.has(operation.key)) { executions.set(operation.key, { jobId: operation.key, attemptId: operation.key }); count.uniqueExecutions++; }
      if (loseSubmit) { loseSubmit = false; throw new Error('response lost after acceptance'); }
      return executions.get(operation.key);
    },
    async get() { return { submissionStatus: 'accepted', executionStatus: completed ? 'completed' : 'working', stale: false }; },
    async verify() { count.verified++; return { packageDigest: 'verified-package' }; },
    async ingest() { count.ingested++; if (failWrite) { failWrite = false; throw new Error('cloud write unknown'); } return { id: 'real-asset' }; },
    assetStatus(operation) { return operation.phase === 'ready' ? 'ready' : 'pending_review'; }, async acceptAndAcknowledge() {},
  };
  const bridge = await new StockBridge(config, adapter, () => clock).initialize();
  return { root, config, adapter, bridge, count, facts, now: () => clock, tick: () => { clock += minimumIntervalMs; },
    complete: () => { completed = true; }, failWrite: () => { failWrite = true; }, loseSubmit: () => { loseSubmit = true; } };
}
const apply = async bridge => { const observed = await bridge.observe(); assert.equal(observed.due, true);
  return bridge.apply({ observationId: observed.observationId, advice: evaluateStock(observed.input) }); };

test('AP duplicates share one occupied slot and a persisted 30-minute admission limit', async t => {
  const f = await fixture(t), observed = await f.bridge.observe(), advice = evaluateStock(observed.input);
  const [a, b] = await Promise.all([f.bridge.apply({ observationId: observed.observationId, advice }), f.bridge.apply({ observationId: observed.observationId, advice })]);
  assert.deepEqual(a, b); assert.equal(f.count.uniqueExecutions, 1);
  assert.equal((await f.bridge.observe()).due, false);
  const restored = await new StockBridge(f.config, f.adapter, f.now).initialize();
  assert.equal((await restored.observe()).due, false);
  f.tick(); assert.equal((await apply(restored)).action, 'wait_task'); assert.equal(f.count.uniqueExecutions, 1);
});

test('lost gateway acceptance replays the original request across restart, without a second execution', async t => {
  const f = await fixture(t); f.loseSubmit();
  assert.equal((await apply(f.bridge)).phase, 'dispatch_unknown');
  const restored = await new StockBridge(f.config, f.adapter, f.now).initialize(); f.tick();
  assert.equal((await apply(restored)).action, 'wait_task');
  assert.equal(f.count.submitted, 2); assert.equal(f.count.uniqueExecutions, 1);
});

test('a completed job with failed writeback keeps its slot and resumes only the original write', async t => {
  const f = await fixture(t); await apply(f.bridge); f.complete(); f.failWrite(); f.tick();
  const observed = await f.bridge.observe(); assert.equal(observed.input.snapshot.complete, false);
  assert.equal(Object.values(f.bridge.state.operations)[0].phase, 'write_pending');
  assert.equal(f.count.verified, 1); assert.equal(f.count.uniqueExecutions, 1);
  const restored = await new StockBridge(f.config, f.adapter, f.now).initialize(); f.tick();
  const next = await restored.observe(); assert.equal(next.input.snapshot.pendingReview, 1); assert.equal(next.input.snapshot.inFlight, 0);
  assert.equal(f.count.verified, 1); assert.equal(f.count.ingested, 2);
});

test('changed business facts or forged AP advice cannot dispatch', async t => {
  const f = await fixture(t), observed = await f.bridge.observe(), advice = evaluateStock(observed.input);
  await assert.rejects(f.bridge.apply({ observationId: observed.observationId, advice: { ...advice, targetId: 'other-role' } }), /Advice differs/);
  f.facts.digest = 'human-changed-stock';
  await assert.rejects(f.bridge.apply({ observationId: observed.observationId, advice }), /facts changed/);
  assert.equal(f.count.uniqueExecutions, 0);
});

test('production configuration rejects an interval shorter than 30 minutes', async t => {
  const f = await fixture(t);
  assert.throws(() => new StockBridge({ ...f.config, policy: { ...f.config.policy, checkIntervalMs: minimumIntervalMs - 1 } }, f.adapter), /1800000/);
});

test('invalid completed delivery pauses the rule and never admits another production action', async t => {
  const f = await fixture(t); await apply(f.bridge); f.complete(); f.tick();
  f.adapter.verify = async () => { throw new Error('Final bytes do not match host receipt'); };
  const observation = await f.bridge.observe();
  assert.equal(observation.input.policy.paused, true);
  assert.equal(Object.values(f.bridge.state.operations)[0].phase, 'delivery_invalid');
  assert.equal((await f.bridge.apply({ observationId: observation.observationId, advice: evaluateStock(observation.input) })).action, 'paused');
  assert.equal(f.count.uniqueExecutions, 1);
});

test('network bridge requires its dedicated credential and never exposes arbitrary gateway invocation', async t => {
  const f = await fixture(t), token = 'test-only-bridge-key-'.repeat(3), server = bridgeServer(f.bridge, token);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await fetch(base + '/status')).status, 401);
  assert.equal((await fetch(base + '/invoke', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status, 404);
  assert.equal((await fetch(base + '/observe', { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: base } })).status, 403);
});
