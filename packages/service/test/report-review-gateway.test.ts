import { testCapacity } from './capacity-fixture.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Task } from '@a2a-js/sdk';
import { RemoteAgentGateway, type A2AGatewayConfig } from '../src/a2a/gateway.js';
import { createA2AServer } from '../src/a2a/server.js';
import type { A2APreflightInput, A2ABackend, A2APrepareInput, A2ARunResult, A2ATarget } from '../src/a2a/types.js';

class Backend implements A2ABackend {
  beforePrepare?: () => Promise<void>;
  async preflight(input: A2APreflightInput) { return { ok: true, cwd: input.cwd, checkedAt: new Date().toISOString(), checks: [{ id: 'fixture-host', ok: true }] }; }
  readonly runs: Array<{ target: A2ATarget; prompt: string; signal: AbortSignal; finish: (result: A2ARunResult) => void }> = [];
  async prepare(input: A2APrepareInput): Promise<A2ATarget> {
    await this.beforePrepare?.();
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
  const done = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await done;
}
async function until<T>(operation: () => Promise<T>, predicate: (result: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await operation(); if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error('Execution gateway test condition deadline');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'execution-gateway-')), backend = new Backend();
  let host: Awaited<ReturnType<typeof createA2AServer>>;
  const server = createServer((req, res) => {
    if (req.url === '/.well-known/agent-card.json') host.cardHandler(req, res);
    else void host.handler(req, res);
  });
  const url = await listen(server);
  host = await createA2AServer({ backend, capacity: testCapacity(root), publicUrl: url, stateDirectory: join(root, 'host'), token: 'test-token' });
  const stateDirectory = join(root, 'client');
  const config: A2AGatewayConfig = { stateDirectory, port: 0, remotes: { local: { url, token: 'test-token' } }, pollIntervalMs: 60_000 };
  const gateways = new Set<RemoteAgentGateway>();
  t.after(async () => {
    for (const gateway of gateways) await gateway.close();
    await host.close(); await stop(server); await rm(root, { recursive: true, force: true });
  });
  return { root, stateDirectory, backend, config, gateway: () => {
    const gateway = new RemoteAgentGateway(config); gateways.add(gateway); return gateway;
  } };
}
async function reportFixture(t: TestContext, fileName = 'architecture-report.md') {
  const f = await fixture(t);
  f.config.workbench = { token: 'human-only', reviewerId: 'owner' };
  f.config.reportReview = { workspaceRoot: join(f.root, 'reports'), allowedProjectRoots: [f.root], allowedRemotes: ['local'] };
  let gateway = f.gateway();
  const input = { originSessionId: 'delegator', targetId: 'legacy:local', title: '架构分析测试', clientRequestId: 'report-1',
    input: { cwd: f.root, agentPreset: 'standard', prompt: '只读分析项目架构', reportReview: { fileName } } };
  const parent = await gateway.invoke('execution_submit', input) as any;
  const run = () => (gateway as any).state.reportReviews[parent.attemptId];
  const tickUntil = (predicate: () => boolean) => until(async () => { await gateway.reconcile(); return predicate(); }, Boolean);
  const completeAuthor = async (markdown: string | null = '# 架构分析\n\n项目入口 src/index.ts，负责启动服务。') => {
    await tickUntil(() => f.backend.runs.length >= run().revision);
    const author = f.backend.runs.at(-1)!;
    assert.equal(author.target.cwd, run().directory, 'temporary author runs inside its assigned writable workspace');
    assert.ok(!relative(author.target.cwd, run().reportPath).startsWith('..'), 'report must be writable without sandbox escalation');
    if (markdown !== null) await writeFile(run().reportPath, markdown);
    f.backend.runs.at(-1)!.finish({ outcome: 'completed', text: 'Report saved' });
    await tickUntil(() => ['input_required', 'failed'].includes(run().executionStatus));
  };
  const decide = async (action: string, note?: string, clientRequestId = `${action}-${run().revision}`) => {
    const review = run().humanReviews.at(-1);
    return gateway.decideWorkbenchReview(parent.jobId, review.reviewId, { action, revision: review.revision, digest: review.digest, clientRequestId, ...(note ? { note } : {}) });
  };
  return { ...f, parent, input, run, tickUntil, completeAuthor, decide, get current() { return gateway; },
    restart: async () => { await gateway.close(); gateway = f.gateway(); } };
}
test('temporary report waits for final human approval; neither author completion nor comments notify the delegator', async t => {
  const f = await reportFixture(t); await f.completeAuthor();
  assert.equal(f.run().executionStatus, 'input_required'); assert.equal(f.run().fileCheck.passed, true);
  const detail = f.current.workbenchTask(f.parent.jobId);
  assert.equal(detail.displayStatus, 'awaiting_human'); assert.equal(detail.reviews[0].stage, 'report');
  assert.equal(detail.reviews[0].preview.slides.length, 0); assert.equal(detail.reviews[0].canReview, true);
  assert.deepEqual(detail.progress.stages.map(s => s.stage), ['research', 'file_check', 'human_review']);
  assert.equal(detail.children.length, 1); assert.equal(detail.children[0].executionStatus, 'completed');
  assert.equal(f.backend.runs.length, 1, 'no agent reviewer');
  assert.deepEqual(await f.current.invoke('execution_inbox', { originSessionId: 'delegator' }), { notices: [] });
  assert.deepEqual(await f.current.invoke('remote_agent_inbox', { originSessionId: 'delegator' }), { notices: [] });
  await f.decide('comment', '补充备注即可'); await f.current.reconcile();
  assert.equal(f.run().executionStatus, 'input_required');
  await f.decide('approve'); await f.current.reconcile();
  assert.equal(f.run().executionStatus, 'completed');
  const inbox = await f.current.invoke('execution_inbox', { originSessionId: 'delegator' }) as any;
  assert.equal(inbox.notices.length, 1); assert.equal(inbox.notices[0].executionStatus, 'completed');
  assert.match(inbox.notices[0].resultSummary, /人工已通过/); assert.equal(f.backend.runs.length, 1);
});
test('missing report fails the machine check without opening human review', async t => {
  const f = await reportFixture(t); await f.completeAuthor(null);
  assert.equal(f.run().executionStatus, 'failed'); assert.equal(f.run().phase, 'file_check_failed');
  assert.equal(f.run().humanReviews.length, 0); assert.equal(f.run().fileCheck.passed, false);
});
test('changed bytes and symlinks cannot be approved as the frozen report', async t => {
  const f = await reportFixture(t); await f.completeAuthor();
  await writeFile(f.run().reportPath, '# Changed'); await assert.rejects(f.decide('approve'), /changed or are unavailable/);
  await rm(f.run().reportPath); await symlink(f.run().snapshotPath, f.run().reportPath);
  await assert.rejects(f.decide('approve'), /changed or are unavailable/);
  assert.equal(f.run().humanReviews[0].status, 'pending'); assert.equal(f.run().executionStatus, 'input_required');
});
test('human changes reuse the temporary author, retain history and require a fresh approval', async t => {
  const f = await reportFixture(t); await f.completeAuthor();
  const first = structuredClone(f.run().humanReviews[0]), firstPath = f.run().reportPath, original = await readFile(firstPath, 'utf8');
  await f.decide('changes_requested', '补充服务入口的调用关系');
  await f.tickUntil(() => f.backend.runs.length === 2);
  assert.equal(f.backend.runs[1].target.sessionId, f.backend.runs[0].target.sessionId);
  assert.match(f.backend.runs[1].prompt, /补充服务入口/); assert.match(f.run().reportPath, /report-v2/);
  assert.equal(await readFile(firstPath, 'utf8'), original);
  await f.completeAuthor('# 新版架构分析\n\nsrc/index.ts 调用 server.start。');
  assert.equal(f.run().humanReviews.length, 2); assert.equal(f.run().executionStatus, 'input_required');
  await assert.rejects(f.current.decideWorkbenchReview(f.parent.jobId, first.reviewId, { action: 'approve', revision: first.revision, digest: first.digest, clientRequestId: 'stale-click' }), /replaced/);
  await f.decide('approve'); await f.current.reconcile(); assert.equal(f.run().executionStatus, 'completed');
});
test('pending reviews survive restart; replayed approval and submit never duplicate execution or notification', async t => {
  const f = await reportFixture(t);
  const replay = await f.current.invoke('execution_submit', f.input) as any; assert.equal(replay.jobId, f.parent.jobId);
  await f.completeAuthor(); const reviewId = f.run().humanReviews[0].reviewId;
  await f.restart(); assert.equal(f.current.workbenchTask(f.parent.jobId).pendingReviewId, reviewId);
  await f.decide('approve'); await f.current.reconcile(); await f.decide('approve'); await f.current.reconcile();
  await f.restart(); await f.current.reconcile();
  const inbox = await f.current.invoke('execution_inbox', { originSessionId: 'delegator' }) as any;
  assert.equal(inbox.notices.length, 1); assert.equal(f.backend.runs.length, 1);
});
test('canceling a running report closes the parent and its delegated author', async t => {
  const f = await reportFixture(t); await f.tickUntil(() => f.backend.runs.length === 1);
  await f.current.invoke('execution_cancel', { originSessionId: 'delegator', jobId: f.parent.jobId });
  await f.current.reconcile(); assert.equal(f.run().executionStatus, 'canceled');
  const result = await f.current.invoke('execution_get', { originSessionId: 'delegator', jobId: f.parent.jobId }) as any;
  assert.equal(result.executionStatus, 'canceled'); assert.equal(result.cancellation.status, 'completed'); assert.equal(f.backend.runs.length, 1);
});

test('an English README uses its requested file name and language inside the writable workspace', async t => {
  const f = await reportFixture(t, 'README.en.md');
  await f.completeAuthor('# English README\n\nA short project introduction based on the source README.');
  assert.ok(f.run().reportPath.endsWith('/README.en.md'));
  assert.ok(!f.backend.runs[0].prompt.includes('完整中文'));
  assert.match(f.backend.runs[0].prompt, /语言与内容按任务说明执行/);
  assert.equal(f.run().executionStatus, 'input_required');
  assert.equal(f.run().fileCheck.passed, true);
});
