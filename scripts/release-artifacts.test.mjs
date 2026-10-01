import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateArtifacts, validateManifest, digest } from './release-artifacts.mjs';

test('packed packages reject wrong versions, external runtime and unresolved workspace ranges', () => {
  const source = { name: '@1agents/dsh-acp', version: '0.2.2', dependencies: { '@1agents/acp-service': 'workspace:^' } };
  const packed = { ...source, dependencies: { '@1agents/acp-service': '^0.4.0' } };
  assert.doesNotThrow(() => validateManifest('dsh-plugin', packed, source, '0.4.0'));
  for (const override of [{ version: '0.2.1' }, { private: true }, { dependencies: source.dependencies }, { dependencies: { '@scottzx/1acp': '^0.16.0' } }, { dependencies: { '@1agents/acp-service': '^0.3.0' } }]) {
    assert.throws(() => validateManifest('dsh-plugin', { ...packed, ...override }, source, '0.4.0'));
  }
});

test('release rejects corrupted or cross-commit CI artifacts before publishing', t => {
  const root = mkdtempSync(join(tmpdir(), 'release-artifacts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['packages/service', 'packages/dsh-plugin', 'package', 'release']) mkdirSync(join(root, name), { recursive: true });
  const source = { name: '@1agents/dsh-acp', version: '0.2.2', dependencies: { '@1agents/acp-service': 'workspace:^' } };
  writeFileSync(join(root, 'packages/service/package.json'), JSON.stringify({ version: '0.4.0' }));
  writeFileSync(join(root, 'packages/dsh-plugin/package.json'), JSON.stringify(source));
  writeFileSync(join(root, 'package/package.json'), JSON.stringify({ ...source, dependencies: { '@1agents/acp-service': '^0.4.0' } }));
  const filename = '1agents-dsh-acp-0.2.2.tgz';
  const archive = join(root, 'release', filename);
  execFileSync('tar', ['-czf', archive, '-C', root, 'package']);
  const sha = 'a'.repeat(40);
  const receipt = { filename, sha, sha256: digest(readFileSync(archive)) };
  const file = join(root, 'release/dsh-plugin-manifest.json');
  writeFileSync(file, JSON.stringify(receipt));
  assert.equal(validateArtifacts('dsh-plugin', sha, root).length, 1);
  assert.throws(() => validateArtifacts('dsh-plugin', 'b'.repeat(40), root), /another commit/);
  writeFileSync(file, JSON.stringify({ ...receipt, sha256: 'bad' }));
  assert.throws(() => validateArtifacts('dsh-plugin', sha, root), /checksum/);
});
