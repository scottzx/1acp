import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Task } from '@a2a-js/sdk';
import { REMOTE_AGENT_METHODS, serveA2AGateway, type A2AGatewayConfig } from '../src/a2a/gateway.js';
import { createHumanReview } from '../src/execution/human-review.js';
import { createPptDeliveryRun, scriptDirectory, type PptDeliveryRun } from '../src/execution/ppt-delivery.js';

const token = 'independent-workbench-test-credential';
const preview = { title: '待审核文字稿', slides: Array.from({ length: 6 }, (_, i) => ({
  title: `第 ${i + 1} 页`, message: '项目事实', body: ['完整文字内容'], visual: '流程示意',
  sources: ['README.md:1'], facts: ['基于项目文件'], notes: '',
})) };

async function fixture(t: TestContext, workbench = true) {
  const root = await mkdtemp(join(tmpdir(), 'workbench-gateway-'));
  const config: A2AGatewayConfig = { stateDirectory: join(root, 'state'), port: 0, remotes: {}, pollIntervalMs: 60_000,
    ...(workbench ? { workbench: { token, reviewerId: 'local-owner', reviewerName: '本机用户', allowedOrigins: ['allowed-root'] } } : {}) };
  let host = await serveA2AGateway(config, { report: false });
  // The constructor's initial reconcile is empty; no background dispatch is
  // involved in this HTTP admission/identity fixture.
  await new Promise<void>(resolve => setImmediate(resolve));
  let kicks = 0;
  (host.gateway as any).advanceDelivery = async () => { kicks++; };
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });

  const seed = async (originSessionId: string, title: string) => {
    const gateway = host.gateway, internals = gateway as any;
    const parent = gateway.ledger.prepare({ originSessionId, title,
      targetSnapshot: { targetId: 'delivery', provider: 'resident_role', roleId: 'delivery' },
      input: { prompt: 'private-prompt-must-not-leak', internalInput: 'private-input-must-not-leak' } });
    gateway.ledger.markDispatching(parent.attempt.attemptId);
    gateway.ledger.accept(parent.attempt.attemptId, { provider: 'resident_role', runId: parent.attempt.attemptId },
      { executionStatus: 'input_required', phase: 'awaiting_human' });
    const author = gateway.ledger.prepare({ originSessionId, title: `${title}：文稿`,
      targetSnapshot: { targetId: 'author', provider: 'a2a', roleId: 'author' }, input: {},
      parentJobRef: { sourceId: gateway.ledger.sourceId, jobId: parent.job.jobId }, parentAttemptId: parent.attempt.attemptId,
      purpose: 'project_script', resultRevision: 'script-v1' });
    gateway.ledger.markDispatching(author.attempt.attemptId);
    gateway.ledger.accept(author.attempt.attemptId, { taskId: 'author-task', sessionId: 'author-session' }, { executionStatus: 'completed' });
    const run = await createPptDeliveryRun({ sourceId: gateway.ledger.sourceId, jobId: parent.job.jobId,
      attemptId: parent.attempt.attemptId, originSessionId, input: { projectDirectory: root, projectName: title },
      policy: { workspaceRoot: join(root, 'jobs'), publicDirectory: join(root, 'public'), publicBaseUrl: 'http://127.0.0.1:1/artifacts',
        allowedProjectRoots: [root], summaryTargetId: 'author', makerTargetId: 'maker', reviewTargetId: 'quality',
        runtimeDocument: join(root, 'RUNTIME.md'), designSkill: join(root, 'SKILL.md'), pythonExecutable: '/usr/bin/python3' } });
    run.executionStatus = 'input_required'; run.stage = 'summary'; run.phase = 'awaiting_human';
    run.children.push({ purpose: 'project_script', revision: 1, targetId: 'author', child: {
      jobId: author.job.jobId, attemptId: author.attempt.attemptId, executionStatus: 'completed', submissionStatus: 'accepted', sessionId: 'author-session',
    } });
    await mkdir(scriptDirectory(run), { recursive: true });
    const bytes = JSON.stringify(preview), scriptPath = join(scriptDirectory(run), 'slide-script.json');
    await writeFile(scriptPath, bytes);
    run.scriptDigest = createHash('sha256').update(bytes).digest('hex');
    run.humanWaitStartedAt = new Date(Date.now() - 60_000).toISOString();
    const review = createHumanReview({ jobId: run.jobId, attemptId: run.attemptId, stage: 'summary',
      authorJobId: author.job.jobId, authorAttemptId: author.attempt.attemptId, authorSessionId: 'author-session',
      title: `${title}：6页文字稿`, revision: 'script-v1', digest: run.scriptDigest, preview, reviewerId: 'local-owner' });
    run.humanReviews = [review];
    internals.state.pptDeliveries.runs[run.attemptId] = run; internals.save();
    return { jobId: run.jobId, authorJobId: author.job.jobId, run, review, scriptPath,
      decision: { action: 'comment', revision: review.revision, digest: review.digest, clientRequestId: 'request-1', note: '第 2 页请补充依据。' } };
  };
  const request = (path: string, init: RequestInit = {}, credential: string | null = token) => fetch(`http://127.0.0.1:${host.port}` + path, {
    ...init, headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...(init.headers ?? {}) },
  });
  return { root, config, seed, request, get gateway() { return host.gateway; }, get kicks() { return kicks; },
    restart: async () => { await host.close(); host = await serveA2AGateway(config, { report: false }); (host.gateway as any).advanceDelivery = async () => { kicks++; }; },
  };
}

const decisions = (jobId: string, reviewId: string) => `/workbench/tasks/${jobId}/reviews/${reviewId}/decisions`;
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('workbench HTTP is disabled without configuration and requires its separate credential', async t => {
  const disabled = await fixture(t, false);
  assert.equal((await disabled.request('/workbench/tasks')).status, 503);
  const f = await fixture(t);
  assert.equal((await f.request('/workbench/tasks', {}, null)).status, 401);
  assert.equal((await f.request('/workbench/tasks', {}, 'agent-remote-token')).status, 401);
  assert.equal((await f.request('/workbench/tasks', { headers: { Origin: 'http://web.example' } })).status, 403);
  const response = await f.request('/workbench/tasks');
  assert.equal(response.status, 200); assert.deepEqual((await response.json() as any).items, []);
  assert.ok(!Object.keys(REMOTE_AGENT_METHODS).some(method => /workbench|human.*decision/.test(method)));
  const invoke = await f.request('/invoke', post({ method: 'decideWorkbenchReview', params: {} }), null);
  assert.equal(invoke.status, 400);
});

test('workbench list and detail are scoped pure projections without private execution input', async t => {
  const f = await fixture(t), allowed = await f.seed('allowed-root', '可见项目'), hidden = await f.seed('private-root', '隐藏项目');
  const before = f.gateway.ledger.snapshot();
  const list = await f.request('/workbench/tasks?filter=pending&limit=50&offset=0');
  assert.equal(list.status, 200);
  const listed = await list.json() as any;
  assert.equal(listed.items.length, 1); assert.equal(listed.items[0].jobId, allowed.jobId);
  assert.equal(listed.counts.pending, 1);
  const detailResponse = await f.request(`/workbench/tasks/${allowed.jobId}`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json() as any;
  assert.equal(detail.displayStatus, 'awaiting_human'); assert.equal(detail.children[0].jobId, allowed.authorJobId);
  assert.equal(detail.children[0].executionStatus, 'completed'); assert.equal(detail.reviews[0].canReview, true);
  assert.equal(detail.progress.stages.find((s: any) => s.stage === 'make').planned, true);
  assert.ok(detail.progress.humanWaitingMs >= 60_000);
  const encoded = JSON.stringify(detail);
  assert.ok(!encoded.includes('private-prompt-must-not-leak')); assert.ok(!encoded.includes('private-input-must-not-leak'));
  assert.ok(!encoded.includes(token)); assert.ok(!encoded.includes(hidden.jobId));
  assert.equal((await f.request(`/workbench/tasks/${hidden.jobId}`)).status, 404);
  assert.equal((await f.request('/workbench/tasks?originSessionId=private-root')).status, 400);
  assert.deepEqual(f.gateway.ledger.snapshot(), before); assert.equal(f.kicks, 0);
});

test('human comments retain waiting state, use configured identity and replay durably once', async t => {
  const f = await fixture(t), item = await f.seed('allowed-root', '评论任务'), path = decisions(item.jobId, item.review.reviewId);
  const first = await f.request(path, post(item.decision));
  assert.equal(first.status, 200);
  const detail = await first.json() as any, recorded = detail.reviews[0].history[0];
  assert.equal(detail.displayStatus, 'awaiting_human'); assert.equal(detail.reviews[0].status, 'pending');
  assert.deepEqual(recorded.actor, { id: 'local-owner', displayName: '本机用户', source: '1agents-web' });
  assert.equal(recorded.note, item.decision.note); assert.equal(f.kicks, 0);
  const replay = await f.request(path, post(item.decision));
  const replayed = await replay.json() as any;
  assert.equal(replayed.reviews[0].history.length, 1); assert.equal(replayed.reviews[0].history[0].decisionId, recorded.decisionId);
  const conflict = await f.request(path, post({ ...item.decision, note: '换了内容，不能沿用幂等标识。' }));
  assert.equal(conflict.status, 409); assert.equal((await conflict.json() as any).error, 'idempotency_conflict');
  await f.restart();
  const afterRestart = await f.request(path, post(item.decision));
  assert.equal(afterRestart.status, 200);
  const durable = await afterRestart.json() as any;
  assert.equal(durable.reviews[0].history.length, 1); assert.equal(durable.reviews[0].history[0].decisionId, recorded.decisionId);
});

test('workbench rejects client identity, wrong version, unauthorized reviewer and changed frozen bytes', async t => {
  const f = await fixture(t), item = await f.seed('allowed-root', '版本任务'), path = decisions(item.jobId, item.review.reviewId);
  const identity = await f.request(path, post({ ...item.decision, actor: { id: 'forged-human', source: '1agents-web' } }));
  assert.equal(identity.status, 400);
  const wrong = await f.request(path, post({ ...item.decision, revision: 'script-v0' }));
  assert.equal(wrong.status, 409); assert.equal((await wrong.json() as any).error, 'version_conflict');
  item.run.humanReviews![0]!.reviewerId = 'another-person';
  const otherPerson = await f.request(path, post(item.decision));
  assert.equal(otherPerson.status, 403);
  item.run.humanReviews![0]!.reviewerId = 'local-owner';
  await writeFile(item.scriptPath, JSON.stringify({ ...preview, title: '被替换的内容' }));
  const changedBytes = await f.request(path, post(item.decision));
  assert.equal(changedBytes.status, 409); assert.equal((await changedBytes.json() as any).error, 'version_conflict');
  assert.equal(item.run.humanReviews![0]!.history.length, 0); assert.equal(f.kicks, 0);
});

test('old review cannot approve a new version and repeated approval records one durable intent', async t => {
  const f = await fixture(t), item = await f.seed('allowed-root', '批准任务'), path = decisions(item.jobId, item.review.reviewId);
  const old = structuredClone(item.review);
  old.reviewId = 'old-review'; old.revision = 'script-v0'; old.status = 'superseded';
  item.run.humanReviews!.unshift(old);
  const stale = await f.request(decisions(item.jobId, old.reviewId), post({ ...item.decision, action: 'approve', revision: old.revision }));
  assert.equal(stale.status, 409);
  const approvedInput = { ...item.decision, action: 'approve', note: undefined };
  const approved = await f.request(path, post(approvedInput));
  assert.equal(approved.status, 200);
  const first = await approved.json() as any, current = first.reviews.find((r: any) => r.reviewId === item.review.reviewId);
  assert.equal(current.status, 'approved'); assert.equal(current.resume.status, 'pending'); assert.equal(current.history.length, 1);
  const again = await f.request(path, post(approvedInput));
  assert.equal(again.status, 200);
  const replayed = (await again.json() as any).reviews.find((r: any) => r.reviewId === item.review.reviewId);
  assert.equal(replayed.history.length, 1); assert.equal(replayed.history[0].decisionId, current.history[0].decisionId);
  const persisted = JSON.parse(await readFile(join(f.config.stateDirectory, 'gateway.json'), 'utf8'));
  const run: PptDeliveryRun = persisted.pptDeliveries.runs[item.run.attemptId];
  const review = run.humanReviews!.find(r => r.reviewId === item.review.reviewId)!;
  assert.equal(review.resume!.decisionId, current.history[0].decisionId); assert.equal(review.status, 'approved');
  assert.equal(run.children.filter(child => child.purpose === 'ppt_production').length, 0);
});

test('canceling a waiting task removes its actionable review and pending view entry', async t => {
  const f = await fixture(t), item = await f.seed('allowed-root', '取消等待任务');
  await f.gateway.invoke('execution_cancel', { originSessionId: 'allowed-root', jobId: item.jobId });
  const response = await f.request(`/workbench/tasks/${item.jobId}`);
  assert.equal(response.status, 200);
  const detail = await response.json() as any;
  assert.equal(detail.executionStatus, 'canceled');
  assert.equal(detail.displayStatus, 'canceled');
  assert.ok(detail.reviews.every((review: any) => !review.canReview));
  const pending = await f.request('/workbench/tasks?filter=pending');
  assert.equal((await pending.json() as any).items.length, 0);
  const saved = JSON.parse(await readFile(join(f.config.stateDirectory, 'gateway.json'), 'utf8'));
  const canceledNotice = saved.executionNotices.find((notice: any) => notice.jobId === item.jobId && notice.executionStatus === 'canceled');
  assert.ok(canceledNotice);
  assert.match(canceledNotice.text, /任务已取消/);
  assert.doesNotMatch(canceledNotice.text, /文字稿待人工确认|打开文字稿审核/);
});

test('abandoning through human review closes further child dispatch admission', async t => {
  const f = await fixture(t), item = await f.seed('allowed-root', '人工放弃任务'), internals = f.gateway as any;
  internals.advanceDelivery = Object.getPrototypeOf(f.gateway).advanceDelivery;
  const response = await f.request(decisions(item.jobId, item.review.reviewId), post({ ...item.decision, action: 'cancel', note: undefined }));
  assert.equal(response.status, 200);
  await internals.advancingDeliveries.get(item.run.attemptId);
  assert.equal(f.gateway.workbenchTask(item.jobId).executionStatus, 'canceled');
  // A fake local transport makes any erroneous admission observable without
  // calling a model, a real remote service, or a production target.
  f.gateway.config.remotes.fixture = { url: 'http://127.0.0.1:1', token: 'machine-fixture-credential' };
  f.gateway.targets.ensureLegacyRemotes();
  let sends = 0;
  internals.checkDispatch = async () => {};
  internals.client = async () => ({ sendMessage: async () => {
    sends++;
    return Task.fromJSON({ id: 'forbidden-late-child', contextId: 'fixture-context', status: { state: 'TASK_STATE_WORKING' } });
  } });
  await assert.rejects(f.gateway.invoke('execution_submit', { originSessionId: 'allowed-root', targetId: 'legacy:fixture',
    input: { cwd: f.root, prompt: 'Should never dispatch after abandonment' },
    parentJobRef: { sourceId: f.gateway.ledger.sourceId, jobId: item.jobId }, parentAttemptId: item.run.attemptId,
  }), /closing or closed/);
  assert.equal(sends, 0);
});
