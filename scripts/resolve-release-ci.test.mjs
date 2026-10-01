import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRun, validateRun } from './resolve-release-ci.mjs';
const sha = 'a'.repeat(40);
const context = { sha, workflowId: 7, repository: 'owner/repo' };
const good = { id: 11, head_sha: sha, workflow_id: 7, event: 'push', head_branch: 'main', head_repository: { full_name: 'owner/repo' }, status: 'completed', conclusion: 'success' };

test('release rejects wrong commits, forks, PRs, other workflows and failed CI', () => {
  assert.equal(validateRun(good, context), '11');
  for (const override of [{ head_sha: 'b'.repeat(40) }, { workflow_id: 8 }, { event: 'pull_request' }, { head_branch: 'feature' }, { head_repository: { full_name: 'fork/repo' } }, { status: 'in_progress' }, { conclusion: 'failure' }]) {
    assert.throws(() => validateRun({ ...good, ...override }, context));
  }
});

test('release waits for existing CI and never starts another validation', async () => {
  const calls = [];
  let reads = 0;
  const request = async path => {
    calls.push(path);
    if (path === '/actions/workflows/ci.yml') return { id: 7 };
    if (path.includes('?')) return { workflow_runs: [++reads === 1 ? { ...good, status: 'in_progress', conclusion: null } : good] };
    throw new Error(`Unexpected request: ${path}`);
  };
  assert.equal(await resolveRun({ ...context, request, pause: async () => {}, attempts: 2 }), '11');
  assert.equal(reads, 2);
  assert.equal(calls.some(path => path.startsWith('/actions/runs/')), false);
});

test('automatic release uses successful same-SHA CI ahead of failed or pending runs', async () => {
  for (const newer of [{ ...good, id: 12, conclusion: 'failure' }, { ...good, id: 12, status: 'in_progress', conclusion: null }]) {
    assert.equal(await resolveRun({ ...context, attempts: 1, request: async path =>
      path.endsWith('ci.yml') ? { id: 7 } : { workflow_runs: [newer, good] } }), '11');
  }
});

test('automatic release rechecks all runs while waiting instead of pinning a pending run', async () => {
  let reads = 0;
  const pending = { ...good, id: 12, status: 'in_progress', conclusion: null };
  assert.equal(await resolveRun({ ...context, attempts: 2, pause: async () => {}, request: async path => {
    if (path.endsWith('ci.yml')) return { id: 7 };
    assert(path.includes('?'));
    return { workflow_runs: ++reads === 1 ? [pending] : [pending, good] };
  } }), '11');
});

test('explicit failed run does not fall back to a different successful run', async () => {
  await assert.rejects(resolveRun({ ...context, runId: '12', attempts: 1, request: async path => {
    if (path.endsWith('ci.yml')) return { id: 7 };
    assert.equal(path, '/actions/runs/12');
    return { ...good, id: 12, conclusion: 'failure' };
  } }), /CI did not pass/);
});

test('release fails when no CI exists instead of rebuilding', async () => {
  await assert.rejects(resolveRun({ ...context, request: async path => path.endsWith('ci.yml') ? { id: 7 } : { workflow_runs: [] }, attempts: 1 }), /No successful CI/);
});

test('explicit run IDs from other commits are rejected before waiting', async () => {
  await assert.rejects(resolveRun({ ...context, runId: '11', request: async path =>
    path.endsWith('ci.yml') ? { id: 7 } : { ...good, head_sha: 'b'.repeat(40), status: 'in_progress' },
    pause: async () => { throw new Error('Should not wait'); }, attempts: 2 }), /CI commit differs/);
});
