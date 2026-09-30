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

test('registry verification rejects wrong or missing dependency ranges', async () => {
  const viewWith = (dependencies) => () => JSON.stringify(dependencies);
  await assert.doesNotReject(() =>
    verifyRegistryState('@1agents/acp-service', '0.3.0', '@scottzx/1acp', '^0.16.0', viewWith({ '@scottzx/1acp': '^0.16.0' }), { delayMs: 1 }));
  await assert.rejects(() =>
    verifyRegistryState('@1agents/acp-service', '0.3.0', '@scottzx/1acp', '^0.16.0', viewWith({ '@scottzx/1acp': '^0.15.1' }), { delayMs: 1 }), /expected \^0\.16\.0/);
  await assert.rejects(() =>
    verifyRegistryState('@1agents/acp-service', '0.3.0', '@scottzx/1acp', '^0.16.0', viewWith({}), { delayMs: 1 }), /missing/);
});

test('registry verification waits for read propagation after publish', async () => {
  const e404 = new Error('npm error 404 No match found for version 0.3.0');
  let calls = 0;
  const flakyThenOk = () => {
    calls += 1;
    if (calls < 3) throw e404;
    return JSON.stringify({ '@scottzx/1acp': '^0.16.0' });
  };
  await assert.doesNotReject(() =>
    verifyRegistryState('@1agents/acp-service', '0.3.0', '@scottzx/1acp', '^0.16.0', flakyThenOk, { attempts: 5, delayMs: 1 }));
  assert.equal(calls, 3);
  // A wrong range after propagation must not be retried away.
  await assert.rejects(() =>
    verifyRegistryState('@1agents/acp-service', '0.3.0', '@scottzx/1acp', '^0.16.0',
      () => JSON.stringify({ '@scottzx/1acp': '^0.15.1' }), { attempts: 5, delayMs: 1 }), /expected/);
});
