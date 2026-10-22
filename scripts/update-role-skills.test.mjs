import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { publishRoleSkills } from './publish-role-skills.mjs';
import { updateRoleSkills } from './update-role-skills.mjs';

const guide = label => `---\nname: design\ndescription: Editable slide design.\n---\n${label}\n`;
const save = async (path, bytes) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); };
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

async function fixture(t, existing = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), '1acp-role-update-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDirectory = join(root, 'source'), cacheRoot = join(root, '.cache/roles'), catalogDirectory = join(cacheRoot, 'catalog/ppt'), publicDirectory = join(root, 'public');
  await save(join(sourceDirectory, 'design/SKILL.md'), guide('old'));
  const config = { sourceDirectory, catalogDirectory, publicDirectory, publicBaseUrl: '', cacheRoot,
    sourceName: 'fixture-design', agentUrl: '', profiles: [join(root, 'profile.json')] };
  const sources = new Map(), requests = [];
  let refreshFailure = false, registrationResponseFailure = false, registrationDirectory;
  const server = createServer(async (req, res) => {
    requests.push([req.method, req.url]);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/skills/sources' && req.method === 'GET') { res.end(JSON.stringify({ sources: [...sources.values()] })); return; }
    if (req.url === '/skills/sources' && req.method === 'POST') {
      const source = { id: `skills-${body.name}`, name: body.name, dir: registrationDirectory ?? body.dir, status: 'ready' }; sources.set(source.id, source);
      if (registrationResponseFailure) { res.writeHead(502).end('{}'); return; }
      res.writeHead(201).end(JSON.stringify(source)); return;
    }
    if (req.url === '/skills/sources/skills-fixture-design/refresh' && req.method === 'POST') {
      if (refreshFailure) { res.writeHead(500).end('{}'); return; }
      res.end(JSON.stringify({ skills: [], diagnostics: [] })); return;
    }
    if (req.url === '/skills/sources/skills-fixture-design' && req.method === 'DELETE') { sources.delete('skills-fixture-design'); res.end(JSON.stringify({ removed: 'skills-fixture-design' })); return; }
    res.writeHead(404).end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.agentUrl = `http://127.0.0.1:${server.address().port}`; config.publicBaseUrl = config.agentUrl + '/artifacts';
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  if (existing) {
    await publishRoleSkills({ ...config, outputDirectory: catalogDirectory });
    sources.set('skills-fixture-design', { id: 'skills-fixture-design', name: 'fixture-design', dir: catalogDirectory, status: 'ready' });
  }
  await save(join(sourceDirectory, 'design/SKILL.md'), guide('new'));
  const current = join(config.cacheRoot, 'current/ppt.json'), oldLock = join(config.cacheRoot, 'locks/existing-task.json');
  await save(current, '{"old":"verified"}\n'); await save(oldLock, '{"pinned":"original"}\n');
  const resolver = async options => {
    await save(options.lockPath, '{"new":"warm-up-lock"}\n');
    return { roleId: 'ppt', roleVersion: '2', roleDirectory: join(config.cacheRoot, 'roles/ppt/new'), entryGuidePath: '/unused/SKILL.md',
      skills: [{ key: 'design', skillId: 'source:design', sourceId: 'skills-fixture-design', revision: 'a'.repeat(64) }] };
  };
  const failure = async promise => { try { await promise; assert.fail('Expected update failure'); } catch (error) { assert.ok(error.receiptPath); return { error, receipt: JSON.parse(await readFile(error.receiptPath, 'utf8')) }; } };
  return { root, config, sources, requests, resolver, current, oldLock, failure,
    set refreshFailure(value) { refreshFailure = value; }, set registrationResponseFailure(value) { registrationResponseFailure = value; },
    set registrationDirectory(value) { registrationDirectory = value; } };
}

test('successful update warms all roles before switching current pointers and writing a completed receipt', async t => {
  const f = await fixture(t, false);
  const receipt = await updateRoleSkills(f.config, async options => {
    assert.equal(await readFile(f.current, 'utf8'), '{"old":"verified"}\n');
    assert.deepEqual(await readdir(join(f.config.cacheRoot, 'updates')), []);
    return f.resolver(options);
  });
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.modelTasksDispatched, 0);
  assert.equal(f.sources.size, 1);
  assert.equal(JSON.parse(await readFile(f.current, 'utf8')).roleVersion, '2');
  assert.equal(JSON.parse(await readFile(join(f.config.cacheRoot, 'updates', `${receipt.updateId}.json`), 'utf8')).status, 'completed');
  assert.equal(await readFile(f.oldLock, 'utf8'), '{"pinned":"original"}\n');
  await assert.rejects(readFile(join(f.config.cacheRoot, '.update.lock')), /ENOENT/);
});

test('a migrated catalogue accepts the registered legacy alias and preserves the source ID', async t => {
  const f = await fixture(t), legacyCache = f.config.cacheRoot, legacyCatalogue = f.config.catalogDirectory;
  const migratedCache = join(f.root, '.1agents/cache/roles');
  await mkdir(dirname(migratedCache), { recursive: true });
  await rename(legacyCache, migratedCache);
  await symlink(migratedCache, legacyCache, 'dir');
  f.config.cacheRoot = migratedCache;
  f.config.catalogDirectory = join(migratedCache, 'catalog/ppt');
  assert.equal(await realpath(legacyCatalogue), await realpath(f.config.catalogDirectory));
  const receipt = await updateRoleSkills(f.config, f.resolver);
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.sourceId, 'skills-fixture-design');
  assert.equal(f.sources.size, 1); assert.equal(f.sources.get(receipt.sourceId).dir, legacyCatalogue);
  assert.equal(f.requests.some(([method, path]) => method === 'POST' && path === '/skills/sources'), false);
  assert.equal(await readFile(join(legacyCatalogue, 'design/SKILL.md'), 'utf8'), guide('new'));
  assert.equal(JSON.parse(await readFile(f.current, 'utf8')).roleVersion, '2');
  assert.equal(await readFile(f.oldLock, 'utf8'), '{"pinned":"original"}\n');
});

test('a registered source alias to a different directory is rejected before publishing', async t => {
  const f = await fixture(t), other = join(f.root, 'unrelated-catalogue'), alias = join(f.root, 'source-alias');
  await mkdir(other); await symlink(other, alias, 'dir');
  f.sources.get('skills-fixture-design').dir = alias;
  const { error, receipt } = await f.failure(updateRoleSkills(f.config, f.resolver));
  assert.match(error.message, /Existing source points to another directory/);
  assert.equal(receipt.rollback.catalogueRestored, false);
  assert.equal(await readFile(join(f.config.catalogDirectory, 'design/SKILL.md'), 'utf8'), guide('old'));
  assert.equal(f.requests.some(([method]) => method === 'POST' || method === 'DELETE'), false);
});

test('warm-up failure restores the previous live catalogue and preserves old pointers and task locks', async t => {
  const f = await fixture(t);
  const { receipt } = await f.failure(updateRoleSkills(f.config, async () => { throw new Error('Asset GET failed: 404'); }));
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.rollback.status, 'completed');
  assert.equal(receipt.rollback.catalogueRestored, true);
  assert.equal(await readFile(join(f.config.catalogDirectory, 'design/SKILL.md'), 'utf8'), guide('old'));
  assert.equal(await readFile(join(receipt.rollback.failedDirectory, 'design/SKILL.md'), 'utf8'), guide('new'));
  assert.equal(await readFile(f.current, 'utf8'), '{"old":"verified"}\n');
  assert.equal(await readFile(f.oldLock, 'utf8'), '{"pinned":"original"}\n');
  assert.equal(f.sources.size, 1);
  assert.ok((await readdir(join(f.config.cacheRoot, 'updates'))).every(name => name.startsWith('failed-')));
});

test('failed first refresh unregisters the new source and leaves no failed catalogue advertised', async t => {
  const f = await fixture(t, false); f.refreshFailure = true;
  const { receipt } = await f.failure(updateRoleSkills(f.config, f.resolver));
  assert.equal(f.sources.size, 0); assert.equal(receipt.rollback.sourceRemoved, true);
  assert.equal(receipt.rollback.catalogueRestored, true);
  await assert.rejects(readFile(join(f.config.catalogDirectory, 'design/SKILL.md')), /ENOENT/);
  assert.equal(await readFile(f.current, 'utf8'), '{"old":"verified"}\n');
});

test('failed first refresh can unregister a new source stored through an equivalent directory alias', async t => {
  const f = await fixture(t, false), alias = join(f.root, 'registered-catalogue-alias');
  await symlink(f.config.catalogDirectory, alias, 'dir');
  f.registrationDirectory = alias; f.refreshFailure = true;
  const { receipt } = await f.failure(updateRoleSkills(f.config, f.resolver));
  assert.equal(f.sources.size, 0); assert.equal(receipt.rollback.sourceRemoved, true);
  assert.equal(receipt.rollback.status, 'completed');
  assert.ok(f.requests.some(([method]) => method === 'DELETE'));
});

test('new-source rollback refuses to unregister an alias that points to a different directory', async t => {
  const f = await fixture(t, false), other = join(f.root, 'other-owner'), alias = join(f.root, 'registered-other-alias');
  await mkdir(other); await symlink(other, alias, 'dir');
  f.registrationDirectory = alias; f.refreshFailure = true;
  const { receipt } = await f.failure(updateRoleSkills(f.config, f.resolver));
  assert.equal(f.sources.size, 1); assert.equal(receipt.rollback.sourceRemoved, false);
  assert.equal(receipt.rollback.status, 'failed');
  assert.match(receipt.rollback.errors.join(';'), /New source was replaced outside this update/);
  assert.equal(f.requests.some(([method]) => method === 'DELETE'), false);
});

test('an errored registration response is checked for committed state before undoing it', async t => {
  const f = await fixture(t, false); f.registrationResponseFailure = true;
  const { receipt } = await f.failure(updateRoleSkills(f.config, f.resolver));
  assert.equal(f.sources.size, 0); assert.equal(receipt.rollback.status, 'completed');
  assert.ok(f.requests.some(([method]) => method === 'DELETE'));
  assert.equal(await readFile(f.current, 'utf8'), '{"old":"verified"}\n');
});

test('one update holds both the transaction and publisher lease through warm-up', async t => {
  const f = await fixture(t), warming = deferred(), release = deferred();
  const pending = updateRoleSkills(f.config, async options => { warming.resolve(); await release.promise; return f.resolver(options); });
  await warming.promise;
  try {
    await assert.rejects(updateRoleSkills(f.config, f.resolver), /transaction lock/);
    await assert.rejects(publishRoleSkills({ ...f.config, outputDirectory: f.config.catalogDirectory }), /output lock/);
  } finally { release.resolve(); }
  assert.equal((await pending).status, 'completed');
});

test('a later role warm-up failure does not switch any current role pointer', async t => {
  const f = await fixture(t); f.config.profiles.push(join(f.root, 'other-profile.json'));
  let calls = 0;
  const { receipt } = await f.failure(updateRoleSkills(f.config, async options => {
    if (calls++ > 0) throw new Error('Second role unavailable');
    return f.resolver(options);
  }));
  assert.equal(receipt.roles.length, 1); assert.equal(receipt.createdLockPaths.length, 2);
  assert.equal(await readFile(f.current, 'utf8'), '{"old":"verified"}\n');
  assert.equal(await readFile(join(f.config.catalogDirectory, 'design/SKILL.md'), 'utf8'), guide('old'));
  assert.equal(await readFile(receipt.roles[0].lockPath, 'utf8'), '{"new":"warm-up-lock"}\n');
});

test('success-receipt failure rolls applied current pointers back and emits only a failure receipt', async t => {
  const f = await fixture(t);
  const { receipt } = await f.failure(updateRoleSkills(f.config, async options => {
    const id = /^update-(.*)-0\.json$/.exec(basename(options.lockPath))[1];
    await mkdir(join(f.config.cacheRoot, 'updates', `${id}.json`));
    return f.resolver(options);
  }));
  assert.equal(receipt.rollback.pointersRestored, 1); assert.equal(receipt.rollback.status, 'completed');
  assert.equal(await readFile(f.current, 'utf8'), '{"old":"verified"}\n');
  assert.equal(await readFile(join(f.config.catalogDirectory, 'design/SKILL.md'), 'utf8'), guide('old'));
});

test('rollback refuses to overwrite a catalogue changed outside the coordinated publisher entry point', async t => {
  const f = await fixture(t);
  const { receipt } = await f.failure(updateRoleSkills(f.config, async () => {
    await save(join(f.config.catalogDirectory, 'design/SKILL.md'), guide('external edit'));
    throw new Error('Warm-up failed');
  }));
  assert.equal(receipt.rollback.status, 'failed'); assert.equal(receipt.rollback.catalogueRestored, false);
  assert.match(receipt.rollback.errors.join(';'), /refusing to overwrite/);
  assert.equal(await readFile(join(f.config.catalogDirectory, 'design/SKILL.md'), 'utf8'), guide('external edit'));
  assert.equal(await readFile(f.current, 'utf8'), '{"old":"verified"}\n');
});

test('overlong source names are rejected before mutating the publication', async t => {
  const f = await fixture(t); f.config.sourceName = 'a'.repeat(65);
  await assert.rejects(updateRoleSkills(f.config, f.resolver), /Invalid sourceName/);
  assert.equal(await readFile(join(f.config.catalogDirectory, 'design/SKILL.md'), 'utf8'), guide('old'));
});
