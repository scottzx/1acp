import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { advancePptDelivery, createPptDeliveryRun, recoverPptDeliveryRun,
  type PptDeliveryAdapter, type PptDeliveryChild, type PptDeliveryChildRequest, type PptDeliveryRun } from '../src/execution/ppt-delivery.js';
import { roleSkillLockSchema, skillContentRevision } from '../src/roles/index.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ppt-role-skill-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  const files: { path: string; sha256: string }[] = [];
  for (let i = 0; i < 6; i++) { const path = `source-${i}.md`, content = `Fact ${i}`; await writeFile(join(project, path), content); files.push({ path, sha256: hash(content) }); }
  let guide = '# Design revision one', networkRequests = 0;
  const packageFiles = () => [{ path: 'SKILL.md', bytes: Buffer.from(guide) }];
  const revision = () => skillContentRevision(packageFiles());
  const server = createServer((req, res) => {
    networkRequests++;
    const url = new URL(req.url!, 'http://localhost');
    const descriptor = { id: 'project:design', source_id: 'project', name: 'ppt-report-design', revision: revision() };
    if (url.pathname === '/skills') { res.end(JSON.stringify({ skills: [descriptor], has_more: false })); return; }
    if (url.pathname === '/skills/project%3Adesign' && url.searchParams.get('revision') === revision()) {
      res.end(JSON.stringify({ ...descriptor, resource: 'SKILL.md', content: guide, encoding: 'utf8', resources: packageFiles().map(file => ({ path: file.path, bytes: file.bytes.length })) })); return;
    }
    res.writeHead(409).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const profilePath = join(root, 'role.json'), cacheRoot = join(root, '.cache/roles');
  await writeFile(profilePath, JSON.stringify({ id: 'ppt', version: '1', entrySkill: 'ppt-report-design',
    network: { agentUrl: `http://127.0.0.1:${address.port}` }, skills: [{ key: 'ppt-report-design', name: 'ppt-report-design', sourceId: 'project' }] }));
  await writeFile(join(root, 'RUNTIME.md'), 'Test runtime'); await writeFile(join(root, 'fallback-SKILL.md'), 'Old local skill');
  const policy = { workspaceRoot: join(root, 'jobs'), publicDirectory: join(root, 'public'), publicBaseUrl: 'http://example.invalid/artifacts',
    allowedProjectRoots: [project], summaryTargetId: 'summary', makerTargetId: 'maker', reviewTargetId: 'review',
    runtimeDocument: join(root, 'RUNTIME.md'), designSkill: join(root, 'fallback-SKILL.md'), pythonExecutable: '/usr/bin/python3',
    maxExecutionRetries: 0, roleSkills: { profilePath, cacheRoot } };
  const create = async (jobId = 'parent', attemptId = 'parent-attempt') => {
    const run = await createPptDeliveryRun({ sourceId: 'source', jobId, attemptId, originSessionId: 'root-session',
      input: { projectDirectory: project, projectName: 'Project', slideCount: 2 }, policy });
    const summary = join(run.jobDirectory, 'coordinator');
    await writeFile(join(summary, 'project-summary.md'), 'Source-backed project summary'); await writeFile(join(summary, 'slide-script.md'), 'Two-page script');
    await writeFile(join(summary, 'source-manifest.json'), JSON.stringify({ projectDirectory: project, gitHead: 'unknown', gitStatus: '', files }));
    await writeFile(join(summary, 'slide-script.json'), JSON.stringify({ title: 'Project', slides: [0, 1].map(i => ({ title: `Page ${i+1}`, message: `Fact ${i}`, body: [`Fact ${i}`], visual: 'native diagram', sources: [`source-${i}.md:1`], facts: [`Fact ${i}`], notes: '' })) }));
    return run;
  };
  let run = await create(), sequence = 0;
  const requests: PptDeliveryChildRequest[] = [], children = new Map<string, PptDeliveryChild>();
  const adapter: PptDeliveryAdapter = {
    async persist() {},
    async submitChild(request) {
      requests.push(structuredClone(request));
      const child: PptDeliveryChild = { jobId: `child-${++sequence}`, attemptId: `child-attempt-${sequence}`, executionStatus: 'working', submissionStatus: 'accepted', sessionId: `session-${request.purpose}` };
      children.set(child.attemptId, child); return structuredClone(child);
    },
    async continueChild() { throw new Error('Unexpected production retry in role loading test'); },
    async getChild(child) { return structuredClone(children.get(child.attemptId)!); },
    async ackChild() {}, async updateParent() {}, async preflightPublication() {},
    // Structural/visual validation are injected fixtures; these tests never create or claim to inspect a real business PPT.
    async validateCandidate(value) { return { status: 'passed', artifactDigest: 'a'.repeat(64), checkedAt: new Date().toISOString(),
      structure: { slideCount: 2, editableTextRuns: 2, shapes: 2, pictures: 0, aspectRatio: 16/9 }, checks: ['injected test validation'],
      artifacts: [{ path: join(value.jobDirectory, 'revision-1/project-overview.pptx'), url: 'http://example.invalid/draft.pptx', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: 10, sha256: 'b'.repeat(64) },
        { path: join(value.jobDirectory, 'revision-1/preview.png'), url: 'http://example.invalid/preview.png', mediaType: 'image/png', size: 10, sha256: 'c'.repeat(64) }] }; },
  };
  const step = () => advancePptDelivery(run, adapter);
  const complete = async () => { assert.ok(run.currentChild); children.get(run.currentChild.attemptId)!.executionStatus = 'completed'; await step(); };
  const untilReview = async () => { await step(); await complete(); await step(); await complete(); await step(); await step(); assert.equal(run.stage, 'review'); assert.ok(run.currentChild); };
  const lock = async () => roleSkillLockSchema.parse(JSON.parse(await readFile(run.roleSkillLockPath!, 'utf8')));
  return { root, create, adapter, requests, children, step, complete, untilReview, lock,
    get run() { return run; }, set run(value: PptDeliveryRun) { run = value; },
    get networkRequests() { return networkRequests; }, updateSkill() { guide = '# Design revision two'; }, revision };
}

test('PPT admission does not fetch skills; background advance resolves once and production/review share the parent pin', async t => {
  const f = await fixture(t);
  assert.equal(f.networkRequests, 0); assert.ok(f.run.roleSkillLockPath);
  await assert.rejects(readFile(f.run.roleSkillLockPath!), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  await f.step(); assert.ok(f.networkRequests > 0);
  const locked = await f.lock(), requestsAfterLoad = f.networkRequests;
  assert.equal(f.requests[0]!.purpose, 'project_script'); assert.equal(f.requests[0]!.input.roleLockPath, undefined);
  assert.equal(f.run.policy.designSkill, locked.entryGuidePath);
  await f.complete(); await f.step();
  const maker = f.requests.find(request => request.purpose === 'ppt_production')!;
  assert.equal(maker.input.roleLockPath, f.run.roleSkillLockPath);
  f.updateSkill(); assert.notEqual(f.revision(), locked.skills[0]!.revision);
  await f.complete(); await f.step(); await f.step();
  const review = f.requests.find(request => request.purpose === 'independent_review')!;
  assert.equal(review.input.roleLockPath, maker.input.roleLockPath);
  assert.equal(f.networkRequests, requestsAfterLoad);
  assert.equal((await f.lock()).skills[0]!.revision, locked.skills[0]!.revision);
  assert.equal(await readFile(f.run.policy.designSkill, 'utf8'), '# Design revision one');
});

test('a new parent receives a new skill revision while its creation remains network-free', async t => {
  const f = await fixture(t); await f.step();
  const first = await f.lock(), firstPath = f.run.roleSkillLockPath, before = f.networkRequests;
  f.updateSkill(); f.run = await f.create('new-parent');
  assert.equal(f.networkRequests, before); assert.notEqual(f.run.roleSkillLockPath, firstPath);
  await f.step();
  assert.notEqual((await f.lock()).skills[0]!.revision, first.skills[0]!.revision);
  assert.equal(await readFile(f.run.policy.designSkill, 'utf8'), '# Design revision two');
});

test('corrupt locked skill cache stops before maker dispatch and does not refresh from the network', async t => {
  const f = await fixture(t); await f.step(); await f.complete();
  assert.equal(f.run.stage, 'make');
  await writeFile((await f.lock()).skills[0]!.guidePath, 'corrupt');
  const before = f.networkRequests; await f.step();
  assert.equal(f.run.executionStatus, 'input_required'); assert.equal(f.requests.length, 1);
  assert.equal(f.networkRequests, before); assert.ok(f.run.diagnostics.some(message => message.includes('技能缓存不可用')));
});

test('review-only recovery retains the original parent lock and cached guide after source skill updates', async t => {
  const f = await fixture(t); await f.untilReview();
  const failed = f.children.get(f.run.currentChild!.attemptId)!; failed.executionStatus = 'failed'; await f.step();
  assert.equal(f.run.executionStatus, 'failed');
  const original = structuredClone(f.run), originalLock = await f.lock(), before = f.networkRequests;
  f.updateSkill();
  f.run = await recoverPptDeliveryRun(f.run, 'recovered-parent-attempt', { recoveryMode: 'review_only', reviewTargetId: 'replacement-review' });
  assert.equal(f.run.roleSkillLockPath, original.roleSkillLockPath);
  assert.equal(f.run.policy.designSkill, original.policy.designSkill);
  await f.step();
  assert.equal(f.requests.at(-1)!.purpose, 'independent_review');
  assert.equal(f.requests.at(-1)!.input.roleLockPath, original.roleSkillLockPath);
  assert.equal((await f.lock()).skills[0]!.revision, originalLock.skills[0]!.revision);
  assert.equal(f.networkRequests, before);
  assert.equal(original.executionStatus, 'failed');
});
