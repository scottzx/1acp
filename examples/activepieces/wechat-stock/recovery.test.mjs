import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRecovery } from './recovery.mjs';

test('checkpoint preserves original file bytes and freezes a replayable continuation with only missing work', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-recovery-')); t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'output'); await mkdir(output);
  const sourcePath = join(root, 'original.md'), frozen = join(root, 'frozen.md'), source = '# Original\n';
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  await writeFile(sourcePath, source); await writeFile(frozen, source);
  await writeFile(join(output, 'cover.png'), 'existing cover bytes'); await writeFile(join(output, 'article.html'), 'existing article bytes');
  await writeFile(join(root, 'contract.json'), JSON.stringify({ outputDirectory: output, sourceSha256,
    requiredFiles: ['cover.png', 'article.html', 'README.md'] }));
  const operation = { key: 'a'.repeat(64), outputDirectory: output, frozenSourcePath: frozen, article: { sourcePath, sourceSha256 },
    request: { originSessionId: 'original-origin', input: { prompt: 'original contract', resultContract: { jobId: 'business-contract' }, preflight: { requiredFiles: [sourcePath, frozen] } } } };
  const view = { jobId: 'original-job', attemptId: 'interrupted-attempt', taskId: 'old-task', contextId: 'same-context', sessionId: 'same-session' };
  const a = await prepareRecovery(operation, view), b = await prepareRecovery(operation, view);
  assert.deepEqual(a, b, 'same request and checkpoint on preparation replay');
  const snapshot = JSON.parse(await readFile(a.checkpointPath, 'utf8'));
  assert.deepEqual(snapshot.missing, ['README.md', 'artifact-manifest.json']);
  assert.equal(await readFile(join(output, 'cover.png'), 'utf8'), 'existing cover bytes');
  assert.equal(await readFile(join(root, 'recovery', view.attemptId, 'files', 'cover.png'), 'utf8'), 'existing cover bytes');
  assert.equal(a.request.jobId, view.jobId); assert.equal(a.request.input.resultContract.jobId, 'business-contract');
  assert.match(a.request.input.prompt, /禁止整包重做/);
  await writeFile(sourcePath, '# changed');
  await assert.rejects(prepareRecovery(operation, view), /source changed/);
});
