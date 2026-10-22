import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { advancePptDelivery, createPptDeliveryRun, validatePptDeliveryCandidate,
  preflightPptPublication, PptPublicationError, recoverPptDeliveryRun,
  type PptDeliveryAdapter, type PptDeliveryChild, type PptDeliveryChildRequest,
  type PptDeliveryRun, type PptDeliveryValidation } from '../src/execution/ppt-delivery.js';

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const execute = promisify(execFile);
const python = '/usr/bin/python3';
async function fixture(t: TestContext, extra: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ppt-delivery-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  const files = [];
  for (let i = 0; i < 6; i++) { const path = `source-${i}.md`, content = `project fact ${i}`; await writeFile(join(project, path), content); files.push({ path, sha256: hash(content) }); }
  let run = await createPptDeliveryRun({ sourceId: 'source', jobId: 'parent-job', attemptId: 'parent-attempt', originSessionId: 'root-session',
    input: { projectDirectory: project, projectName: 'Project', ...extra },
    policy: { workspaceRoot: join(root, 'jobs'), publicDirectory: join(root, 'public'), publicBaseUrl: 'http://127.0.0.1:1/artifacts',
      allowedProjectRoots: [project], summaryTargetId: 'summary', makerTargetId: 'maker', reviewTargetId: 'review',
      runtimeDocument: join(root, 'RUNTIME.md'), designSkill: join(root, 'SKILL.md'), pythonExecutable: python,
      maxRevisionRounds: 1, maxExecutionRetries: 0 } });
  for (const path of [run.policy.runtimeDocument, run.policy.designSkill]) await writeFile(path, 'fixture');
  const coordinator = join(run.jobDirectory, 'coordinator');
  await writeFile(join(coordinator, 'slide-script.json'), JSON.stringify({ title: 'Project', slides: files.map((file, i) => ({ title: `Page ${i}`, message: 'message', body: ['fact'], visual: 'diagram', sources: [`${file.path}:1`], facts: [`project fact ${i}`], notes: '' })) }));
  await writeFile(join(coordinator, 'source-manifest.json'), JSON.stringify({ projectDirectory: project, gitHead: 'unknown', gitStatus: '', files }));
  await writeFile(join(coordinator, 'project-summary.md'), 'summary'); await writeFile(join(coordinator, 'slide-script.md'), 'script');
  let saved = JSON.stringify(run), sequence = 0;
  const requests: PptDeliveryChildRequest[] = [], parents: Parameters<PptDeliveryAdapter['updateParent']>[0][] = [];
  const childStates = new Map<string, PptDeliveryChild>();
  const validation = (): PptDeliveryValidation => ({ status: 'passed', artifactDigest: String(run.revision).repeat(64), checkedAt: new Date().toISOString(),
    artifacts: [{ path: join(run.jobDirectory, `revision-${run.revision}`, 'project-overview.pptx'), url: 'http://example.invalid/final.pptx', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: 100, sha256: 'a'.repeat(64) },
      { path: join(run.jobDirectory, `revision-${run.revision}`, 'preview.png'), url: 'http://example.invalid/preview.png', mediaType: 'image/png', size: 30, sha256: 'b'.repeat(64) }],
    structure: { slideCount: 6, editableTextRuns: 100, shapes: 80, pictures: 0, aspectRatio: 16/9 }, checks: ['fixture injection'] });
  async function submitted(request: PptDeliveryChildRequest, prior?: PptDeliveryChild) {
    requests.push(structuredClone(request)); const id = ++sequence;
    const child: PptDeliveryChild = { jobId: prior?.jobId ?? `child-${id}`, attemptId: `attempt-${id}`, executionStatus: 'working',
      submissionStatus: 'accepted', sessionId: request.purpose === 'independent_review' ? `review-session-${id}` : request.purpose === 'ppt_production' ? 'maker-session' : 'summary-session' };
    childStates.set(child.attemptId, child); return structuredClone(child);
  }
  const adapter: PptDeliveryAdapter = {
    async persist(value) { saved = JSON.stringify(value); }, async submitChild(request) { return submitted(request); },
    async continueChild(request) { return submitted(request, request.child); },
    async getChild(child) { return structuredClone(childStates.get(child.attemptId)!); }, async ackChild() {},
    async updateParent(value) { parents.push(structuredClone(value)); }, async validateCandidate() { return validation(); },
    async preflightPublication() {},
  };
  const step = async () => { await advancePptDelivery(run, adapter); run = JSON.parse(saved); };
  async function completeCurrent(verdict = 'passed') {
    assert.ok(run.currentChild); const child = childStates.get(run.currentChild.attemptId)!; child.executionStatus = 'completed';
    if (run.stage === 'review') await writeFile(join(run.jobDirectory, `revision-${run.revision}`,
      run.recovery?.mode === 'review_only' ? `independent-review.${run.attemptId}.json` : 'independent-review.json'), JSON.stringify({
      verdict, artifactDigest: run.validation!.artifactDigest, factsChecked: true, allSlidesViewed: true,
      issues: verdict === 'passed' ? [] : ['Page 2: correct the boundary'], limitations: ['No native PowerPoint application verification'],
      evidence: ['preview.png', ...Array.from({ length: 6 }, (_, i) => `slide-${i + 1}.png`)]
        .map(filename => `read_image ${join(run.jobDirectory, `revision-${run.revision}`, filename)}`).concat('source-0.md:1') }));
    await step();
  }
  async function untilReview() {
    await step(); await completeCurrent(); // summary
    await step(); await completeCurrent(); // maker
    await step(); await step(); // deterministic -> review dispatched
    assert.equal(run.stage, 'review'); assert.ok(run.currentChild);
  }
  return { root, adapter, requests, parents, childStates, step, completeCurrent, untilReview, get run() { return run; }, set run(value) { run = value; } };
}

test('persistent parent waits across agent turns and only completes after independent exact-byte review', async t => {
  const f = await fixture(t); await f.step();
  assert.equal(f.run.phase, 'waiting_children'); assert.equal(f.run.executionStatus, 'working');
  await f.step(); assert.equal(f.requests.length, 1); assert.ok(f.parents.every(p => p.executionStatus !== 'completed'));
  await f.completeCurrent(); await f.step(); await f.completeCurrent(); await f.step(); await f.step();
  assert.equal(f.run.stage, 'review'); assert.equal(f.run.executionStatus, 'working');
  await f.completeCurrent();
  assert.equal(f.run.executionStatus, 'completed'); assert.equal(f.parents.filter(p => p.executionStatus === 'completed').length, 1);
  assert.equal(f.run.deliveryReceipt!.humanAcceptance, 'not_requested');
  assert.equal(f.run.deliveryReceipt!.notificationAcknowledged, false);
  assert.equal(f.requests.length, 3); assert.equal(f.run.metrics.machineChecks, 2);
  for (const request of f.requests) {
    assert.deepEqual(request.parentJobRef, { sourceId: 'source', jobId: 'parent-job' });
    assert.equal(request.parentAttemptId, 'parent-attempt'); assert.equal(request.originSessionId, 'ppt-delivery:parent-job');
  }
});

test('review changes continue the same maker child with a new execution attempt and isolated revision', async t => {
  const f = await fixture(t); await f.untilReview();
  const firstMaker = f.run.children.find(c => c.purpose === 'ppt_production')!.child;
  await f.completeCurrent('changes_requested');
  assert.equal(f.run.stage, 'make'); assert.equal(f.run.revision, 2);
  assert.equal(f.run.currentChild!.jobId, firstMaker.jobId); assert.notEqual(f.run.currentChild!.attemptId, firstMaker.attemptId);
  await f.completeCurrent(); await f.step(); await f.step(); await f.completeCurrent();
  assert.equal(f.run.executionStatus, 'completed'); assert.equal(f.run.metrics.qualityRevisions, 1);
  assert.equal(f.run.metrics.continueCalls, 1); assert.equal(f.run.metrics.reviewRounds, 2);
  assert.equal(f.run.attemptId, 'parent-attempt'); assert.equal(f.run.children.filter(c => c.purpose === 'independent_review').length, 2);
});

test('explicit caller revision exercise is distinct from a quality failure', async t => {
  const f = await fixture(t, { revisionRequest: 'Make cover subtitle more concise without changing facts' });
  await f.untilReview(); await f.completeCurrent();
  assert.equal(f.run.revision, 2); assert.equal(f.run.metrics.qualityRevisions, 0); assert.equal(f.run.metrics.acceptanceExerciseRevisions, 1);
  await f.completeCurrent(); await f.step(); await f.step(); await f.completeCurrent();
  assert.equal(f.run.executionStatus, 'completed'); assert.equal(f.run.deliveryReceipt!.productionAttemptCount, 2);
});

test('an explicit exercise has its own one-round budget after all quality revisions were used', async t => {
  const f = await fixture(t, { revisionRequest: 'append internal review footer only after approval' });
  await f.untilReview(); await f.completeCurrent('changes_requested');
  assert.equal(f.run.metrics.qualityRevisions, f.run.policy.maxRevisionRounds);
  await f.completeCurrent(); await f.step(); await f.step(); await f.completeCurrent();
  assert.equal(f.run.executionStatus, 'working'); assert.equal(f.run.stage, 'make');
  assert.equal(f.run.metrics.qualityRevisions, 1); assert.equal(f.run.metrics.acceptanceExerciseRevisions, 1);
  await f.completeCurrent(); await f.step(); await f.step(); await f.completeCurrent();
  assert.equal(f.run.executionStatus, 'completed'); assert.equal(f.run.metrics.acceptanceExerciseRevisions, 1);
});

test('explicit recovery creates a new parent round and reuses the verified checkpoint without resetting cost or budgets', async t => {
  const f = await fixture(t); await f.untilReview(); await f.completeCurrent();
  // Persisted snapshot from the former shared-budget policy: review passed but parent stopped before exercise.
  f.run.executionStatus = 'failed'; f.run.phase = 'failed'; f.run.stage = 'review';
  f.run.input.revisionRequest = 'append review footer'; f.run.metrics.qualityRevisions = f.run.policy.maxRevisionRounds;
  const old = structuredClone(f.run), originalContract = await readFile(f.run.contractPath, 'utf8');
  const resumed = await recoverPptDeliveryRun(f.run, 'recovery-parent-attempt');
  assert.deepEqual(f.run, old); assert.equal(await readFile(old.contractPath, 'utf8'), originalContract);
  assert.equal(resumed.jobId, old.jobId); assert.notEqual(resumed.attemptId, old.attemptId);
  assert.equal(resumed.createdAt, old.createdAt); assert.equal(resumed.metrics.qualityRevisions, old.metrics.qualityRevisions);
  assert.equal(resumed.recovery!.fromAttemptId, old.attemptId); assert.equal(resumed.jobDirectory, old.jobDirectory);
  Object.assign(f.run, resumed); await f.step();
  assert.equal(f.run.stage, 'make'); assert.equal(f.run.metrics.acceptanceExerciseRevisions, 1);
  assert.ok(f.run.recovery!.validationCheckedAt);
  const priorMaker = old.children.find(c => c.purpose === 'ppt_production')!.child;
  assert.equal(f.run.currentChild!.jobId, priorMaker.jobId); assert.notEqual(f.run.currentChild!.attemptId, priorMaker.attemptId);
  await f.completeCurrent(); await f.step(); await f.step(); await f.completeCurrent();
  assert.equal(f.run.executionStatus, 'completed'); assert.equal(f.run.deliveryReceipt!.attemptId, 'recovery-parent-attempt');
});

test('recovery rejects unresolved/live children and stops on checkpoint byte changes before further dispatch', async t => {
  const f = await fixture(t); await f.untilReview(); await f.completeCurrent(); f.run.executionStatus = 'failed'; f.run.stage = 'review';
  const oldChild = f.run.children[0]!.child; oldChild.submissionStatus = 'submission_unknown';
  await assert.rejects(recoverPptDeliveryRun(f.run, 'new-parent'), /unresolved or running/);
  oldChild.submissionStatus = 'accepted'; oldChild.executionStatus = 'working';
  await assert.rejects(recoverPptDeliveryRun(f.run, 'new-parent'), /unresolved or running/);
  oldChild.executionStatus = 'completed'; const resumed = await recoverPptDeliveryRun(f.run, 'new-parent');
  Object.assign(f.run, resumed); const before = f.requests.length;
  f.adapter.validateCandidate = async () => ({ ...f.run.validation!, artifactDigest: 'a'.repeat(64) });
  await f.step(); assert.equal(f.run.executionStatus, 'input_required'); assert.equal(f.requests.length, before);
});

test('review-only recovery uses a fresh independent child and parent round, preserving failed history and original version', async t => {
  const f = await fixture(t); await f.untilReview();
  f.childStates.get(f.run.currentChild!.attemptId)!.executionStatus = 'failed'; await f.step();
  assert.equal(f.run.executionStatus, 'failed');
  const old = structuredClone(f.run), originalContract = await readFile(old.contractPath, 'utf8');
  // A terminal round may be resumed days later; only the new round gets a fresh bounded deadline.
  old.createdAt = new Date(Date.now() - 86400000).toISOString();
  const resumed = await recoverPptDeliveryRun(old, 'review-only-parent', { recoveryMode: 'review_only', reviewTargetId: 'codex-review' });
  assert.deepEqual(f.run.children, old.children); assert.equal(await readFile(old.contractPath, 'utf8'), originalContract);
  assert.equal(resumed.revision, old.revision); assert.equal(resumed.policy.makerTargetId, old.policy.makerTargetId);
  assert.equal(resumed.executionRetries.review, 0); assert.equal(resumed.createdAt, old.createdAt);
  f.run = resumed; const before = f.requests.length; await f.step();
  assert.equal(f.requests.length, before + 1); const request = f.requests.at(-1)!;
  assert.equal(request.purpose, 'independent_review'); assert.equal(request.targetId, 'codex-review');
  assert.equal(request.parentAttemptId, 'review-only-parent'); assert.equal(request.resultRevision, `revision-${old.revision}`);
  assert.notEqual(f.run.currentChild!.jobId, old.currentChild!.jobId);
  assert.match(String(request.input.prompt), /禁止制作、修改、重导出/);
  await f.completeCurrent(); assert.equal(f.run.executionStatus, 'completed');
  assert.equal(f.run.deliveryReceipt!.selectedProduction && (f.run.deliveryReceipt!.selectedProduction as any).attemptId,
    old.children.find(c => c.purpose === 'ppt_production')!.child.attemptId);
  assert.equal(f.run.deliveryReceipt!.productionAttemptCount, 1);
  assert.match(String(f.run.deliveryReceipt!.independentReviewRef), /independent-review.review-only-parent.json$/);
  assert.equal(f.run.validation!.artifactDigest, old.validation!.artifactDigest);
  assert.equal(old.executionStatus, 'failed'); assert.ok(f.run.metrics.elapsedMs >= old.metrics.elapsedMs);
});

test('review-only changes requested never re-enters production or consumes a quality revision', async t => {
  const f = await fixture(t); await f.untilReview();
  f.childStates.get(f.run.currentChild!.attemptId)!.executionStatus = 'failed'; await f.step();
  f.run = await recoverPptDeliveryRun(f.run, 'review-only-parent', { recoveryMode: 'review_only', reviewTargetId: 'codex-review' });
  await f.step(); const before = f.requests.length;
  await f.completeCurrent('changes_requested'); await f.step();
  assert.equal(f.run.executionStatus, 'input_required'); assert.equal(f.run.stage, 'review');
  assert.equal(f.requests.length, before); assert.equal(f.run.metrics.qualityRevisions, 0);
  assert.match(f.run.diagnostics.join(), /只重试验收/);
});

test('review-only verifies frozen source snapshot and exact candidate before dispatch, then rechecks source at delivery', async t => {
  const f = await fixture(t); await f.untilReview();
  f.childStates.get(f.run.currentChild!.attemptId)!.executionStatus = 'failed'; await f.step();
  const snapshot = join(f.root, 'original-source'); await cp(f.run.input.projectDirectory, snapshot, { recursive: true });
  await writeFile(join(f.run.input.projectDirectory, 'source-0.md'), 'new project facts');
  const old = structuredClone(f.run), options = { recoveryMode: 'review_only' as const, reviewTargetId: 'codex-review', sourceSnapshotDirectory: snapshot };
  f.run = await recoverPptDeliveryRun(old, 'changed-bytes', options);
  f.adapter.validateCandidate = async () => ({ ...old.validation!, artifactDigest: 'f'.repeat(64) });
  const before = f.requests.length; await f.step();
  assert.equal(f.run.executionStatus, 'input_required'); assert.equal(f.requests.length, before);
  f.adapter.validateCandidate = async () => old.validation!;
  f.run = await recoverPptDeliveryRun(old, 'source-snapshot-review', options); await f.step();
  assert.equal(f.requests.length, before + 1); assert.match(String(f.requests.at(-1)!.input.prompt), /原始字节快照/);
  await writeFile(join(snapshot, 'source-0.md'), 'tampered snapshot'); await f.completeCurrent();
  assert.notEqual(f.run.executionStatus, 'completed'); assert.ok(f.run.diagnostics.some(item => item.includes('Source hash mismatch')));
});

test('review-only rejects canceled parents, live/unknown children and changed script/source manifests', async t => {
  const f = await fixture(t); await f.untilReview(); await f.completeCurrent();
  const options = { recoveryMode: 'review_only' as const, reviewTargetId: 'codex-review' };
  f.run.executionStatus = 'canceled'; f.run.stage = 'review';
  await assert.rejects(recoverPptDeliveryRun(f.run, 'new-round', options), /terminal failed/);
  f.run.executionStatus = 'failed'; f.run.cancellationRequestedAt = new Date().toISOString();
  await assert.rejects(recoverPptDeliveryRun(f.run, 'new-round', options), /terminal failed/); delete f.run.cancellationRequestedAt;
  f.run.children[0]!.child.submissionStatus = 'submission_unknown';
  await assert.rejects(recoverPptDeliveryRun(f.run, 'new-round', options), /unresolved or running/);
  f.run.children[0]!.child.submissionStatus = 'accepted';
  f.run = await recoverPptDeliveryRun(f.run, 'new-round', options);
  await writeFile(join(f.run.jobDirectory, 'coordinator/slide-script.json'), '{}');
  const before = f.requests.length; await f.step();
  assert.equal(f.run.executionStatus, 'input_required'); assert.equal(f.requests.length, before);
});

test('unknown acceptance and query outage never blindly resubmit', async t => {
  const f = await fixture(t);
  f.adapter.submitChild = async request => { f.requests.push(request); return { jobId: 'unknown', attemptId: 'unknown-attempt', executionStatus: 'unknown', submissionStatus: 'submission_unknown' }; };
  await f.step(); assert.equal(f.run.executionStatus, 'input_required');
  await f.step(); assert.equal(f.requests.length, 1);
  const g = await fixture(t); await g.step(); g.adapter.getChild = async () => { throw new Error('offline'); };
  await g.step(); await g.step(); assert.equal(g.run.executionStatus, 'working'); assert.equal(g.requests.length, 1);
});

test('same maker/reviewer identity and post-review changed bytes block completion', async t => {
  const f = await fixture(t); await f.untilReview();
  f.childStates.get(f.run.currentChild!.attemptId)!.sessionId = 'maker-session'; await f.completeCurrent();
  assert.equal(f.run.executionStatus, 'failed'); assert.match(f.run.diagnostics.join(), /身份/);
  const g = await fixture(t); await g.untilReview();
  g.adapter.validateCandidate = async () => ({ ...g.run.validation!, artifactDigest: 'f'.repeat(64) }); await g.completeCurrent();
  assert.equal(g.run.executionStatus, 'failed'); assert.match(g.run.diagnostics.join(), /发生变化/);
});

test('revision budget prevents unbounded repair; deadline retains truthful child state', async t => {
  const f = await fixture(t); await f.untilReview(); await f.completeCurrent('changes_requested');
  await f.completeCurrent(); await f.step(); await f.step(); await f.completeCurrent('changes_requested');
  assert.equal(f.run.executionStatus, 'failed'); assert.match(f.run.diagnostics.join(), /预算耗尽/); assert.equal(f.run.revision, 2);
  const g = await fixture(t); await g.step(); g.adapter.now = () => Date.parse(g.run.createdAt) + g.run.policy.maxDurationMs + 1;
  await g.step(); assert.equal(g.run.executionStatus, 'input_required'); assert.equal(g.run.currentChild!.executionStatus, 'working');
});

test('confirmed execution failures use a fresh output revision and retain a bounded retry count across versions', async t => {
  const f = await fixture(t); f.run.policy.maxExecutionRetries = 1;
  await f.step(); await f.completeCurrent(); await f.step();
  const first = f.run.currentChild!; f.childStates.get(first.attemptId)!.executionStatus = 'failed';
  await f.step();
  assert.equal(f.run.revision, 2); assert.equal(f.run.currentChild!.jobId, first.jobId);
  assert.equal(f.run.executionRetries.make, 1);
  f.childStates.get(f.run.currentChild!.attemptId)!.executionStatus = 'failed'; await f.step();
  assert.equal(f.run.executionStatus, 'failed'); assert.equal(f.run.metrics.continueCalls, 1);
  assert.equal(f.run.metrics.qualityRevisions, 0); assert.equal(f.run.revision, 2);
});

test('confirmed quota-like failure selects only the registered backup as a new child job with replacement lineage', async t => {
  const f = await fixture(t); f.run.policy.backupTargets = { ppt_production: 'maker-backup' }; f.run.policy.maxTargetSwitches = 1;
  await f.step(); await f.completeCurrent(); await f.step();
  const original = f.run.currentChild!;
  Object.assign(f.childStates.get(original.attemptId)!, { executionStatus: 'failed', resultSummary: '429 provider quota exhausted' });
  await f.step();
  assert.equal(f.run.executionStatus, 'working'); assert.equal(f.run.revision, 2);
  assert.notEqual(f.run.currentChild!.jobId, original.jobId); assert.equal(f.run.targetSwitches.length, 1);
  assert.equal(f.requests.at(-1)!.targetId, 'maker-backup'); assert.deepEqual(f.requests.at(-1)!.replacesJobRef, { sourceId: 'source', jobId: original.jobId });
  assert.notEqual(f.requests.at(-1)!.clientRequestId, f.requests.at(-2)!.clientRequestId);
  assert.equal(f.run.targetSwitches[0].policyVersion, f.run.policy.version); assert.equal(f.run.metrics.continueCalls, 0);
  await f.completeCurrent(); await f.step(); await f.step(); await f.completeCurrent();
  assert.equal(f.run.executionStatus, 'completed'); assert.equal((f.run.deliveryReceipt!.targetSwitches as unknown[]).length, 1);
});

test('an unresolved acceptance never switches to a configured backup', async t => {
  const f = await fixture(t); f.run.policy.backupTargets = { project_script: 'summary-backup' }; f.run.policy.maxTargetSwitches = 1;
  f.adapter.submitChild = async request => { f.requests.push(request); return { jobId: 'unknown-child', attemptId: 'unknown-attempt', executionStatus: 'unknown', submissionStatus: 'submission_unknown' }; };
  await f.step(); await f.step();
  assert.equal(f.run.executionStatus, 'input_required'); assert.equal(f.requests.length, 1); assert.equal(f.run.targetSwitches.length, 0);
  assert.equal(f.run.activeTargets.project_script, undefined);
});

test('publication outage stops before any model dispatch and does not consume quality budget', async t => {
  const f = await fixture(t);
  f.adapter.preflightPublication = async () => { throw new PptPublicationError('versioned URL returned 404'); };
  await f.step(); await f.step();
  assert.equal(f.run.executionStatus, 'input_required'); assert.equal(f.requests.length, 0);
  assert.equal(f.run.metrics.qualityRevisions, 0);
});

test('publication failure after making does not ask the model to re-export identical slides', async t => {
  const f = await fixture(t); await f.step(); await f.completeCurrent(); await f.step(); await f.completeCurrent();
  assert.equal(f.run.stage, 'validate');
  f.adapter.validateCandidate = async () => { throw new PptPublicationError('Artifact GET failed: 404'); };
  await f.step();
  assert.equal(f.run.executionStatus, 'input_required'); assert.equal(f.requests.length, 2);
  assert.equal(f.run.metrics.continueCalls, 0); assert.equal(f.run.metrics.qualityRevisions, 0);
});

test('publication preflight exercises exact versioned GET route and removes its probe', async t => {
  const f = await fixture(t); let ready = false;
  const server = createServer(async (req, res) => {
    if (!ready || !/^\/artifacts\/parent-job\/revision-1\/preflight-[a-f0-9-]+\.png$/.test(req.url!)) { res.writeHead(404).end(); return; }
    res.end(await readFile(join(f.run.policy.publicDirectory, req.url!.slice('/artifacts/'.length))));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  f.run.policy.publicBaseUrl = `http://127.0.0.1:${address.port}/artifacts`;
  await assert.rejects(preflightPptPublication(f.run), /404/);
  ready = true; await preflightPptPublication(f.run);
  const receipt = JSON.parse(await readFile(join(f.run.jobDirectory, 'publication-preflight.json'), 'utf8'));
  assert.equal(receipt.passed, true);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(join(f.run.policy.publicDirectory, f.run.jobId, 'revision-1')), []);
});

test('terminal parent update survives a crash without repeating production', async t => {
  const f = await fixture(t); await f.untilReview(); const original = f.adapter.updateParent;
  let failed = false;
  f.adapter.updateParent = async value => { if (value.executionStatus === 'completed' && !failed) { failed = true; throw new Error('crash before parent event'); } await original(value); };
  await f.completeCurrent(); assert.equal(f.run.executionStatus, 'completed'); assert.ok(f.run.parentUpdatePending);
  await f.step(); assert.equal(f.parents.filter(p => p.executionStatus === 'completed').length, 1); assert.equal(f.requests.length, 3);
  assert.equal(f.run.parentUpdatePending, undefined);
});

test('deterministic validator performs real ZIP, HTTP and byte checks, rejects poisoned manifest and drift', async t => {
  const f = await fixture(t), run = f.run, directory = join(run.jobDirectory, 'revision-1'); await mkdir(directory);
  const publicDir = join(run.policy.publicDirectory, run.jobId, 'revision-1'); await mkdir(publicDir, { recursive: true });
  const server = createServer(async (req, res) => { try { res.end(await readFile(join(publicDir, basename(req.url!)))); } catch { res.writeHead(404).end(); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); run.policy.publicBaseUrl = `http://127.0.0.1:${address.port}/artifacts`;
  // Synthetic structural fixture, not an artifact-tool authoring or native application claim.
  const pptx = join(directory, 'project-overview.pptx');
  await execute(python, ['-I', '-c', `import zipfile,sys\np='http://schemas.openxmlformats.org/presentationml/2006/main';a='http://schemas.openxmlformats.org/drawingml/2006/main'\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('ppt/presentation.xml',f'<p:presentation xmlns:p="{p}"><p:sldIdLst>'+''.join('<p:sldId/>' for _ in range(6))+'</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>')\n for i in range(1,7):z.writestr(f'ppt/slides/slide{i}.xml',f'<p:sld xmlns:p="{p}" xmlns:a="{a}"><p:sp><a:t>Editable page {i}</a:t></p:sp></p:sld>')`, pptx]);
  const artifacts = [];
  for (const name of ['project-overview.pptx', 'preview.png', ...Array.from({ length: 6 }, (_, i) => `slide-${i+1}.png`)]) {
    if (name.endsWith('.png')) await writeFile(join(directory, name), Buffer.from([137,80,78,71,13,10,26,10,1,2,3]));
    await writeFile(join(publicDir, name), await readFile(join(directory, name)));
    artifacts.push({ path: join(directory, name), url: `${run.policy.publicBaseUrl}/${run.jobId}/revision-1/${name}`, mediaType: name.endsWith('.png') ? 'image/png' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
  }
  for (const name of ['design-plan.json','design-usage.json','qa.json']) await writeFile(join(directory, name), '{}');
  const bytes = await readFile(pptx), sha = hash(bytes);
  await writeFile(join(directory, 'finalizer-validation.json'), JSON.stringify({ schemaVersion: 'presentation-finalization.v1', finalSha256: sha, byteCount: bytes.length,
    packageIntegrity: { status: 'pass' }, presentationLayout: { exitCode: 0 }, fontSelection: { performed: true, passed: true }, firstPartyImport: { performed: true, passed: true, sha256: sha } }));
  const manifestPath = join(directory, 'artifact-manifest.json'); await writeFile(manifestPath, JSON.stringify({ artifacts }));
  const report = await validatePptDeliveryCandidate(run); assert.equal(report.structure.slideCount, 6); assert.equal(report.artifacts.length, 8);
  await writeFile(manifestPath, JSON.stringify({ artifacts, jobId: 'illegal' })); await assert.rejects(validatePptDeliveryCandidate(run));
  await writeFile(manifestPath, JSON.stringify({ artifacts })); await writeFile(join(publicDir, 'preview.png'), 'drift');
  await assert.rejects(validatePptDeliveryCandidate(run), /Published bytes differ/);
});

test('failed review preserves machine-verified draft links and completed stage progress without declaring delivery ready', async t => {
  const { deliveryProgress } = await import('../src/execution/delivery-progress.js');
  const f = await fixture(t); await f.untilReview();
  f.childStates.get(f.run.currentChild!.attemptId)!.executionStatus = 'failed';
  await f.step();
  assert.equal(f.run.executionStatus, 'failed');
  const progress = deliveryProgress(f.run);
  assert.deepEqual(progress.completedStages, ['项目总结与脚本', 'PPT制作', '机器校验']);
  assert.deepEqual(progress.remainingStages, ['独立验收']);
  assert.equal(progress.availableResults[0]!.deliveryReady, false);
  assert.equal(progress.stageCompletionWakeups, false);
  assert.ok(f.parents.at(-1)!.artifactLinks!.some(a => a.url.endsWith('final.pptx')));
  assert.match(f.parents.at(-1)!.resultSummary!, /已有产物.*独立验收状态/s);
  assert.match(f.parents.at(-1)!.resultSummary!, /尚非最终交付/);
});

test('revision keeps an earlier verified candidate while current production is working', async t => {
  const { deliveryProgress } = await import('../src/execution/delivery-progress.js');
  const f = await fixture(t); await f.untilReview(); await f.completeCurrent('changes_requested');
  const progress = deliveryProgress(f.run);
  assert.equal(progress.revision, 'revision-2');
  assert.equal(progress.availableResults[0]!.revision, 'revision-1');
  assert.equal(progress.availableResults[0]!.deliveryReady, false);
  assert.equal(progress.stages.find(s => s.stage === 'make')!.status, 'working');
});

test('cancellation arriving during publication preflight prevents any child dispatch', async t => {
  const f = await fixture(t);
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.adapter.preflightPublication = async () => { started(); await gate; };
  const run = f.run, advancing = advancePptDelivery(run, f.adapter);
  await entered; run.cancellationRequestedAt = new Date().toISOString(); await f.adapter.persist(run); release(); await advancing;
  assert.equal(f.requests.length, 0);
  assert.ok(f.parents.every(update => update.executionStatus !== 'completed'));
});
