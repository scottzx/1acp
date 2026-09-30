import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyPublishedArchive, verifyRegistryState } from './publish-packages.mjs';

test('release retries accept only matching immutable npm artifacts', () => {
  const archive = Buffer.from('release archive');
  const dist = { integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64') };
  assert.doesNotThrow(() => verifyPublishedArchive(archive, dist));
  assert.throws(() => verifyPublishedArchive(Buffer.from('changed release'), dist), /different contents/);
  assert.throws(() => verifyPublishedArchive(archive, {}), /different contents/);
});

test('registry verification rejects wrong or missing dependency ranges', () => {
  const viewWith = (dependencies) => () => JSON.stringify(dependencies);
  assert.doesNotThrow(() =>
    verifyRegistryState('@1agents/acp-service', '0.3.0', '@scottzx/1acp', '^0.16.0', viewWith({ '@scottzx/1acp': '^0.16.0' })));
  assert.throws(() =>
    verifyRegistryState('@1agents/acp-service', '0.3.0', '@scottzx/1acp', '^0.16.0', viewWith({ '@scottzx/1acp': '^0.15.1' })), /expected \^0\.16\.0/);
  assert.throws(() =>
    verifyRegistryState('@1agents/acp-service', '0.3.0', '@scottzx/1acp', '^0.16.0', viewWith({})), /missing/);
});
