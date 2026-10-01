import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export const packages = ['service', 'dsh-plugin'];
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function packedManifest(archive, entry = 'package/package.json') {
  return JSON.parse(execFileSync('tar', ['-xOf', archive, entry], { encoding: 'utf8' }));
}

export function validateManifest(directory, packed, source, serviceVersion) {
  assert.equal(packed.name, source.name);
  assert.equal(packed.version, source.version);
  assert.ok(!packed.private, 'Cannot publish a private package');
  assert.ok(!packed.dependencies?.['@scottzx/1acp'], 'Runtime must be embedded');
  const dependencies = Object.fromEntries(Object.entries(source.dependencies).map(([name, range]) =>
    [name, range === 'workspace:^' && name === '@1agents/acp-service' ? `^${serviceVersion}` : range]));
  assert.deepEqual(packed.dependencies, dependencies, `${directory} packed dependencies differ from source`);
  assert.ok(Object.values(dependencies).every(range => !range.startsWith('workspace:')), 'Unresolved workspace dependency');
}

export function validateArtifacts(selection, sha, root = process.cwd()) {
  assert.ok(selection === 'all' || packages.includes(selection), 'Invalid release package');
  assert.match(sha, /^[a-f0-9]{40}$/);
  const service = JSON.parse(readFileSync(resolve(root, 'packages/service/package.json'), 'utf8'));
  return packages.filter(directory => selection === 'all' || selection === directory).map(directory => {
    const source = JSON.parse(readFileSync(resolve(root, `packages/${directory}/package.json`), 'utf8'));
    const receipt = JSON.parse(readFileSync(resolve(root, `release/${directory}-manifest.json`), 'utf8'));
    assert.equal(receipt.sha, sha, 'Artifact belongs to another commit');
    assert.equal(receipt.filename, `${source.name.replace('@', '').replace('/', '-')}-${source.version}.tgz`);
    assert.equal(basename(receipt.filename), receipt.filename);
    const archive = resolve(root, 'release', receipt.filename);
    assert.equal(digest(readFileSync(archive)), receipt.sha256, 'Artifact checksum mismatch');
    const packed = packedManifest(archive);
    validateManifest(directory, packed, source, service.version);
    if (directory === 'service') {
      const runtime = JSON.parse(readFileSync(resolve(root, 'packages/runtime/package.json'), 'utf8'));
      const embedded = packedManifest(archive, 'package/vendor/runtime/package.json');
      assert.equal(embedded.version, runtime.version);
      assert.equal(embedded.name, runtime.name);
      execFileSync('tar', ['-xOf', archive, 'package/vendor/runtime/dist/cli.js']);
      execFileSync('tar', ['-xOf', archive, 'package/vendor/runtime/dist/runtime.js']);
    }
    return { directory, archive, packed };
  });
}

function main() {
  const directory = process.argv[2];
  assert.ok(packages.includes(directory));
  const sha = process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  mkdirSync('release', { recursive: true });
  const source = JSON.parse(readFileSync(`packages/${directory}/package.json`, 'utf8'));
  execFileSync('pnpm', ['--filter', source.name, 'pack', '--pack-destination', resolve('release')], { stdio: 'inherit' });
  const filename = `${source.name.replace('@', '').replace('/', '-')}-${source.version}.tgz`;
  writeFileSync(`release/${directory}-manifest.json`, JSON.stringify({ sha, filename, sha256: digest(readFileSync(`release/${filename}`)) }, null, 2) + '\n');
  validateArtifacts(directory, sha);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
