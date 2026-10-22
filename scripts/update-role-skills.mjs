#!/usr/bin/env node
/** One explicit publication + network refresh + role cache warm-up. Never dispatches an agent. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { publishRoleSkills, withRoleSkillPublicationLock } from './publish-role-skills.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function exists(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function plainDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Update storage must be a plain directory');
}
async function plainFile(path) {
  const info = await exists(path);
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Current role pointer must be a plain file');
  return readFile(path);
}
async function atomicFile(path, bytes, token) {
  const temporary = `${path}.${token}.tmp`;
  try { await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
async function treeFingerprint(root) {
  const result = createHash('sha256');
  async function visit(directory, parent = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) {
      const path = join(directory, entry.name), resource = parent ? `${parent}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Published catalogue contains a symlink');
      if (entry.isDirectory()) await visit(path, resource);
      else if (entry.isFile()) { const bytes = await readFile(path); result.update(`${resource}\0${bytes.length}\0`).update(bytes); }
      else throw new Error('Published catalogue contains an unsupported entry');
    }
  }
  await visit(root); return result.digest('hex');
}

export async function updateRoleSkills(config, resolver) {
  for (const key of ['sourceDirectory', 'catalogDirectory', 'cacheRoot', 'publicDirectory', 'publicBaseUrl', 'agentUrl', 'sourceName']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) throw new Error(`Missing ${key}`);
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(config.sourceName)) throw new Error('Invalid sourceName');
  if (!Array.isArray(config.profiles) || !config.profiles.length || config.profiles.some(p => typeof p !== 'string' || !p)) throw new Error('profiles must contain role profile paths');
  const agent = new URL(config.agentUrl);
  if (agent.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(agent.hostname)
      || agent.username || agent.password || agent.search || agent.hash) throw new Error('Skill source management requires a loopback Node URL');
  const request = async (path, { method = 'GET', body } = {}) => {
    const url = new URL(agent); url.pathname = url.pathname.replace(/\/$/, '') + path;
    const response = await fetch(url, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60000), redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Skill source operation failed (HTTP ${response.status})`); }
    const value = await response.json();
    if (value?.error) throw new Error('Skill source operation returned an error');
    return value;
  };
  const sourceId = `skills-${config.sourceName}`, updateId = randomUUID();
  const cacheRoot = resolve(config.cacheRoot), catalogue = resolve(config.catalogDirectory), roles = [], pointers = [];
  await plainDirectory(cacheRoot);
  const transactionPath = join(cacheRoot, '.update.lock');
  const transaction = await open(transactionPath, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error('Another role skill update holds the transaction lock'); throw error;
  });
  try {
    await transaction.writeFile(JSON.stringify({ updateId, pid: process.pid, createdAt: new Date().toISOString() }));
    const receipts = join(cacheRoot, 'updates'); await plainDirectory(receipts);
    return await withRoleSkillPublicationLock(catalogue, async () => {
      let publication, publicationFingerprint, registrationAttempted = false, previousSource;
      const lockPaths = [];
      try {
        const sources = await request('/skills/sources');
        if (!Array.isArray(sources.sources)) throw new Error('Unexpected skill sources response');
        previousSource = sources.sources.find(source => source.id === sourceId);
        if (previousSource && resolve(previousSource.dir ?? '') !== catalogue) throw new Error('Existing source points to another directory');
        publication = await publishRoleSkills({ sourceDirectory: config.sourceDirectory, outputDirectory: catalogue,
          publicDirectory: config.publicDirectory, publicBaseUrl: config.publicBaseUrl });
        publicationFingerprint = await treeFingerprint(catalogue);
        if (!previousSource) {
          registrationAttempted = true;
          const registered = await request('/skills/sources', { method: 'POST', body: { name: config.sourceName, dir: await realpath(catalogue) } });
          if (registered.status === 'error') throw new Error('Published skill source scan failed');
        }
        const refreshed = await request(`/skills/sources/${encodeURIComponent(sourceId)}/refresh`, { method: 'POST', body: {} });
        if (refreshed.diagnostics?.some(diagnostic => diagnostic.source_id === sourceId)) throw new Error('Published skill source refresh failed');
        for (const profile of config.profiles) {
          const lockPath = join(cacheRoot, 'locks', `update-${updateId}-${roles.length}.json`); lockPaths.push(lockPath);
          const lock = await resolver({ profilePath: resolve(profile), cacheRoot, lockPath });
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(lock.roleId) || roles.some(role => role.roleId === lock.roleId)) throw new Error('Invalid or duplicate updated role ID');
          roles.push({ roleId: lock.roleId, roleVersion: lock.roleVersion, lockPath, roleDirectory: lock.roleDirectory,
            entryGuidePath: lock.entryGuidePath, skills: lock.skills.map(({ key, skillId, sourceId, revision }) => ({ key, skillId, sourceId, revision })) });
        }
        const current = join(cacheRoot, 'current'); await plainDirectory(current);
        for (const role of roles) {
          const path = join(current, `${role.roleId}.json`);
          pointers.push({ path, previous: await plainFile(path), replacement: Buffer.from(JSON.stringify(role, null, 2) + '\n'), applied: false });
        }
        for (const pointer of pointers) { await atomicFile(pointer.path, pointer.replacement, updateId); pointer.applied = true; }
        const receipt = { schemaVersion: 1, status: 'completed', updateId, updatedAt: new Date().toISOString(), sourceId, publication, roles,
          modelTasksDispatched: 0, existingTaskLocksChanged: false };
        await atomicFile(join(receipts, `${updateId}.json`), JSON.stringify(receipt, null, 2) + '\n', updateId);
        return receipt;
      } catch (error) {
        const rollbackErrors = [], rollback = { pointersRestored: 0, sourceRemoved: false, catalogueRestored: false };
        for (const pointer of [...pointers].reverse().filter(pointer => pointer.applied)) {
          try {
            const current = await plainFile(pointer.path);
            if (!current || hash(current) !== hash(pointer.replacement)) throw new Error('Current pointer changed outside this update; refusing to overwrite');
            if (pointer.previous) await atomicFile(pointer.path, pointer.previous, `${updateId}-rollback`);
            else await rm(pointer.path);
            rollback.pointersRestored++;
          } catch (failure) { rollbackErrors.push(failure.message); }
        }
        if (registrationAttempted && !previousSource) {
          try {
            // A failed response can still follow a committed registration; read before undoing it.
            const sources = await request('/skills/sources');
            if (!Array.isArray(sources.sources)) throw new Error('Cannot verify new skill source registration');
            const actual = sources.sources.find(source => source.id === sourceId);
            if (actual) {
              if (resolve(actual.dir ?? '') !== catalogue) throw new Error('New source was replaced outside this update; refusing to remove it');
              await request(`/skills/sources/${encodeURIComponent(sourceId)}`, { method: 'DELETE' });
            }
            rollback.sourceRemoved = true;
          } catch (failure) { rollbackErrors.push(failure.message); }
        }
        if (publication) {
          try {
            if (publicationFingerprint !== undefined && await treeFingerprint(catalogue) !== publicationFingerprint) throw new Error('Catalogue changed outside this update; refusing to overwrite it');
            const failedDirectory = join(dirname(catalogue), `.${basename(catalogue)}.failed-${updateId}`);
            await rename(catalogue, failedDirectory); rollback.failedDirectory = failedDirectory;
            if (publication.previousDirectory) {
              try { await rename(publication.previousDirectory, catalogue); }
              catch (failure) { await rename(failedDirectory, catalogue); throw failure; }
            }
            rollback.catalogueRestored = true;
          } catch (failure) { rollbackErrors.push(failure.message); }
        }
        const failed = { schemaVersion: 1, status: 'failed', updateId, failedAt: new Date().toISOString(), sourceId,
          error: error.message, rollback: { ...rollback, status: rollbackErrors.length ? 'failed' : 'completed', errors: rollbackErrors },
          publication, roles, createdLockPaths: lockPaths, modelTasksDispatched: 0, existingTaskLocksChanged: false };
        const receiptPath = join(receipts, `failed-${updateId}.json`);
        try { await atomicFile(receiptPath, JSON.stringify(failed, null, 2) + '\n', updateId); }
        catch (failure) { rollbackErrors.push(`Could not save failure receipt: ${failure.message}`); }
        const failure = new Error(`${error.message}; update failed${rollbackErrors.length ? ' and rollback requires attention' : ' and was rolled back'}; receipt: ${receiptPath}`, { cause: error });
        failure.receiptPath = receiptPath; failure.receipt = failed; throw failure;
      }
    });
  } finally { await transaction.close(); await rm(transactionPath, { force: true }); }
}

async function main() {
  const { values } = parseArgs({ options: { config: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true });
  if (values.help) { console.log('Usage: node scripts/update-role-skills.mjs --config roles/local-update.json\nPublishes guides/assets, refreshes Skill Manager and warms new role locks in .cache/roles. Existing task locks are never replaced. Run pnpm build first.'); return; }
  if (!values.config) throw new Error('--config is required');
  const config = JSON.parse(await readFile(resolve(values.config), 'utf8'));
  const { resolveRoleSkills } = await import(new URL('../packages/service/dist/src/roles/index.js', import.meta.url));
  console.log(JSON.stringify(await updateRoleSkills(config, resolveRoleSkills), null, 2));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
