import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SendMessageRequest, TaskState } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';
import { DefaultExecutionEventBus, RequestContext, ServerCallContext, type AgentExecutionEvent } from '@a2a-js/sdk/server';
import { A2ASessionExecutor, parseA2AInput, type A2AExecutionOptions } from '../src/a2a/executor.js';
import { FileA2AStore } from '../src/a2a/store.js';
import type { A2ABackend, A2APrepareInput, A2ATarget } from '../src/a2a/types.js';
import { createA2AServer } from '../src/a2a/server.js';
import { resolveRoleSkills, skillContentRevision } from '../src/roles/index.js';

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'a2a-role-test-')));
  let text = '# Design version one', calls = 0, online = true;
  let catalogueGate: Promise<void> | undefined;
  const catalogueRequested = barrier(), firstRun = barrier();
  const files = () => [{ path: 'SKILL.md', bytes: Buffer.from(text) }];
  const revision = () => skillContentRevision(files());
  const service = createServer(async (req, res) => {
    calls++;
    if (!online) { res.writeHead(503).end(); return; }
    const url = new URL(req.url!, 'http://localhost');
    const common = { id: 'source:design', source_id: 'source', name: 'design', revision: revision() };
    if (url.pathname === '/skills') { catalogueRequested.resolve(); await catalogueGate; res.end(JSON.stringify({ skills: [common], has_more: false })); return; }
    if (url.pathname === '/skills/source%3Adesign' && url.searchParams.get('revision') === revision()) {
      res.end(JSON.stringify({ ...common, resource: 'SKILL.md', content: text, encoding: 'utf8', resources: [{ path: 'SKILL.md', bytes: Buffer.byteLength(text) }] })); return;
    }
    res.writeHead(409).end();
  });
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
  const address = service.address(); assert.ok(address && typeof address !== 'string');
  const profilePath = join(root, 'profile.json'), cacheRoot = join(root, '.cache/roles');
  await writeFile(join(root, 'ROLE.md'), '# Canonical PPT role');
  const profile = { id: 'ppt', version: '1', instructionsPath: 'ROLE.md', network: { agentUrl: `http://127.0.0.1:${address.port}` },
    entrySkill: 'design', skills: [{ key: 'design', name: 'design', sourceId: 'source' }] };
  await writeFile(profilePath, JSON.stringify(profile));
  const options: A2AExecutionOptions = { defaultCwd: root, defaultAgentPreset: 'codex', roleSkills: { cacheRoot, profiles: { maker: profilePath, reviewer: profilePath } } };
  let store = new FileA2AStore(join(root, 'state'));
  const prepares: A2APrepareInput[] = [], runs: { target: A2ATarget; prompt: string }[] = [];
  const backend: A2ABackend = {
    async prepare(input) { prepares.push(input); return { sessionId: input.sessionId ?? `session-${prepares.length}`, cwd: input.cwd!, agentPreset: input.agentPreset }; },
    async run(target, prompt) { runs.push({ target: structuredClone(target), prompt }); firstRun.resolve(); return { text: 'review only; no PPT changes', outcome: 'completed' }; },
  };
  let executor = new A2ASessionExecutor(backend, store, options);
  const serverContext = new ServerCallContext({ tenant: 'tenant', user: { isAuthenticated: true, userName: 'owner' } });
  async function execute(metadata?: Record<string, unknown>, contextId = randomUUID(), context = serverContext, observe?: (event: AgentExecutionEvent) => void) {
    const request = SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), role: 'ROLE_USER', contextId, parts: [{ text: 'Inspect existing deck only; do not modify it.' }] },
      metadata: metadata ? { '1agents': metadata } : undefined });
    const events: AgentExecutionEvent[] = [], bus = new DefaultExecutionEventBus();
    bus.on('event', event => { events.push(event); observe?.(event); });
    await executor.execute(new RequestContext(request, randomUUID(), contextId, context), bus);
    const final = events.findLast(event => event.kind === 'statusUpdate'); assert.ok(final?.kind === 'statusUpdate');
    return { contextId, final: final.data, events };
  }
  async function restart() { await executor.close(); store.close(); store = new FileA2AStore(join(root, 'state')); executor = new A2ASessionExecutor(backend, store, options); }
  t.after(async () => { await executor.close(); store.close(); service.closeAllConnections(); await new Promise<void>(resolve => service.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  return { root, cacheRoot, profilePath, profile, options, prepares, runs, execute, restart, serverContext, backend,
    holdCatalogue() { const gate = barrier(); catalogueGate = gate.promise; return gate.resolve; },
    catalogueRequested: catalogueRequested.promise, firstRun: firstRun.promise,
    get calls() { return calls; }, set online(value: boolean) { online = value; }, set text(value: string) { text = value; },
    currentRevision: revision, target: (id: string) => store.loadTarget(id, serverContext) };
}

test('host loads a new context, injects frozen guides and publishes host-authored role metadata', async t => {
  const f = await fixture(t); let admittedBeforeColdCache = false;
  const run = await f.execute({ roleId: 'maker' }, randomUUID(), f.serverContext, event => {
    if (event.kind === 'task') { assert.equal(f.calls, 0); assert.equal(f.prepares.length, 0); admittedBeforeColdCache = true; }
  });
  assert.equal(admittedBeforeColdCache, true);
  assert.equal(run.final.status?.state, TaskState.TASK_STATE_COMPLETED); assert.equal(f.prepares.length, 1); assert.equal(f.runs.length, 1);
  const target = f.runs[0]!.target;
  assert.equal(target.roleId, 'maker'); assert.equal(target.roleSkills!.roleId, 'ppt');
  assert.equal(target.roleSkills!.skills[0]!.revision, f.currentRevision());
  assert.match(f.runs[0]!.prompt, /# Canonical PPT role/); assert.ok(f.runs[0]!.prompt.includes(target.roleSkills!.skills[0]!.guidePath));
  assert.match(f.runs[0]!.prompt, /Inspect existing deck only; do not modify it/);
  const metadata = run.final.metadata?.['1agents'] as Record<string, any>;
  assert.equal(metadata.result.producer, '1agents/a2a-host'); assert.deepEqual(metadata.result.roleSkills, target.roleSkills);
  assert.equal(metadata.result.roleId, 'maker'); assert.deepEqual(f.target(run.contextId), target);
});

test('ordinary tasks keep prepared session metadata on their first Task event', async t => {
  const f = await fixture(t); let firstTask: A2ATarget | undefined;
  const run = await f.execute(undefined, randomUUID(), f.serverContext, event => {
    if (event.kind === 'task') {
      assert.equal(f.prepares.length, 1);
      firstTask = event.data.metadata?.['1agents'] as A2ATarget;
    }
  });
  assert.equal(run.final.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.ok(firstTask?.sessionId); assert.equal(firstTask?.sessionId, f.runs[0]!.target.sessionId);
  assert.equal(firstTask?.roleSkills, undefined); assert.equal(f.calls, 0);
});

test('a fresh fixed PPT preset loads its registered role while standard and general Codex presets remain ordinary', async t => {
  const f = await fixture(t);
  f.options.roleSkills!.presetRoles = { 'ppt-beautifier': 'maker' };
  let early = false;
  const ppt = await f.execute({ agentPreset: 'ppt-beautifier' }, randomUUID(), f.serverContext, event => {
    if (event.kind === 'task') { assert.equal(f.prepares.length, 0); early = true; }
  });
  assert.equal(ppt.final.status?.state, TaskState.TASK_STATE_COMPLETED); assert.equal(early, true);
  assert.equal(f.runs[0]!.target.roleId, 'maker'); assert.equal(f.runs[0]!.target.roleSkills!.roleId, 'ppt');
  const networkCalls = f.calls;
  for (const agentPreset of ['standard', 'oneagents-acp-codex']) {
    const normal = await f.execute({ agentPreset });
    assert.equal(normal.final.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(f.runs.at(-1)!.target.roleSkills, undefined);
  }
  assert.equal(f.calls, networkCalls);
  const explicit = await f.execute({ agentPreset: 'ppt-beautifier', roleId: 'reviewer' });
  assert.equal(explicit.final.status?.state, TaskState.TASK_STATE_COMPLETED); assert.equal(f.runs.at(-1)!.target.roleId, 'reviewer');
});

test('host default preset is mapped for fresh contexts but newly configured mappings never upgrade old contexts', async t => {
  const f = await fixture(t), old = await f.execute({ agentPreset: 'ppt-beautifier' });
  assert.equal(f.runs[0]!.target.roleSkills, undefined); assert.equal(f.calls, 0);
  f.options.roleSkills!.presetRoles = { 'ppt-beautifier': 'maker' };
  f.options.defaultAgentPreset = 'ppt-beautifier';
  const continued = await f.execute(undefined, old.contextId);
  assert.equal(continued.final.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(f.runs[1]!.target.roleSkills, undefined); assert.equal(f.calls, 0);
  const fresh = await f.execute();
  assert.equal(fresh.final.status?.state, TaskState.TASK_STATE_COMPLETED); assert.equal(f.runs[2]!.target.roleId, 'maker');
  f.options.roleSkills!.presetRoles = { 'ppt-beautifier': 'reviewer' };
  const typedContinuation = await f.execute(undefined, fresh.contextId);
  assert.equal(typedContinuation.final.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(f.runs[3]!.target.roleId, 'maker');
});

test('real nonblocking SendMessage returns an admitted task while a cold skill catalogue is still blocked', async t => {
  const f = await fixture(t), release = f.holdCatalogue();
  let host: Awaited<ReturnType<typeof createA2AServer>> | undefined;
  const transport = createServer((req, res) => {
    if (!host) { res.writeHead(503).end(); return; }
    void (req.url === '/.well-known/agent-card.json' ? host.cardHandler : host.handler)(req, res).catch(error => res.destroy(error));
  });
  await new Promise<void>(resolve => transport.listen(0, '127.0.0.1', resolve));
  const address = transport.address(); assert.ok(address && typeof address !== 'string');
  const publicUrl = `http://127.0.0.1:${address.port}`;
  host = await createA2AServer({ ...f.options, stateDirectory: join(f.root, 'http-state'), backend: f.backend, publicUrl, token: 'test' });
  t.after(async () => { release(); await host!.close(); transport.closeAllConnections(); await new Promise<void>(resolve => transport.close(() => resolve())); });
  const client = await new ClientFactory().createFromUrl(publicUrl);
  let timer!: ReturnType<typeof setTimeout>;
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Admission waited for cold skill loading')), 2000); })]); }
    finally { clearTimeout(timer); }
  };
  const request = SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Only test the frozen skill bootstrap.' }] },
    metadata: { '1agents': { roleId: 'maker' } }, configuration: { returnImmediately: true } });
  const task = await bounded(client.sendMessage(request, { serviceParameters: { Authorization: 'Bearer test' } }));
  assert.ok('id' in task); assert.ok(task.id); assert.equal(f.prepares.length, 0); assert.equal(f.runs.length, 0);
  await bounded(f.catalogueRequested); release(); await bounded(f.firstRun);
  assert.equal(f.runs[0]!.target.roleSkills!.skills[0]!.revision, f.currentRevision());
});

test('new contexts get hot updates while continued and restarted contexts stay fully offline on their old lock', async t => {
  const f = await fixture(t), first = await f.execute({ roleId: 'maker' });
  const old = f.runs[0]!.target.roleSkills!;
  f.text = '# Design version two'; await writeFile(join(f.root, 'ROLE.md'), '# Role version two');
  const next = await f.execute({ roleId: 'maker' }); assert.equal(next.final.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.notEqual(f.runs[1]!.target.roleSkills!.skills[0]!.revision, old.skills[0]!.revision);
  const calls = f.calls; f.online = false; await writeFile(f.profilePath, '{changed but not valid');
  await f.restart();
  const continued = await f.execute(undefined, first.contextId);
  assert.equal(continued.final.status?.state, TaskState.TASK_STATE_COMPLETED); assert.equal(f.calls, calls);
  assert.deepEqual(f.runs[2]!.target.roleSkills, old); assert.match(f.runs[2]!.prompt, /# Canonical PPT role/);
  assert.equal(f.runs[2]!.target.sessionId, f.runs[0]!.target.sessionId);
});

test('separate maker/reviewer contexts can pin one parent lock despite newer published skills', async t => {
  const f = await fixture(t); await mkdir(join(f.cacheRoot, 'locks'), { recursive: true });
  const lockPath = join(f.cacheRoot, 'locks', 'ppt-parent.json');
  const parent = await resolveRoleSkills({ profilePath: f.profilePath, cacheRoot: f.cacheRoot, lockPath });
  const before = f.calls; f.text = '# New version must not replace parent pin'; f.online = false;
  const maker = await f.execute({ roleId: 'maker', roleLockPath: lockPath });
  const reviewer = await f.execute({ roleId: 'reviewer', roleLockPath: lockPath });
  assert.equal(maker.final.status?.state, TaskState.TASK_STATE_COMPLETED); assert.equal(reviewer.final.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(f.calls, before); assert.notEqual(f.runs[0]!.target.sessionId, f.runs[1]!.target.sessionId);
  assert.equal(f.runs[0]!.target.roleSkills!.skills[0]!.revision, parent.skills[0]!.revision);
  assert.deepEqual(f.runs[0]!.target.roleSkills, f.runs[1]!.target.roleSkills);
  assert.equal(f.runs[1]!.target.roleId, 'reviewer');
});

test('context role drift, corrupt caches, outside/symlink locks and a different profile stop before the model', async t => {
  const f = await fixture(t), first = await f.execute({ roleId: 'maker' });
  const calls = f.runs.length;
  const differentRole = await f.execute({ roleId: 'reviewer' }, first.contextId);
  assert.equal(differentRole.final.status?.state, TaskState.TASK_STATE_FAILED); assert.equal(f.runs.length, calls);
  const stored = f.target(first.contextId)!;
  const outside = join(f.root, 'outside.json'); await writeFile(outside, await readFile(stored.roleSkills!.lockPath));
  const invalidOutside = await f.execute({ roleId: 'maker', roleLockPath: outside });
  assert.equal(invalidOutside.final.status?.state, TaskState.TASK_STATE_FAILED); assert.equal(f.runs.length, calls);
  const linked = join(f.cacheRoot, 'locks', 'linked.json'); await symlink(stored.roleSkills!.lockPath, linked);
  const invalidLink = await f.execute({ roleId: 'maker', roleLockPath: linked });
  assert.equal(invalidLink.final.status?.state, TaskState.TASK_STATE_FAILED); assert.equal(f.runs.length, calls);
  const otherPath = join(f.root, 'other-profile.json'); await writeFile(otherPath, JSON.stringify({ ...f.profile, id: 'other' }));
  f.options.roleSkills!.profiles.other = otherPath;
  const differentProfile = await f.execute({ roleId: 'other', roleLockPath: stored.roleSkills!.lockPath });
  assert.equal(differentProfile.final.status?.state, TaskState.TASK_STATE_FAILED); assert.equal(f.runs.length, calls);
  await writeFile(stored.roleSkills!.skills[0]!.guidePath, 'corrupt materialized bytes');
  const corrupt = await f.execute(undefined, first.contextId);
  assert.equal(corrupt.final.status?.state, TaskState.TASK_STATE_FAILED); assert.equal(f.runs.length, calls);
  const metadata = corrupt.final.metadata?.['1agents'] as Record<string, any>;
  assert.equal(metadata.result.validation.code, 'role-skills-unavailable');
});

test('existing untyped contexts cannot acquire a role; missing skills do not create sessions', async t => {
  const f = await fixture(t), old = await f.execute();
  const typed = await f.execute({ roleId: 'maker' }, old.contextId);
  assert.equal(typed.final.status?.state, TaskState.TASK_STATE_FAILED); assert.equal(f.runs.length, 1);
  f.profile.skills[0]!.name = 'unavailable'; await writeFile(f.profilePath, JSON.stringify(f.profile));
  const missing = await f.execute({ roleId: 'maker' });
  assert.equal(missing.final.status?.state, TaskState.TASK_STATE_FAILED); assert.equal(f.prepares.length, 1); assert.equal(f.runs.length, 1);
});

test('role lock identities are scoped by tenant and owner and metadata cannot override host profiles', async t => {
  const f = await fixture(t), contextId = randomUUID();
  await f.execute({ roleId: 'maker' }, contextId);
  const another = new ServerCallContext({ tenant: 'other-tenant', user: { isAuthenticated: true, userName: 'owner' } });
  await f.execute({ roleId: 'maker' }, contextId, another);
  assert.notEqual(f.runs[0]!.target.roleSkills!.lockPath, f.runs[1]!.target.roleSkills!.lockPath);
  const request = SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'work' }] }, metadata: { '1agents': { roleId: 'maker', profilePath: '/tmp/attacker' } } });
  assert.throws(() => parseA2AInput(request, f.options), /Unknown metadata/);
  request.metadata = { '1agents': { roleId: 'unknown' } };
  assert.throws(() => parseA2AInput(request, f.options), /Unknown host role/);
});

test('invalid role host configuration fails before taking a state-directory lease', async t => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-role-options-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backend: A2ABackend = { async prepare() { throw new Error('unused'); }, async run() { throw new Error('unused'); } };
  const stateDirectory = join(root, 'state');
  await assert.rejects(createA2AServer({ backend, publicUrl: 'http://localhost', token: 'test', stateDirectory, roleSkills: { cacheRoot: 'relative', profiles: {} } }), /absolute cache/);
  await assert.rejects(createA2AServer({ backend, publicUrl: 'http://localhost', token: 'test', stateDirectory,
    roleSkills: { cacheRoot: join(root, 'cache'), profiles: {}, presetRoles: { 'ppt-beautifier': 'missing' } } }), /registered host profiles/);
  const store = new FileA2AStore(stateDirectory); store.close();
});
