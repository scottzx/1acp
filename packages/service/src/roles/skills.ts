/** Task-pinned skills from a DreamMate catalogue; this module never invokes a model or executes skill code. */
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const absolute = z.string().refine(isAbsolute, 'Expected an absolute path');
const endpoint = z.string().url().refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, 'Expected an HTTP(S) URL without credentials, query or fragment');
const resourcePath = z.string().min(1).max(4096).refine(value => !value.includes('\\') && !value.includes('\0')
  && !value.startsWith('/') && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'), 'Invalid relative resource path');
const requirement = z.object({ key: identifier, name: z.string().min(1), nodeUrl: endpoint.optional(),
  skillId: z.string().min(1).optional(), sourceId: z.string().min(1).optional(), assetsManifest: resourcePath.optional() }).strict();
export const roleSkillProfileSchema = z.object({ id: identifier, version: z.string().min(1), instructionsPath: z.string().min(1).optional(),
  network: z.object({ agentUrl: endpoint, timeoutMs: z.number().int().min(100).max(120000).default(30000) }).strict(),
  skills: z.array(requirement).min(1).max(100), entrySkill: identifier.optional() }).strict().superRefine((value, ctx) => {
  if (new Set(value.skills.map(skill => skill.key)).size !== value.skills.length) ctx.addIssue({ code: 'custom', message: 'Duplicate skill key' });
  if (value.entrySkill && !value.skills.some(skill => skill.key === value.entrySkill)) ctx.addIssue({ code: 'custom', message: 'Unknown entrySkill' });
});
export type RoleSkillProfile = z.infer<typeof roleSkillProfileSchema>;
const inventoryEntry = z.object({ path: resourcePath, bytes: z.number().int().nonnegative().max(128 * 1024 * 1024), sha256: sha }).strict();
const assetEntry = inventoryEntry.extend({ url: endpoint });
const lockedSkill = z.object({ key: identifier, nodeUrl: endpoint, skillId: z.string().min(1), sourceId: z.string().min(1), name: z.string().min(1),
  revision: sha, cacheDirectory: absolute, directory: absolute, guidePath: absolute, guideResource: resourcePath,
  files: z.array(inventoryEntry).min(1).max(2000), assets: z.array(assetEntry).max(2000) }).strict();
export const roleSkillLockSchema = z.object({ schemaVersion: z.literal(1), roleId: identifier, roleVersion: z.string().min(1),
  profilePath: absolute, profileSha256: sha, cacheRoot: absolute, roleDirectory: absolute, createdAt: z.string(),
  instructionsPath: absolute.optional(), instructionsSha256: sha.optional(), instructionsBytes: z.number().int().nonnegative().optional(),
  entrySkill: identifier.optional(), entryGuidePath: absolute.optional(), skills: z.array(lockedSkill).min(1).max(100) }).strict();
export type RoleSkillLock = z.infer<typeof roleSkillLockSchema>;
type LockedSkill = z.infer<typeof lockedSkill>;
type FileEntry = z.infer<typeof inventoryEntry>;
const catalogueEntry = z.object({ id: z.string().min(1), source_id: z.string().min(1), name: z.string().min(1), revision: sha }).passthrough();
const readResult = z.object({ id: z.string().min(1), source_id: z.string().min(1), name: z.string().min(1), revision: sha,
  resource: resourcePath, content: z.string(), encoding: z.enum(['utf8', 'base64']),
  resources: z.array(z.object({ path: resourcePath, bytes: z.number().int().nonnegative().max(8 * 1024 * 1024) }).passthrough()).max(2000).optional() }).passthrough();
const receiptSchema = z.object({ schemaVersion: z.literal(1), nodeUrl: endpoint, skillId: z.string().min(1), sourceId: z.string().min(1),
  name: z.string().min(1), revision: sha, guideResource: resourcePath, files: z.array(inventoryEntry).min(1).max(2000) }).strict();
type Receipt = z.infer<typeof receiptSchema>;

/** Same content revision as Skill Manager: paths sorted by UTF-8 bytes, then path\0length\0 + file bytes. */
export function skillContentRevision(files: { path: string; bytes: Uint8Array }[]): string {
  const result = createHash('sha256');
  for (const file of [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))) {
    result.update(`${file.path}\0${file.bytes.length}\0`).update(file.bytes);
  }
  return result.digest('hex');
}
const inside = (root: string, path: string): boolean => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
function identity(skill: { nodeUrl: string; skillId: string }): string { return hash(JSON.stringify([skill.nodeUrl, skill.skillId])); }
function snapshotId(lock: Pick<RoleSkillLock, 'profileSha256' | 'instructionsSha256' | 'skills'>): string {
  return hash(JSON.stringify({ profile: lock.profileSha256, instructions: lock.instructionsSha256,
    skills: lock.skills.map(skill => [skill.key, skill.nodeUrl, skill.skillId, skill.revision, skill.assets]) }));
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function checkParents(root: string, target: string, create = false): Promise<void> {
  if (!inside(root, target)) throw new Error('Cache path escapes root');
  const segments = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    if (create) await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Cache directory contains symlink or non-directory');
  }
}
async function regularBytes(root: string, path: string): Promise<Buffer> {
  await checkParents(root, dirname(path));
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Cache resource is not a regular file');
  return readFile(path);
}
async function verifyFile(root: string, path: string, expected: { bytes: number; sha256: string }): Promise<void> {
  const bytes = await regularBytes(root, path);
  if (bytes.length !== expected.bytes || hash(bytes) !== expected.sha256) throw new Error('Cached resource byte/hash mismatch');
}
async function listFiles(root: string, directory = root): Promise<string[]> {
  const paths: string[] = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name), info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Symlink found in cached skill');
    if (info.isDirectory()) paths.push(...await listFiles(root, path));
    else if (info.isFile()) paths.push(relative(root, path).split(sep).join('/'));
    else throw new Error('Unsupported cache filesystem entry');
  }
  return paths.sort();
}
async function verifyReceipt(root: string, directory: string, expected?: Receipt): Promise<Receipt> {
  const receipt = receiptSchema.parse(JSON.parse((await regularBytes(root, join(directory, 'receipt.json'))).toString('utf8')));
  if (expected && JSON.stringify(receipt) !== JSON.stringify(expected)) throw new Error('Cached skill receipt differs from locked identity');
  const files = join(directory, 'files');
  await checkParents(root, files);
  const inventory = await listFiles(files);
  if (new Set(receipt.files.map(file => file.path)).size !== receipt.files.length || JSON.stringify(inventory) !== JSON.stringify(receipt.files.map(file => file.path).sort())) throw new Error('Cached skill inventory mismatch');
  const content = [];
  for (const file of receipt.files) {
    const bytes = await regularBytes(root, join(files, file.path));
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('Cached skill byte/hash mismatch');
    content.push({ path: file.path, bytes });
  }
  if (skillContentRevision(content) !== receipt.revision) throw new Error('Cached skill content revision mismatch');
  return receipt;
}
async function bounded(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Skill network request failed (HTTP ${response.status})`); }
  if (Number(response.headers.get('content-length') ?? 0) > limit) { await response.body?.cancel(); throw new Error('Skill network response exceeds byte limit'); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      total += chunk.value.length;
      if (total > limit) throw new Error('Skill network response exceeds byte limit');
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
function networkUrl(base: string, suffix: string, params: Record<string, string> = {}): URL {
  const url = new URL(base); url.pathname = url.pathname.replace(/\/$/, '') + suffix;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}
async function networkJson(url: URL, timeout: number, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
  return JSON.parse((await bounded(response, 24 * 1024 * 1024)).toString('utf8'));
}
async function selectSkill(base: string, wanted: z.infer<typeof requirement>, timeout: number, signal?: AbortSignal) {
  let offset = 0; const matches: z.infer<typeof catalogueEntry>[] = [];
  for (let page = 0; page < 50; page++) {
    const result = z.object({ skills: z.array(catalogueEntry).max(200), has_more: z.boolean().optional(), next_offset: z.number().int().nonnegative().nullable().optional() }).passthrough()
      .parse(await networkJson(networkUrl(base, '/skills', { limit: '200', offset: String(offset) }), timeout, signal));
    for (const skill of result.skills) if (skill.name === wanted.name && (!wanted.skillId || wanted.skillId === skill.id) && (!wanted.sourceId || wanted.sourceId === skill.source_id)) matches.push(skill);
    if (!result.has_more) {
      if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous skill: ${wanted.name}; pin sourceId/skillId` : `Required skill unavailable: ${wanted.name}`);
      return matches[0]!;
    }
    if (result.next_offset == null || result.next_offset <= offset) throw new Error('Invalid skill catalogue pagination');
    offset = result.next_offset;
  }
  throw new Error('Skill catalogue exceeds bounded page limit');
}
function decoded(result: z.infer<typeof readResult>, expectedBytes: number): Buffer {
  if (result.encoding === 'utf8') {
    const bytes = Buffer.from(result.content, 'utf8');
    // Manager's TextDecoder strips one leading UTF-8 BOM. Restore it only when
    // the byte inventory requires exactly those three bytes; the package hash
    // below still has to match the provider's original revision.
    return bytes.length + 3 === expectedBytes ? Buffer.concat([Buffer.from([239, 187, 191]), bytes]) : bytes;
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.content)) throw new Error('Invalid base64 skill resource');
  return Buffer.from(result.content, 'base64');
}
async function installDirectory(temporary: string, target: string): Promise<void> {
  try { await rename(temporary, target); }
  catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    await rm(temporary, { recursive: true, force: true });
  }
}
async function loadSkill(root: string, base: string, wanted: z.infer<typeof requirement>, timeout: number, signal?: AbortSignal): Promise<{ directory: string; receipt: Receipt }> {
  const chosen = await selectSkill(base, wanted, timeout, signal);
  const parent = join(root, 'skills', identity({ nodeUrl: base, skillId: chosen.id }));
  await checkParents(root, parent, true);
  const directory = join(parent, chosen.revision);
  if (await exists(directory)) {
    const receipt = await verifyReceipt(root, directory);
    if (receipt.nodeUrl !== base || receipt.skillId !== chosen.id || receipt.sourceId !== chosen.source_id || receipt.name !== chosen.name || receipt.revision !== chosen.revision) throw new Error('Cached skill catalogue identity mismatch');
    return { directory, receipt };
  }
  const read = async (resource?: string) => {
    const result = readResult.parse(await networkJson(networkUrl(base, `/skills/${encodeURIComponent(chosen.id)}`, { revision: chosen.revision, ...(resource ? { resource } : {}) }), timeout, signal));
    if (result.id !== chosen.id || result.source_id !== chosen.source_id || result.name !== chosen.name || result.revision !== chosen.revision || (resource && result.resource !== resource)) throw new Error('Skill resource identity/revision mismatch');
    return result;
  };
  const main = await read();
  const resources = main.resources;
  if (!resources?.length || new Set(resources.map(file => file.path)).size !== resources.length || !resources.some(file => file.path === main.resource)) throw new Error('Invalid skill resource inventory');
  if (resources.reduce((total, file) => total + file.bytes, 0) > 32 * 1024 * 1024) throw new Error('Skill package exceeds size limit');
  const temporary = join(parent, `.download-${randomUUID()}`); await mkdir(temporary, { mode: 0o700 }); await mkdir(join(temporary, 'files'));
  try {
    const files: FileEntry[] = [], contents: { path: string; bytes: Buffer }[] = [];
    for (const file of resources) {
      const result = file.path === main.resource ? main : await read(file.path);
      const bytes = decoded(result, file.bytes);
      if (bytes.length !== file.bytes) throw new Error(`Skill resource size differs from inventory: ${chosen.name}/${file.path}; expected ${file.bytes}, received ${bytes.length}`);
      const path = join(temporary, 'files', file.path); await checkParents(root, dirname(path), true);
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      files.push({ path: file.path, bytes: bytes.length, sha256: hash(bytes) }); contents.push({ path: file.path, bytes });
    }
    if (skillContentRevision(contents) !== chosen.revision) throw new Error('Downloaded skill package revision mismatch');
    const receipt: Receipt = { schemaVersion: 1, nodeUrl: base, skillId: chosen.id, sourceId: chosen.source_id, name: chosen.name, revision: chosen.revision, guideResource: main.resource, files };
    await writeFile(join(temporary, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
    await installDirectory(temporary, directory);
    return { directory, receipt: await verifyReceipt(root, directory, receipt) };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
async function loadAssets(root: string, directory: string, wanted: z.infer<typeof requirement>, timeout: number, signal?: AbortSignal) {
  if (!wanted.assetsManifest) return [];
  const manifest = z.object({ assets: z.array(assetEntry).max(2000) }).strict().parse(JSON.parse((await regularBytes(root, join(directory, 'files', wanted.assetsManifest))).toString('utf8')));
  if (new Set(manifest.assets.map(asset => asset.path)).size !== manifest.assets.length) throw new Error('Duplicate skill asset path');
  if (manifest.assets.reduce((total, asset) => total + asset.bytes, 0) > 1024 * 1024 * 1024) throw new Error('Skill assets exceed size budget');
  for (const asset of manifest.assets) {
    if (await exists(join(directory, 'files', asset.path))) throw new Error('Asset path collides with skill resource');
    const parent = join(root, 'assets', asset.sha256); await checkParents(root, parent, true);
    const blob = join(parent, 'blob');
    if (!(await exists(blob))) {
      const response = await fetch(asset.url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
      const bytes = await bounded(response, Math.min(asset.bytes + 1, 128 * 1024 * 1024));
      if (bytes.length !== asset.bytes || hash(bytes) !== asset.sha256) throw new Error('Downloaded asset byte/hash mismatch');
      const temporary = join(parent, `.download-${randomUUID()}`); await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      try { await link(temporary, blob); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      finally { await rm(temporary, { force: true }); }
    }
    await verifyFile(root, blob, asset);
  }
  return manifest.assets;
}
async function validateLock(trustedRoot: string, lock: RoleSkillLock): Promise<RoleSkillLock> {
  // A migration may preserve the lock's original paths through a root alias.
  // Only that root alias may differ: every descendant keeps the same exact
  // binding and the existing directory/file symlink checks below still apply.
  const root = lock.cacheRoot;
  if (root !== trustedRoot && await realpath(root) !== trustedRoot) throw new Error('Role lock cache binding mismatch');
  const roleDirectory = join(root, 'roles', lock.roleId, snapshotId(lock));
  if (lock.roleDirectory !== roleDirectory || new Set(lock.skills.map(skill => skill.key)).size !== lock.skills.length) throw new Error('Role lock cache binding mismatch');
  const profileBytes = await regularBytes(root, join(roleDirectory, 'profile.json'));
  if (hash(profileBytes) !== lock.profileSha256) throw new Error('Cached role profile byte/hash mismatch');
  const profile = roleSkillProfileSchema.parse(JSON.parse(profileBytes.toString('utf8')));
  if (profile.id !== lock.roleId || profile.version !== lock.roleVersion || profile.entrySkill !== lock.entrySkill
      || Boolean(profile.instructionsPath) !== Boolean(lock.instructionsPath) || profile.skills.length !== lock.skills.length) throw new Error('Role lock profile binding mismatch');
  for (const skill of lock.skills) {
    const wanted = profile.skills.find(wanted => wanted.key === skill.key);
    if (!wanted || wanted.name !== skill.name || (wanted.skillId && wanted.skillId !== skill.skillId)
        || (wanted.sourceId && wanted.sourceId !== skill.sourceId) || (wanted.nodeUrl ?? profile.network.agentUrl) !== skill.nodeUrl) throw new Error('Role lock skill requirement mismatch');
    const directory = join(root, 'skills', identity(skill), skill.revision), materialized = join(roleDirectory, 'skills', skill.key);
    if (skill.cacheDirectory !== directory || skill.directory !== materialized || skill.guidePath !== join(materialized, skill.guideResource)) throw new Error('Role lock skill path mismatch');
    const receipt: Receipt = { schemaVersion: 1, nodeUrl: skill.nodeUrl, skillId: skill.skillId, sourceId: skill.sourceId, name: skill.name, revision: skill.revision, guideResource: skill.guideResource, files: skill.files };
    await verifyReceipt(root, directory, receipt);
    if (JSON.stringify((await listFiles(materialized)).sort()) !== JSON.stringify([...skill.files, ...skill.assets].map(file => file.path).sort())) throw new Error('Materialized skill inventory mismatch');
    for (const file of skill.files) await verifyFile(root, join(materialized, file.path), file);
    for (const asset of skill.assets) { await verifyFile(root, join(root, 'assets', asset.sha256, 'blob'), asset); await verifyFile(root, join(materialized, asset.path), asset); }
  }
  if (lock.instructionsPath) {
    if (lock.instructionsPath !== join(roleDirectory, 'ROLE.md') || !lock.instructionsSha256 || lock.instructionsBytes === undefined) throw new Error('Role instruction binding mismatch');
    await verifyFile(root, lock.instructionsPath, { bytes: lock.instructionsBytes, sha256: lock.instructionsSha256 });
  }
  if (lock.entrySkill && lock.entryGuidePath !== lock.skills.find(skill => skill.key === lock.entrySkill)?.guidePath) throw new Error('Role entry skill binding mismatch');
  const snapshotFiles = lock.skills.flatMap(skill => [...skill.files, ...skill.assets].map(file => `skills/${skill.key}/${file.path}`))
    .concat('profile.json', ...(lock.instructionsPath ? ['ROLE.md'] : [])).sort();
  if (JSON.stringify(await listFiles(roleDirectory)) !== JSON.stringify(snapshotFiles)) throw new Error('Role snapshot inventory mismatch');
  return lock;
}

/** New lock => latest catalogue revisions; existing lock => checked, fully offline reuse even if the source/profile changed. */
export async function resolveRoleSkills(options: { profilePath: string; cacheRoot: string; lockPath: string; signal?: AbortSignal }): Promise<RoleSkillLock> {
  const cache = resolve(options.cacheRoot); await mkdir(cache, { recursive: true, mode: 0o700 }); const root = await realpath(cache);
  const lockPath = resolve(options.lockPath), profilePath = resolve(options.profilePath);
  if (await exists(lockPath)) {
    const info = await lstat(lockPath); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Role lock is not a regular file');
    const lock = roleSkillLockSchema.parse(JSON.parse(await readFile(lockPath, 'utf8')));
    if (lock.profilePath !== profilePath && await realpath(lock.profilePath) !== await realpath(profilePath)) throw new Error('Role lock belongs to another profile');
    return validateLock(root, lock);
  }
  options.signal?.throwIfAborted();
  const bytes = await readFile(profilePath), profile = roleSkillProfileSchema.parse(JSON.parse(bytes.toString('utf8')));
  const instructions = profile.instructionsPath ? await readFile(resolve(dirname(profilePath), profile.instructionsPath)) : undefined;
  const lock: RoleSkillLock = { schemaVersion: 1, roleId: profile.id, roleVersion: profile.version, profilePath,
    profileSha256: hash(bytes), cacheRoot: root, roleDirectory: root, createdAt: new Date().toISOString(),
    ...(instructions ? { instructionsSha256: hash(instructions), instructionsBytes: instructions.length } : {}),
    ...(profile.entrySkill ? { entrySkill: profile.entrySkill } : {}), skills: [] };
  for (const wanted of profile.skills) {
    const base = wanted.nodeUrl ?? profile.network.agentUrl;
    const { directory, receipt } = await loadSkill(root, base, wanted, profile.network.timeoutMs, options.signal);
    const assets = await loadAssets(root, directory, wanted, profile.network.timeoutMs, options.signal);
    lock.skills.push({ key: wanted.key, nodeUrl: base, skillId: receipt.skillId, sourceId: receipt.sourceId, name: receipt.name,
      revision: receipt.revision, cacheDirectory: directory, directory: root, guidePath: root, guideResource: receipt.guideResource, files: receipt.files, assets });
  }
  lock.roleDirectory = join(root, 'roles', profile.id, snapshotId(lock));
  if (instructions) lock.instructionsPath = join(lock.roleDirectory, 'ROLE.md');
  for (const skill of lock.skills) { skill.directory = join(lock.roleDirectory, 'skills', skill.key); skill.guidePath = join(skill.directory, skill.guideResource); }
  if (profile.entrySkill) lock.entryGuidePath = lock.skills.find(skill => skill.key === profile.entrySkill)!.guidePath;
  const parent = dirname(lock.roleDirectory); await checkParents(root, parent, true);
  if (!(await exists(lock.roleDirectory))) {
    const temporary = join(parent, `.materialize-${randomUUID()}`); await mkdir(temporary, { mode: 0o700 });
    try {
      for (const skill of lock.skills) for (const file of [...skill.files, ...skill.assets]) {
        const path = join(temporary, 'skills', skill.key, file.path); await checkParents(root, dirname(path), true);
        const source = skill.files.includes(file) ? join(skill.cacheDirectory, 'files', file.path) : join(root, 'assets', file.sha256, 'blob');
        await copyFile(source, path);
      }
      await writeFile(join(temporary, 'profile.json'), bytes, { mode: 0o600 });
      if (instructions) await writeFile(join(temporary, 'ROLE.md'), instructions, { mode: 0o600 });
      await installDirectory(temporary, lock.roleDirectory);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  await validateLock(root, lock); options.signal?.throwIfAborted();
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(lockPath), `.role-lock-${randomUUID()}`);
  await writeFile(temporary, JSON.stringify(lock, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try { await link(temporary, lockPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  finally { await rm(temporary, { force: true }); }
  const storedInfo = await lstat(lockPath);
  if (!storedInfo.isFile() || storedInfo.isSymbolicLink()) throw new Error('Role lock is not a regular file');
  const stored = roleSkillLockSchema.parse(JSON.parse(await readFile(lockPath, 'utf8')));
  if (stored.profilePath !== profilePath) throw new Error('Concurrent role lock belongs to another profile');
  return validateLock(root, stored);
}
