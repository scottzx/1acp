import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { resolveRoleSkills, skillContentRevision } from '../src/roles/index.js';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
type Skill = { id: string; source_id: string; name: string; files: Map<string, Buffer> };
const revision = (skill: Skill) => skillContentRevision([...skill.files].map(([path, bytes]) => ({ path, bytes })));
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'role-skill-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skills: Skill[] = [{ id: 'source:design', source_id: 'source', name: 'design', files: new Map([
    ['SKILL.md', Buffer.from('# Design\nRead scripts/check.mjs and ../shared/SKILL.md.')],
    ['scripts/check.mjs', Buffer.from('export const version = 1;')],
    ['assets/icon.bin', Buffer.from([0, 127, 128, 255])],
  ]) }, { id: 'source:shared', source_id: 'source', name: 'shared', files: new Map([['SKILL.md', Buffer.from('# Shared')]]) }];
  let requests = 0, fault = '', online = true;
  const asset = Buffer.from([80, 75, 3, 4, 255, 0, 1]);
  const server = createServer((req, res) => {
    requests++;
    if (!online) { res.writeHead(503).end(); return; }
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/asset') { res.end(fault === 'asset' ? Buffer.from('bad') : asset); return; }
    if (url.pathname === '/skills') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ skills: skills.map(skill => ({ id: skill.id, source_id: skill.source_id, name: skill.name, revision: revision(skill) })), has_more: false })); return;
    }
    const skill = skills.find(skill => '/skills/' + encodeURIComponent(skill.id) === url.pathname);
    if (!skill) { res.writeHead(404).end(); return; }
    const current = revision(skill);
    if (url.searchParams.get('revision') !== current || fault === 'conflict' && url.searchParams.has('resource')) { res.writeHead(409).end(); return; }
    const resource = url.searchParams.get('resource') ?? 'SKILL.md', bytes = skill.files.get(resource);
    if (!bytes) { res.writeHead(404).end(); return; }
    const binary = resource.endsWith('.bin');
    const resources = [...skill.files].map(([path, bytes]) => ({ path, bytes: bytes.length }));
    if (fault === 'traversal') resources.push({ path: '../escape', bytes: 1 });
    if (fault === 'size') resources[0]!.bytes++;
    res.end(JSON.stringify({ id: skill.id, source_id: skill.source_id, name: skill.name,
      revision: fault === 'mixed' && resource !== 'SKILL.md' ? '0'.repeat(64) : current,
      resource, content: binary ? bytes.toString('base64') : new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: binary ? 'base64' : 'utf8', resources }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const profilePath = join(root, 'profile.json');
  const profile = { id: 'ppt', version: '1.0', network: { agentUrl: url }, instructionsPath: 'ROLE.md', entrySkill: 'design',
    skills: [{ key: 'design', name: 'design' }, { key: 'shared', name: 'shared' }] as { key: string; name: string; sourceId?: string; assetsManifest?: string }[] };
  await writeFile(profilePath, JSON.stringify(profile)); await writeFile(join(root, 'ROLE.md'), '# PPT role');
  return { root, profilePath, profile, skills, url, asset, options: { profilePath, cacheRoot: join(root, '.cache', 'roles'), lockPath: join(root, 'jobs', 'one', 'role-skills.lock.json') },
    updateProfile: () => writeFile(profilePath, JSON.stringify(profile)), get requests() { return requests; }, set fault(value: string) { fault = value; }, set online(value: boolean) { online = value; } };
}

test('full text/binary package is cached, sibling guides stay resolvable and task lock is offline', async t => {
  const f = await fixture(t), first = await resolveRoleSkills(f.options);
  assert.equal(first.roleId, 'ppt'); assert.equal(first.skills.length, 2);
  const design = first.skills[0]!;
  assert.equal(await readFile(first.instructionsPath!, 'utf8'), '# PPT role');
  assert.deepEqual(await readFile(join(design.directory, 'assets/icon.bin')), Buffer.from([0, 127, 128, 255]));
  assert.equal(await readFile(join(design.directory, '../shared/SKILL.md'), 'utf8'), '# Shared');
  assert.equal(first.entryGuidePath, design.guidePath);
  assert.equal(design.revision, revision(f.skills[0]!));
  assert.equal(await readFile(join(first.roleDirectory, 'profile.json'), 'utf8'), JSON.stringify(f.profile));
  const before = f.requests;
  f.online = false; await writeFile(f.profilePath, '{invalid updated profile');
  assert.deepEqual(await resolveRoleSkills(f.options), first); assert.equal(f.requests, before);
  await rm(f.profilePath);
  assert.deepEqual(await resolveRoleSkills(f.options), first); assert.equal(f.requests, before);
});

test('new tasks resolve refreshed skills and role instructions; existing tasks retain old revision', async t => {
  const f = await fixture(t), old = await resolveRoleSkills(f.options);
  f.skills[0]!.files.set('scripts/check.mjs', Buffer.from('export const version = 2;'));
  await writeFile(join(f.root, 'ROLE.md'), '# Updated role');
  const next = await resolveRoleSkills({ ...f.options, lockPath: join(f.root, 'jobs/two/lock.json') });
  assert.notEqual(old.skills[0]!.revision, next.skills[0]!.revision);
  assert.notEqual(old.roleDirectory, next.roleDirectory);
  assert.match(await readFile(join(next.skills[0]!.directory, 'scripts/check.mjs'), 'utf8'), /version = 2/);
  assert.match(await readFile(join(old.skills[0]!.directory, 'scripts/check.mjs'), 'utf8'), /version = 1/);
  assert.deepEqual(await resolveRoleSkills(f.options), old);
  assert.equal(await readFile(old.instructionsPath!, 'utf8'), '# PPT role');
  assert.equal(await readFile(next.instructionsPath!, 'utf8'), '# Updated role');
});

test('physical cache/profile migration with old root aliases reuses an unchanged task lock offline', async t => {
  const f = await fixture(t), old = await resolveRoleSkills(f.options);
  const original = await readFile(f.options.lockPath), calls = f.requests;
  const cacheRoot = join(f.root, '.1agents/cache/roles'), profilePath = join(f.root, '.1agents/roles/ppt/profile.json');
  await mkdir(dirname(cacheRoot), { recursive: true }); await mkdir(dirname(profilePath), { recursive: true });
  await rename(f.options.cacheRoot, cacheRoot); await symlink(cacheRoot, f.options.cacheRoot, 'dir');
  await rename(f.profilePath, profilePath); await symlink(profilePath, f.profilePath);
  await cp(join(f.root, 'ROLE.md'), join(dirname(profilePath), 'ROLE.md'));
  f.online = false;
  assert.deepEqual(await resolveRoleSkills({ ...f.options, cacheRoot, profilePath }), old);
  assert.deepEqual(await readFile(f.options.lockPath), original); assert.equal(f.requests, calls);
  assert.equal(await readFile(old.skills[0]!.guidePath, 'utf8'), f.skills[0]!.files.get('SKILL.md')!.toString());
  f.online = true;
  const fresh = await resolveRoleSkills({ profilePath, cacheRoot, lockPath: join(cacheRoot, 'locks', 'new-task.json') });
  assert.equal(fresh.profilePath, profilePath); assert.equal(fresh.cacheRoot, cacheRoot);
  assert.ok(fresh.entryGuidePath!.startsWith(cacheRoot + '/'));
  assert.deepEqual(await readFile(f.options.lockPath), original);
});

test('an old lock cannot bind a different physical cache or an identical but unrelated profile', async t => {
  const f = await fixture(t); await resolveRoleSkills(f.options);
  const cacheRoot = join(f.root, '.1agents/cache/roles'), profilePath = join(f.root, 'unrelated/profile.json');
  await cp(f.options.cacheRoot, cacheRoot, { recursive: true });
  await assert.rejects(resolveRoleSkills({ ...f.options, cacheRoot }), /cache binding mismatch/);
  await mkdir(dirname(profilePath), { recursive: true }); await cp(f.profilePath, profilePath);
  await assert.rejects(resolveRoleSkills({ ...f.options, profilePath }), /another profile/);
});

test('root alias compatibility does not permit a skill subdirectory symlink escape', async t => {
  const f = await fixture(t), old = await resolveRoleSkills(f.options);
  const cacheRoot = join(f.root, '.1agents/cache/roles'); await mkdir(dirname(cacheRoot), { recursive: true });
  await rename(f.options.cacheRoot, cacheRoot); await symlink(cacheRoot, f.options.cacheRoot, 'dir');
  const files = join(old.skills[0]!.cacheDirectory, 'files'), outside = join(f.root, 'outside-files');
  await rename(files, outside); await symlink(outside, files, 'dir');
  await assert.rejects(resolveRoleSkills({ ...f.options, cacheRoot }), /symlink or non-directory/);
});

test('provider UTF-8 decoding that strips a BOM still yields the exact original package bytes', async t => {
  const f = await fixture(t), original = Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from('<schema/>')]);
  f.skills[0]!.files.set('schemas/bom.xsd', original);
  const lock = await resolveRoleSkills(f.options);
  assert.deepEqual(await readFile(join(lock.skills[0]!.directory, 'schemas/bom.xsd')), original);
  assert.equal(lock.skills[0]!.revision, revision(f.skills[0]!));
});

test('assets are separately content addressed and materialized without changing skill revision', async t => {
  const f = await fixture(t);
  const manifest = { assets: [{ path: 'assets/template.pptx', bytes: f.asset.length, sha256: hash(f.asset), url: f.url + '/asset' }] };
  f.skills[0]!.files.set('assets-manifest.json', Buffer.from(JSON.stringify(manifest))); f.profile.skills[0]!.assetsManifest = 'assets-manifest.json'; await f.updateProfile();
  const lock = await resolveRoleSkills(f.options), design = lock.skills[0]!;
  assert.deepEqual(await readFile(join(design.directory, 'assets/template.pptx')), f.asset);
  assert.deepEqual(await readFile(join(lock.cacheRoot, 'assets', hash(f.asset), 'blob')), f.asset);
  assert.equal(design.revision, revision(f.skills[0]!));
  assert.ok(!design.files.some(file => file.path === 'assets/template.pptx'));
  f.online = false; const before = f.requests;
  assert.deepEqual(await resolveRoleSkills(f.options), lock); assert.equal(f.requests, before);
});

test('corrupt pure cache, role snapshot or asset blob are rejected rather than silently upgraded', async t => {
  for (const location of ['pack', 'snapshot', 'asset']) {
    const f = await fixture(t);
    if (location === 'asset') {
      f.skills[0]!.files.set('assets-manifest.json', Buffer.from(JSON.stringify({ assets: [{ path: 'assets/template.pptx', bytes: f.asset.length, sha256: hash(f.asset), url: f.url + '/asset' }] })));
      f.profile.skills[0]!.assetsManifest = 'assets-manifest.json'; await f.updateProfile();
    }
    const lock = await resolveRoleSkills(f.options), skill = lock.skills[0]!;
    const path = location === 'pack' ? join(skill.cacheDirectory, 'files/SKILL.md') : location === 'snapshot' ? skill.guidePath : join(lock.cacheRoot, 'assets', hash(f.asset), 'blob');
    await writeFile(path, 'tamper'); const before = f.requests;
    await assert.rejects(resolveRoleSkills(f.options), /byte\/hash mismatch/); assert.equal(f.requests, before);
  }
});

for (const fault of ['traversal', 'size', 'mixed', 'conflict']) test(`a ${fault} response never produces a usable task lock`, async t => {
  const f = await fixture(t); f.fault = fault;
  await assert.rejects(resolveRoleSkills(f.options));
  await assert.rejects(readFile(f.options.lockPath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});

test('ambiguous names require an explicit source identity', async t => {
  const f = await fixture(t);
  f.skills.push({ ...f.skills[0]!, id: 'other:design', source_id: 'other' });
  await assert.rejects(resolveRoleSkills(f.options), /Ambiguous skill/);
  f.profile.skills[0]!.sourceId = 'source'; await f.updateProfile();
  assert.equal((await resolveRoleSkills(f.options)).skills[0]!.sourceId, 'source');
});

test('concurrent cache/lock installation is atomic and returns one consistent winner', async t => {
  const f = await fixture(t);
  const locks = await Promise.all(Array.from({ length: 4 }, () => resolveRoleSkills(f.options)));
  for (const lock of locks) assert.deepEqual(lock, locks[0]);
  assert.equal((await resolveRoleSkills(f.options)).skills[0]!.revision, revision(f.skills[0]!));
});

test('cache symlink and downloaded asset hash mismatch are rejected', async t => {
  const f = await fixture(t), lock = await resolveRoleSkills(f.options), path = lock.skills[0]!.guidePath;
  await rm(path); await symlink(join(f.root, 'ROLE.md'), path);
  await assert.rejects(resolveRoleSkills(f.options), /Symlink|regular file/i);
  const other = await fixture(t);
  other.skills[0]!.files.set('assets-manifest.json', Buffer.from(JSON.stringify({ assets: [{ path: 'assets/template.pptx', bytes: other.asset.length, sha256: hash(other.asset), url: other.url + '/asset' }] })));
  other.profile.skills[0]!.assetsManifest = 'assets-manifest.json'; await other.updateProfile(); other.fault = 'asset';
  await assert.rejects(resolveRoleSkills(other.options), /asset byte\/hash mismatch/);
});
