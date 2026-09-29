import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyPublishedArchive } from './publish-packages.mjs';

test('release retries accept only matching immutable npm artifacts', () => {
  const archive = Buffer.from('release archive');
  const dist = { integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64') };
  assert.doesNotThrow(() => verifyPublishedArchive(archive, dist));
  assert.throws(() => verifyPublishedArchive(Buffer.from('changed release'), dist), /different contents/);
  assert.throws(() => verifyPublishedArchive(archive, {}), /different contents/);
});
