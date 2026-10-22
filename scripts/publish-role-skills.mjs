#!/usr/bin/env node
/** Publish readable skill packages and content-addressed PPT assets; never installs or executes skill code. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile, link } from 'node:fs/promises';
import { dirname, basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_PACKAGE_FILES = 2000;
const MAX_PACKAGE_DEPTH = 12;
const ENTRY_FILES = ['SKILL.remote.md', 'skill.remote.md', 'SKILL.md', 'skill.md'];
const ASSET_TYPES = new Set(['.pptx', '.png', '.pdf']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent, child) => { const rel = relative(parent, child); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const publicationLease = new AsyncLocalStorage();

async function exists(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function physicalPath(path) {
  let existing = resolve(path), missing = [];
  while (!(await exists(existing))) { missing.unshift(basename(existing)); existing = dirname(existing); }
  const info = await lstat(existing);
  if (info.isSymbolicLink()) throw new Error(`Symlink directory is not allowed: ${existing}`);
  return join(await realpath(existing), ...missing);
}
function blocked(name) {
  return name.startsWith('.') || ['node_modules', '__pycache__', 'credentials', 'secrets'].includes(name.toLowerCase())
    || /^(?:credentials?|secrets?)\.(?:json|ya?ml|toml|ini|txt)$/i.test(name) || /\.(?:pem|key|p12|pfx)$/i.test(name);
}
async function bytesAt(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Skill resource is not a plain file: ${path}`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino) throw new Error('Source changed while opening');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs) throw new Error('Source changed while reading');
    return bytes;
  } finally { await handle.close(); }
}
async function scanSource(sourceDirectory) {
  const skills = [];
  for (const entry of (await readdir(sourceDirectory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
    if (entry.isSymbolicLink()) throw new Error(`Symlink skill is not allowed: ${entry.name}`);
    if (blocked(entry.name) || !entry.isDirectory()) continue;
    const files = [];
    const visit = async (directory, path = '', depth = 0) => {
      if (depth > MAX_PACKAGE_DEPTH) throw new Error(`Skill directory exceeds depth limit: ${entry.name}`);
      for (const child of (await readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
        if (child.isSymbolicLink()) throw new Error(`Symlink resource is not allowed: ${join(directory, child.name)}`);
        if (blocked(child.name)) continue;
        const resource = path ? `${path}/${child.name}` : child.name;
        if (child.isDirectory()) await visit(join(directory, child.name), resource, depth + 1);
        else {
          if (!child.isFile()) throw new Error(`Unsupported source entry: ${resource}`);
          const bytes = await bytesAt(join(directory, child.name));
          files.push({ path: resource, bytes, sha256: hash(bytes), asset: ASSET_TYPES.has(extname(child.name).toLowerCase()) });
        }
      }
    };
    await visit(join(sourceDirectory, entry.name));
    const guide = ENTRY_FILES.find(name => files.some(file => file.path === name));
    if (!guide) throw new Error(`Skill entry file missing: ${entry.name}`);
    if (files.some(file => file.path === 'assets-manifest.json')) throw new Error(`Reserved publisher resource already exists: ${entry.name}/assets-manifest.json`);
    skills.push({ name: entry.name, guide, files });
  }
  if (!skills.length) throw new Error('Source directory contains no skill packages');
  return skills;
}
function sourceDigest(skills) {
  return hash(JSON.stringify(skills.map(skill => ({ name: skill.name, guide: skill.guide,
    files: skill.files.map(file => [file.path, file.bytes.length, file.sha256]) }))));
}
function assetFilename(path) {
  const name = basename(path);
  if (name.length > 255 || name.startsWith('.') || /[/\\\x00-\x1f\x7f]/.test(name)) throw new Error('Asset filename is unsupported by the artifact server');
  return name;
}
async function safeDirectory(root, directory) {
  if (!inside(root, directory)) throw new Error('Public asset leaves its root');
  let cursor = root;
  for (const segment of relative(root, directory).split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    await mkdir(cursor).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Public asset directory is not a plain directory');
  }
}
async function verifyAsset(path, asset) {
  const bytes = await bytesAt(path);
  if (bytes.length !== asset.bytes.length || hash(bytes) !== asset.sha256) throw new Error(`Immutable public asset differs: ${path}`);
}

/** An update may hold this lease through refresh and warm-up; direct publishers use the same lock. */
export async function withRoleSkillPublicationLock(outputDirectory, operation) {
  const output = await physicalPath(outputDirectory), active = publicationLease.getStore();
  if (active?.output === output && !active.closed) return operation();
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const lockPath = join(dirname(output), `.${basename(output)}.publish.lock`);
  const lock = await open(lockPath, 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') throw new Error('Another role skill publisher holds the output lock'); throw error; });
  const lease = { output, closed: false };
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return await publicationLease.run(lease, operation);
  } finally { lease.closed = true; await lock.close(); await rm(lockPath, { force: true }); }
}

/** Updates only outputDirectory; previous published trees remain available as sibling backups. */
export async function publishRoleSkills({ sourceDirectory, outputDirectory, publicDirectory, publicBaseUrl }) {
  for (const [name, value] of Object.entries({ sourceDirectory, outputDirectory, publicDirectory })) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${name} is required`);
  }
  const base = new URL(publicBaseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('publicBaseUrl must be an HTTP(S) URL without credentials, query or fragment');
  const source = await physicalPath(sourceDirectory), output = await physicalPath(outputDirectory), publicRoot = await physicalPath(publicDirectory);
  for (const [a, b] of [[source, output], [source, publicRoot], [output, publicRoot]]) {
    if (inside(a, b) || inside(b, a)) throw new Error('Source, output and public directories must be separate, non-nested trees');
  }
  if (!(await lstat(source)).isDirectory()) throw new Error('Source directory is not a directory');
  const old = await exists(output);
  if (old && (!old.isDirectory() || old.isSymbolicLink())) throw new Error('Output directory must be a plain directory');
  return withRoleSkillPublicationLock(output, async () => {
    let temporary, previousDirectory;
    try {
    const skills = await scanSource(source), before = sourceDigest(skills);
    temporary = await mkdtemp(join(dirname(output), `.${basename(output)}.publish-`));
    const assets = [], published = [];
    for (const skill of skills) {
      const manifest = { assets: [] }, light = [];
      for (const file of skill.files) {
        if (file.asset) {
          const filename = assetFilename(file.path), job = `role-asset-${file.sha256}`;
          const asset = { path: file.path, sha256: file.sha256, bytes: file.bytes.length,
            url: `${base.href.replace(/\/$/, '')}/${job}/${encodeURIComponent(filename)}` };
          manifest.assets.push(asset); assets.push({ ...file, filename, job });
        } else light.push(file);
      }
      if (manifest.assets.length > MAX_PACKAGE_FILES) throw new Error(`Published skill exceeds ${MAX_PACKAGE_FILES} asset references: ${skill.name}`);
      const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
      light.push({ path: 'assets-manifest.json', bytes: manifestBytes, sha256: hash(manifestBytes) });
      if (light.length > MAX_PACKAGE_FILES) throw new Error(`Published skill exceeds ${MAX_PACKAGE_FILES} files: ${skill.name}`);
      if (light.some(file => file.bytes.length > MAX_FILE_BYTES)) throw new Error(`Published skill resource exceeds 8 MiB: ${skill.name}`);
      const bytes = light.reduce((total, file) => total + file.bytes.length, 0);
      if (bytes > MAX_PACKAGE_BYTES) throw new Error(`Published skill exceeds 32 MiB: ${skill.name}`);
      for (const file of light) {
        const path = join(temporary, skill.name, file.path);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, file.bytes, { flag: 'wx', mode: 0o600 });
      }
      published.push({ name: skill.name, guide: skill.guide, files: light.length, bytes, assets: manifest.assets });
    }
    // Validate existing immutable objects before publishing or altering the readable output tree.
    const publicInfo = await exists(publicRoot);
    if (publicInfo && (!publicInfo.isDirectory() || publicInfo.isSymbolicLink())) throw new Error('Public directory must be a plain directory');
    for (const asset of assets) {
      const folder = join(publicRoot, asset.job), info = await exists(folder);
      if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Immutable public asset directory is not plain');
      const path = join(folder, asset.filename);
      if (await exists(path)) await verifyAsset(path, asset);
    }
    if (sourceDigest(await scanSource(source)) !== before) throw new Error('Source skills changed during publication; retry with one complete version');
    await mkdir(publicRoot, { recursive: true, mode: 0o700 });
    for (const asset of assets) {
      const folder = join(publicRoot, asset.job), path = join(folder, asset.filename);
      await safeDirectory(publicRoot, folder);
      if (!(await exists(path))) {
        const part = join(folder, `.publish-${randomUUID()}`);
        try {
          await writeFile(part, asset.bytes, { flag: 'wx', mode: 0o600 });
          try { await link(part, path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        } finally { await rm(part, { force: true }); }
      }
      await verifyAsset(path, asset);
    }
    if (await exists(output)) {
      previousDirectory = join(dirname(output), `.${basename(output)}.previous-${randomUUID()}`);
      await rename(output, previousDirectory);
    }
    try { await rename(temporary, output); temporary = undefined; }
    catch (error) { if (previousDirectory) { await rename(previousDirectory, output); previousDirectory = undefined; } throw error; }
    return { schemaVersion: 1, sourceDirectory: source, outputDirectory: output, publicDirectory: publicRoot,
      sourceSha256: before, previousDirectory, skills: published,
      activation: 'staged directory replacement with rollback; previous tree retained',
      note: 'Register or refresh the output source with Skill Manager separately; source files and existing role caches were not modified.' };
    } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  });
}

export const PUBLISH_ROLE_SKILLS_USAGE = `Publish role skills without installing, executing scripts, or restarting services.

node scripts/publish-role-skills.mjs --source DIRECTORY --output DIRECTORY --public-directory DIRECTORY --public-base-url URL

All PPTX/PNG/PDF resources are copied to immutable public asset URLs; readable packages retain guides, scripts and assets-manifest.json.
Source, output and public directories must not contain each other. Previous output trees are retained as sibling backups.
Skill Manager source registration and refresh are separate management operations (dreammate-node skills add/refresh).
`;

async function main() {
  const { values } = parseArgs({ options: { source: { type: 'string' }, output: { type: 'string' }, 'public-directory': { type: 'string' }, 'public-base-url': { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true });
  if (values.help) { console.log(PUBLISH_ROLE_SKILLS_USAGE); return; }
  console.log(JSON.stringify(await publishRoleSkills({ sourceDirectory: values.source, outputDirectory: values.output,
    publicDirectory: values['public-directory'], publicBaseUrl: values['public-base-url'] }), null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
}
