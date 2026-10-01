import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { archiveContentDigest, verifyPublishedArchive, verifyRegistryState, verifyExisting } from './publish-packages.mjs';

test('release retries accept only matching immutable npm artifacts', () => {
  const archive = Buffer.from('release archive');
  const dist = { integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64') };
  assert.doesNotThrow(() => verifyPublishedArchive(archive, dist));
  assert.throws(() => verifyPublishedArchive(Buffer.from('changed release'), dist), /different archive integrity/);
  assert.throws(() => verifyPublishedArchive(archive, {}), /different archive integrity/);
});

test('retry comparisons allow compression changes but reject changed files', t => {
  const directory = mkdtempSync(join(tmpdir(), 'archive-contents-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'package'));
  writeFileSync(join(directory, 'package/index.js'), 'original');
  const original = join(directory, 'original.tgz');
  execFileSync('tar', ['-czf', original, '-C', directory, 'package']);
  const recompressed = join(directory, 'recompressed.tgz');
  writeFileSync(recompressed, gzipSync(gunzipSync(readFileSync(original)), { level: 1 }));
  assert.equal(archiveContentDigest(original), archiveContentDigest(recompressed));
  writeFileSync(join(directory, 'package/index.js'), 'changed');
  const changed = join(directory, 'changed.tgz');
  execFileSync('tar', ['-czf', changed, '-C', directory, 'package']);
  assert.notEqual(archiveContentDigest(original), archiveContentDigest(changed));
});

test('retry comparisons reject changed executable and directory permissions', t => {
  const directory = mkdtempSync(join(tmpdir(), 'archive-modes-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'package'), { mode: 0o755 });
  const entry = join(directory, 'package/cli.js');
  writeFileSync(entry, '#!/usr/bin/env node\n', { mode: 0o644 });
  const pack = name => {
    const archive = join(directory, name + '.tgz');
    execFileSync('tar', ['-czf', archive, '-C', directory, 'package']);
    return archiveContentDigest(archive);
  };
  const original = pack('original');
  chmodSync(entry, 0o755);
  assert.notEqual(pack('executable'), original);
  chmodSync(entry, 0o644);
  chmodSync(join(directory, 'package'), 0o700);
  assert.notEqual(pack('directory'), original);
});

test('registry verification rejects wrong or missing dependency ranges', async () => {
  const fetchRange = (range) => async () => range;
  const fetchMissing = async () => undefined;
  await assert.doesNotReject(() =>
    verifyRegistryState('@1agents/acp-service', '0.3.0', '@scottzx/1acp', '^0.16.0', fetchRange('^0.16.0'), { delayMs: 1 }));
  await assert.rejects(() =>
    verifyRegistryState('@1agents/acp-service', '0.3.0', '@scottzx/1acp', '^0.16.0', fetchRange('^0.15.1'), { delayMs: 1 }), /expected \^0\.16\.0/);
  await assert.rejects(() =>
    verifyRegistryState('@1agents/acp-service', '0.3.0', '@scottzx/1acp', '^0.16.0', fetchMissing, { delayMs: 1 }), /missing/);
});

test('registry verification waits for read propagation after publish', async () => {
  const e404 = new Error('E404 from registry for ...');
  let calls = 0;
  const flakyThenOk = async () => {
    calls += 1;
    if (calls < 3) throw e404;
    return '^0.16.0';
  };
  await assert.doesNotReject(() =>
    verifyRegistryState('@1agents/acp-service', '0.3.0', '@scottzx/1acp', '^0.16.0', flakyThenOk, { attempts: 5, delayMs: 1 }));
  assert.equal(calls, 3);
  // A wrong range after propagation must not be retried away.
  await assert.rejects(() =>
    verifyRegistryState('@1agents/acp-service', '0.3.0', '@scottzx/1acp', '^0.16.0',
      async () => '^0.15.1', { attempts: 5, delayMs: 1 }), /expected/);
});


test('unified release retry rejects a different registry tarball with the same version', async t => {
  const root = mkdtempSync(join(tmpdir(), 'published-service-artifact-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archive = join(root, 'service.tgz');
  mkdirSync(join(root, 'package'));
  writeFileSync(join(root, 'package/index.js'), 'CI service');
  execFileSync('tar', ['-czf', archive, '-C', root, 'package']);
  const bytes = readFileSync(archive);
  const integrity = content => 'sha512-' + createHash('sha512').update(content).digest('base64');
  const dist = { integrity: integrity(bytes), tarball: 'https://registry.npmjs.org/service.tgz' };
  await assert.doesNotReject(() => verifyExisting(archive, dist));
  writeFileSync(join(root, 'package/index.js'), 'different service with the same version');
  const registryArchive = join(root, 'registry.tgz');
  execFileSync('tar', ['-czf', registryArchive, '-C', root, 'package']);
  const registryBytes = readFileSync(registryArchive);
  dist.integrity = integrity(registryBytes);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, arrayBuffer: async () => registryBytes }));
  await assert.rejects(() => verifyExisting(archive, dist), /different contents/);
});
