import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { evaluateStock } from './policy.mjs';
import { dryRunCode, dryRunFlow } from './flow.mjs';
import { observation, scenarios } from './scenarios.mjs';

for (const scenario of scenarios) test(scenario.name, () => {
  const input = structuredClone(scenario.input);
  assert.equal(evaluateStock(input).action, scenario.expectedAction);
  assert.deepEqual(input, scenario.input, 'advice must not mutate a persisted observation');
  assert.equal(evaluateStock(input).executionPerformed, false);
});

test('one replenishment episode survives approval crossing 10 and reserves only six new articles', () => {
  const state = observation();
  for (let article = 0; article < 6; article++) {
    state.nextArticle.articleKey = `article-${article}`;
    const advice = evaluateStock(state);
    assert.equal(advice.action, 'dispatch_next');
    state.batch = advice.nextBatch;
    state.snapshot.inFlight = 1;
    assert.equal(evaluateStock(state).action, 'wait_task');
    state.snapshot.inFlight = 0;
    state.snapshot.pendingReview++;
    if (article === 0) { state.snapshot.pendingReview--; state.snapshot.ready++; }
  }
  assert.equal(state.snapshot.ready, 10);
  assert.equal(state.snapshot.pendingReview, 5);
  assert.equal(evaluateStock(state).action, 'wait_review');
  state.snapshot.ready += state.snapshot.pendingReview;
  state.snapshot.pendingReview = 0;
  const completed = evaluateStock(state);
  assert.equal(completed.action, 'complete_batch');
  state.batch = completed.nextBatch;
  state.snapshot.ready = 10;
  assert.equal(evaluateStock(state).action, 'wait_stock');
  state.snapshot.ready = 9;
  assert.equal(evaluateStock(state).action, 'dispatch_next');
});

test('unusable facts never create production advice', () => {
  for (const patch of [
    { snapshot: { stale: true } }, { snapshot: { ready: -1 } }, { snapshot: { ready: 1.5 } },
    { snapshot: { pendingReview: undefined } }, { snapshot: { mode: 'production', sample: true } },
    { snapshot: { accountId: 'different-account' } },
  ]) assert.equal(evaluateStock(observation(patch)).shouldDispatch, false);
  assert.equal(evaluateStock(observation({ policy: { enabled: false } })).action, 'disabled');
});

test('operation identity survives repeated polls but changes for an explicit new content revision', () => {
  const first = observation(), later = observation({ observedAt: '2026-10-23T00:00:00+08:00', flowRunId: 'different-run' });
  assert.deepEqual(evaluateStock(first).actionIdentity, evaluateStock(later).actionIdentity);
  later.nextArticle.revision++;
  assert.notDeepEqual(evaluateStock(first).actionIdentity, evaluateStock(later).actionIdentity);
});

test('input conflicts, pending review exhaustion and frozen batch changes cannot dispatch', () => {
  assert.equal(evaluateStock(null).action, 'invalid_input');
  assert.equal(evaluateStock(observation({ policy: { targetStock: 10 } })).action, 'invalid_input');
  assert.equal(evaluateStock(observation({ batch: { active: true, accountId: 'simulation-account', targetStock: 12 } })).action, 'paused');
  assert.equal(evaluateStock(observation({ snapshot: { pendingReview: 1 }, nextArticle: null, catalogExhausted: true })).action, 'wait_review');
});

test('serialized AP code runs the same cases and refuses real snapshots and non-dry-run mode', async () => {
  const code = vm.runInNewContext(dryRunCode().replace('export const code =', 'const code =') + '\ncode;');
  const output = await code({ mode: 'dry_run', cases: scenarios });
  assert.equal(output.caseCount, 12); assert.equal(output.passed, true); assert.equal(output.executionPerformed, false);
  await assert.rejects(code({ mode: 'production', cases: scenarios }), /dry_run/);
  await assert.rejects(code({ mode: 'dry_run', cases: [{ input: observation({ snapshot: { mode: 'production', sample: false } }) }] }), /simulation/);
  assert.equal(dryRunFlow().steps.length, 1);
  assert.equal(dryRunFlow().steps[0].type, 'CODE');
});
