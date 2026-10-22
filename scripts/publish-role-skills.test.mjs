import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import test from 'node:test';
import { publishRoleSkills } from './publish-role-skills.mjs';

const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = async (path, bytes) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); };
const guide = label => `---\nname: ${label}\ndescription: Make editable presentations.\n---\n${label}\n`;
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), '1acp-role-publish-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDirectory = join(root, 'source'), outputDirectory = join(root, 'published'), publicDirectory = join(root, 'public');
  await mkdir(sourceDirectory); await mkdir(publicDirectory);
  const options = { sourceDirectory, outputDirectory, publicDirectory, publicBaseUrl: 'http://127.0.0.1:36818/artifacts' };
  await save(join(sourceDirectory, 'design/SKILL.remote.md'), guide('design'));
  await save(join(sourceDirectory, 'design/references/rules.md'), 'Original rules\n');
  await save(join(sourceDirectory, 'design/scripts/helper.mjs'), Buffer.from([0xef, 0xbb, 0xbf, 0x2f, 0x2f, 0x20, 0x31, 0x0a]));
  // A real temporary HTTP server, with the artifact service's public path and media constraints.
  const server = createServer(async (req, res) => {
    const match = /^\/artifacts\/(role-asset-[a-f0-9]{64})\/([^/]+)$/.exec(req.url ?? '');
    try {
      if (!match) throw new Error('Unsupported route');
      const name = decodeURIComponent(match[2]);
      if (name.startsWith('.') || /[/\\]/.test(name) || !/\.(pptx|png|pdf)$/i.test(name)) throw new Error('Unsupported file');
      const bytes = await readFile(join(publicDirectory, match[1], name));
      res.writeHead(200, { 'content-length': bytes.length }); res.end(bytes);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); options.publicBaseUrl = `http://127.0.0.1:${address.port}/artifacts`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { root, options, source: sourceDirectory, output: outputDirectory, public: publicDirectory };
}

test('publishes complete text/script bytes and content-addressed native assets with real HTTP downloads', async t => {
  const f = await fixture(t);
  const inputs = [
    ['design/assets/主模板 v1.pptx', Buffer.from('native PPTX fixture bytes')],
    ['design/assets/previews/overview.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255])],
    ['design/assets/notes.pdf', Buffer.from('%PDF-1.7 fixture')],
  ];
  for (const [path, bytes] of inputs) await save(join(f.source, path), bytes);
  await save(join(f.source, 'validation/SKILL.md'), guide('validation'));
  await save(join(f.source, 'validation/tiny.bin'), Buffer.from([0, 1, 255]));
  const receipt = await publishRoleSkills(f.options);
  assert.equal(receipt.skills.length, 2);
  assert.equal(receipt.skills[0].guide, 'SKILL.remote.md');
  assert.deepEqual(await readFile(join(f.output, 'design/SKILL.remote.md')), await readFile(join(f.source, 'design/SKILL.remote.md')));
  assert.deepEqual(await readFile(join(f.output, 'design/scripts/helper.mjs')), await readFile(join(f.source, 'design/scripts/helper.mjs')));
  assert.deepEqual(await readFile(join(f.output, 'validation/tiny.bin')), Buffer.from([0, 1, 255]));
  await assert.rejects(readFile(join(f.output, 'design/SKILL.md')), /ENOENT/);
  const manifest = JSON.parse(await readFile(join(f.output, 'design/assets-manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest), ['assets']);
  assert.equal(manifest.assets.length, 3);
  for (const [path, bytes] of inputs) {
    const asset = manifest.assets.find(item => item.path === path.slice('design/'.length));
    assert.deepEqual(Object.keys(asset), ['path', 'sha256', 'bytes', 'url']);
    assert.equal(asset.sha256, hash(bytes)); assert.equal(asset.bytes, bytes.length);
    assert.ok(asset.url.includes(`/role-asset-${hash(bytes)}/`));
    const response = await fetch(asset.url); assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.deepEqual(await readFile(join(f.source, path)), bytes);
    await assert.rejects(readFile(join(f.output, path)), /ENOENT/);
  }
});

test('subsequent publication retains the previous tree, old immutable URLs and unrelated role cache', async t => {
  const f = await fixture(t), assetPath = join(f.source, 'design/template.pptx');
  await save(assetPath, 'version one');
  await publishRoleSkills(f.options);
  const oldManifest = await readFile(join(f.output, 'design/assets-manifest.json'));
  const oldAsset = JSON.parse(oldManifest).assets[0];
  const oldGuide = await readFile(join(f.output, 'design/SKILL.remote.md'));
  const cache = join(f.root, 'cache/roles/pinned/guide.md'); await save(cache, oldGuide);
  await save(assetPath, 'version two'); await save(join(f.source, 'design/SKILL.remote.md'), guide('design-v2'));
  const next = await publishRoleSkills(f.options);
  assert.ok(next.previousDirectory);
  assert.deepEqual(await readFile(join(next.previousDirectory, 'design/SKILL.remote.md')), oldGuide);
  assert.deepEqual(await readFile(join(next.previousDirectory, 'design/assets-manifest.json')), oldManifest);
  assert.deepEqual(await readFile(cache), oldGuide);
  assert.equal(await (await fetch(oldAsset.url)).text(), 'version one');
  const latest = JSON.parse(await readFile(join(f.output, 'design/assets-manifest.json'), 'utf8')).assets[0];
  assert.notEqual(latest.url, oldAsset.url); assert.equal(await (await fetch(latest.url)).text(), 'version two');
});

test('rejects resource symlinks without changing the existing published version or following the target', async t => {
  const f = await fixture(t); await publishRoleSkills(f.options);
  const before = await readFile(join(f.output, 'design/SKILL.remote.md'));
  const outside = join(f.root, 'outside.txt'); await save(outside, 'private outside bytes');
  await symlink(outside, join(f.source, 'design/references/link.md'));
  await assert.rejects(publishRoleSkills(f.options), /Symlink/);
  assert.deepEqual(await readFile(join(f.output, 'design/SKILL.remote.md')), before);
  assert.equal(await readFile(outside, 'utf8'), 'private outside bytes');
  await assert.rejects(readFile(join(f.output, 'design/references/link.md')), /ENOENT/);
});

test('rejects nested input/output/public trees, root symlinks and invalid asset URLs before publication', async t => {
  const f = await fixture(t); await publishRoleSkills(f.options);
  const before = await readFile(join(f.output, 'design/SKILL.remote.md'));
  for (const patch of [
    { outputDirectory: join(f.source, 'inside') },
    { publicDirectory: join(f.source, 'inside') },
    { outputDirectory: dirname(f.source) },
    { publicDirectory: join(f.output, 'inside') },
  ]) await assert.rejects(publishRoleSkills({ ...f.options, ...patch }), /non-nested/);
  const linked = join(f.root, 'linked-source'); await symlink(f.source, linked);
  await assert.rejects(publishRoleSkills({ ...f.options, sourceDirectory: linked }), /Symlink/);
  for (const publicBaseUrl of ['file:///tmp/assets', 'http://user:password@example.test/artifacts', 'http://example.test/artifacts?token=secret']) {
    await assert.rejects(publishRoleSkills({ ...f.options, publicBaseUrl }), /HTTP/);
  }
  assert.deepEqual(await readFile(join(f.output, 'design/SKILL.remote.md')), before);
});

test('Manager file, total-byte and file-count limits fail without overwriting a published tree', async t => {
  const f = await fixture(t); await publishRoleSkills(f.options);
  const before = await readFile(join(f.output, 'design/SKILL.remote.md'));
  const big = join(f.source, 'design/oversized.bin'); await save(big, Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(publishRoleSkills(f.options), /8 MiB/); await rm(big);
  for (let i = 0; i < 4; i++) await save(join(f.source, `design/total-${i}.bin`), Buffer.alloc(8 * 1024 * 1024));
  await assert.rejects(publishRoleSkills(f.options), /32 MiB/);
  for (let i = 0; i < 4; i++) await rm(join(f.source, `design/total-${i}.bin`));
  await mkdir(join(f.source, 'design/many'));
  for (let i = 0; i < 2000; i++) await writeFile(join(f.source, `design/many/${i}.txt`), 'x');
  await assert.rejects(publishRoleSkills(f.options), /2000 files/);
  assert.deepEqual(await readFile(join(f.output, 'design/SKILL.remote.md')), before);
  assert.deepEqual(await readdir(f.public), []);
});

test('a mismatching immutable asset is preserved and prevents replacing the existing publication', async t => {
  const f = await fixture(t); await publishRoleSkills(f.options);
  const before = await readFile(join(f.output, 'design/SKILL.remote.md'));
  const bytes = Buffer.from('expected asset'), path = join(f.public, `role-asset-${hash(bytes)}`, 'template.pptx');
  await save(join(f.source, 'design/template.pptx'), bytes); await save(path, 'unexpected bytes');
  await assert.rejects(publishRoleSkills(f.options), /Immutable public asset differs/);
  assert.equal(await readFile(path, 'utf8'), 'unexpected bytes');
  assert.deepEqual(await readFile(join(f.output, 'design/SKILL.remote.md')), before);
});

test('a source change during publication aborts rather than publishing a mixed revision', async t => {
  const f = await fixture(t); await publishRoleSkills(f.options);
  const before = await readFile(join(f.output, 'design/SKILL.remote.md'));
  await save(join(f.source, 'design/references/rules.md'), 'next version');
  for (let i = 0; i < 100; i++) await save(join(f.source, `design/scripts/check-${i}.mjs`), '// fixture');
  let changes = 0;
  const writer = setInterval(() => writeFileSync(join(f.source, 'design/SKILL.remote.md'), guide(`changed-${++changes}`)), 1);
  try { await assert.rejects(publishRoleSkills(f.options), /changed/); }
  finally { clearInterval(writer); }
  assert.ok(changes > 0);
  assert.deepEqual(await readFile(join(f.output, 'design/SKILL.remote.md')), before);
});

test('an existing publisher lock is not removed and reserved manifests cannot be silently replaced', async t => {
  const f = await fixture(t), lock = join(f.root, '.published.publish.lock');
  await save(lock, 'other publisher'); await assert.rejects(publishRoleSkills(f.options), /holds the output lock/);
  assert.equal(await readFile(lock, 'utf8'), 'other publisher'); await rm(lock);
  await save(join(f.source, 'design/assets-manifest.json'), '{"assets":[]}');
  await assert.rejects(publishRoleSkills(f.options), /Reserved publisher resource/);
  await assert.rejects(readFile(join(f.output, 'design/SKILL.remote.md')), /ENOENT/);
});

test('CLI documents separate registration, publishes successfully and never executes copied scripts', async t => {
  const script = fileURLToPath(new URL('./publish-role-skills.mjs', import.meta.url));
  const { stdout } = await execute(process.execPath, [script, '--help']);
  assert.match(stdout, /Skill Manager source registration and refresh are separate/);
  assert.match(stdout, /without installing, executing scripts, or restarting/);
  const f = await fixture(t), marker = join(f.root, 'script-was-executed');
  await save(join(f.source, 'design/scripts/helper.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  const result = await execute(process.execPath, [script, '--source', f.source, '--output', f.output,
    '--public-directory', f.public, '--public-base-url', f.options.publicBaseUrl]);
  assert.equal(JSON.parse(result.stdout).skills[0].name, 'design');
  assert.equal(await readFile(join(f.output, 'design/SKILL.remote.md'), 'utf8'), guide('design'));
  await assert.rejects(readFile(marker), /ENOENT/);
});
