import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StockBridge, minimumIntervalMs } from './bridge.mjs';
import { evaluateStock } from './policy.mjs';
import { bridgeServer } from './server.mjs';
import { continuousCycle, continuousRunner } from './continuous.mjs';

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

test('transient stale status retains three original jobs and automatically recovers legacy sync pause', async t => {
  const f = await fixture(t); Object.assign(f.config.policy, { mode: 'catalog_batch', maxConcurrent: 3, continuous: true, checkIntervalMs: 5000 });
  await continuousCycle(f.bridge);
  const originals = Object.values(f.bridge.state.operations), key = originals[2].key;
  const get = f.adapter.get; let offline = true;
  f.adapter.get = async o => ({ ...await get(o), stale: offline && o.key === key });
  assert.equal((await continuousCycle(f.bridge)).action, 'wait_facts');
  assert.equal(f.bridge.state.pausedReason, undefined); assert.equal(f.count.uniqueExecutions, 3);
  assert.equal(f.bridge.status().syncPending.length, 1);
  f.bridge.state.pausedReason = `任务受理或状态待核对：${key}`;
  offline = false;
  assert.equal((await continuousCycle(f.bridge)).action, 'wait_task');
  assert.equal(f.bridge.state.pausedReason, undefined); assert.equal(f.bridge.status().syncPending.length, 0);
  assert.equal(f.count.submitted, 3); assert.equal(f.count.uniqueExecutions, 3);
  f.bridge.state.pausedReason = '成品审核退回';
  assert.equal((await continuousCycle(f.bridge)).action, 'paused');
});

test('continuous mode starts now and refills completed positions without the old 30-minute wait', async t => {
  const f = await fixture(t); Object.assign(f.config.policy, { mode: 'catalog_batch', maxConcurrent: 3, continuous: true, checkIntervalMs: 5000 });
  f.config.catalog = f.config.catalog.slice(0, 4);
  f.bridge.state.nextCheckAt = f.now() + minimumIntervalMs;
  assert.equal((await continuousCycle(f.bridge)).operations.length, 3);
  f.complete();
  assert.equal((await continuousCycle(f.bridge)).operations.length, 1);
  assert.equal(f.count.ingested, 1, 'refill the first released slot before processing other completed deliveries');
  assert.equal(f.count.uniqueExecutions, 4);
  await continuousCycle(f.bridge); await continuousCycle(f.bridge);
  assert.equal((await continuousCycle(f.bridge)).action, 'complete_catalog');
  assert.equal(f.count.uniqueExecutions, 4);
});

test('continuous runner persists its start and deduplicates simultaneous startup requests', async t => {
  const f = await fixture(t); Object.assign(f.config.policy, { mode: 'catalog_batch', maxConcurrent: 3, continuous: true, checkIntervalMs: 5000 });
  const runner = continuousRunner(f.bridge); t.after(() => runner.stop());
  const results = await Promise.all([runner.start(), runner.start()]);
  assert.equal(f.count.uniqueExecutions, 3); assert.deepEqual(results[0], results[1]);
  assert.equal(f.bridge.state.continuousStarted, true);
  const restored = await new StockBridge(f.config, f.adapter, f.now).initialize();
  assert.equal(restored.state.continuousStarted, true);
});

test('catalog batch reserves three, ignores review stock limits, and refills only free slots', async t => {
  const f = await fixture(t); f.config.policy.mode = 'catalog_batch'; f.config.policy.maxConcurrent = 3;
  const first = await apply(f.bridge);
  assert.equal(first.operations.length, 3); assert.equal(f.count.uniqueExecutions, 3);
  const original = Object.values(f.bridge.state.operations)[0];
  original.phase = 'pending_review'; original.asset = { id: 'accepted-existing' }; original.noticeHandled = true;
  f.tick(); const second = await apply(f.bridge);
  assert.equal(second.operations.length, 1); assert.equal(f.count.uniqueExecutions, 4);
  assert.equal(Object.values(f.bridge.state.operations).filter(o => o.phase === 'working').length, 3);
  const restored = await new StockBridge(f.config, f.adapter, f.now).initialize(); f.tick();
  assert.equal((await apply(restored)).action, 'wait_task'); assert.equal(f.count.uniqueExecutions, 4);
  const input = restored.input(f.facts); input.snapshot.pendingReview = 99; input.snapshot.ready = 99; input.snapshot.inFlight = 0;
  assert.equal(evaluateStock(input).action, 'dispatch_batch');
  input.nextArticles = []; input.catalogExhausted = true;
  assert.equal(evaluateStock(input).action, 'complete_catalog');
});

test('catalog batch duplicate apply and lost acceptance keep at most three original jobs', async t => {
  const f = await fixture(t); f.config.policy.mode = 'catalog_batch'; f.config.policy.maxConcurrent = 3; f.loseSubmit();
  const observed = await f.bridge.observe(), input = { observationId: observed.observationId, advice: evaluateStock(observed.input) };
  const [a,b] = await Promise.all([f.bridge.apply(input), f.bridge.apply(input)]);
  assert.deepEqual(a,b); assert.equal(f.count.uniqueExecutions,3);
  const restored = await new StockBridge(f.config,f.adapter,f.now).initialize(); f.tick();
  assert.equal((await apply(restored)).action,'wait_task'); assert.equal(f.count.uniqueExecutions,3);
});

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

test('explicit delivery repair reuses the same job and resumes review without submitting again', async t => {
  const f = await fixture(t); await apply(f.bridge); f.complete(); f.tick();
  const original = f.adapter.verify;
  f.adapter.verify = async () => { throw new Error('legacy report shape'); };
  await f.bridge.observe();
  const operation = Object.values(f.bridge.state.operations)[0], jobId = operation.job.jobId;
  await assert.rejects(f.bridge.recoverDelivery('unknown'), /original delivery pause/);
  f.adapter.verify = original;
  const status = await f.bridge.recoverDelivery(operation.key);
  assert.equal(status.pausedReason, null);
  assert.equal(status.operations[0].phase, 'pending_review');
  assert.equal(status.operations[0].jobId, jobId);
  assert.equal(f.count.uniqueExecutions, 1); assert.equal(f.count.submitted, 1);
  assert.equal((await f.bridge.observe()).due, false, 'recovery preserves the 30-minute observation limit');
});
