import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyDelivery } from './adapter.mjs';
import { productionFlow } from './production-flow.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
async function delivery(t) {
  const root = await mkdtemp(join(tmpdir(), 'stock-delivery-')); t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'output'); await mkdir(output);
  const source = '# Approved source\n', sourcePath = join(root, 'original.md'); await writeFile(sourcePath, source);
  const article = '<html>final package</html>';
  const files = { 'source.md': source, 'metadata.json': JSON.stringify({ title: 'Title', summary: 'Summary' }),
    'series.json': '{}', 'article.html': article, 'article.wechat.html': article,
    'cover.png': 'image fixture', 'cover.svg': '<svg/>', 'cover.html': 'cover', 'footer.html': 'footer', 'series-nav.html': 'nav',
    'qa-mobile.png': 'mobile fixture', 'qa-footer.png': 'footer fixture', 'README.md': 'receipt',
    'verification.json': JSON.stringify({ source_sha256: sha(source), snapshot_sha256: sha(source), source_file_unchanged: true,
      snapshot_byte_identical: true, visible_text_equal: true, cover_exact_16_9: true, cover_size: [1920, 1080], mobile_no_horizontal_overflow: true, remaining_placeholders: {} }),
    'visual-qa.json': JSON.stringify({ status: 'passed', inspection_tool: 'fixture-reviewer', article_sha256: sha(article), evidence: ['cover.png', 'qa-mobile.png', 'qa-footer.png'] }) };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(output, name), bytes);
  return { root, output, operation: { key: 'a'.repeat(64), outputDirectory: output, article: { sourcePath, sourceSha256: sha(source) } },
    view: { jobId: 'host-job', attemptId: 'host-attempt', resultRevision: 'result-1', resultDigest: 'c'.repeat(64), taskId: 'host-task',
      resultMetadata: { producer: '1agents/a2a-host', outcome: 'completed', roleId: 'wechat-series-editor',
      taskId: 'host-task', roleSkills: { lockPath: 'frozen-task-lock' }, validation: { status: 'passed' },
      artifacts: Object.entries(files).map(([name, bytes]) => ({ path: join(output, name), size: Buffer.byteLength(bytes), sha256: sha(bytes), mediaType: 'text/plain' })) } } };
}

test('delivery freezes the verified bytes and rejects changed host artifacts', async t => {
  const f = await delivery(t), verified = await verifyDelivery(f.operation, f.view, join(f.root, 'assets'));
  assert.equal(await readFile(join(verified.artifactDirectory, 'article.html'), 'utf8'), '<html>final package</html>');
  await writeFile(join(f.output, 'article.html'), '<html>modified after acceptance</html>');
  await assert.rejects(verifyDelivery(f.operation, f.view, join(f.root, 'assets')), /bytes differ/);
});

test('delivery rejects mismatched host identity and incomplete package manifests', async t => {
  const f = await delivery(t);
  const wrongHost = structuredClone(f.view); wrongHost.resultMetadata.taskId = 'other-task';
  await assert.rejects(verifyDelivery(f.operation, wrongHost, join(f.root, 'assets')), /host identity/);
  await assert.rejects(verifyDelivery({ ...f.operation, job: { jobId: 'host-job', attemptId: 'old-attempt' } }, f.view, join(f.root, 'assets')), /host identity/);
  const missingEvidence = structuredClone(f.view); missingEvidence.resultMetadata.artifacts = missingEvidence.resultMetadata.artifacts.filter(item => !item.path.endsWith('qa-mobile.png'));
  await assert.rejects(verifyDelivery(f.operation, missingEvidence, join(f.root, 'assets')), /absent/);
});

test('AP code preserves the observation identity and normalizes an early duplicate without dispatch', async () => {
  const flow = productionFlow('test-encrypted-connection');
  const code = (await import(`data:text/javascript;base64,${Buffer.from(flow.steps[1].sourceCode).toString('base64')}`)).code;
  const result = await code({ observation: { due: false } });
  assert.equal(result.observationId, ''); assert.equal(result.advice.shouldDispatch, false);
  assert.equal(flow.trigger.input.cronExpression, '*/30 * * * *');
  assert.equal(flow.steps[2].input.observationId, "{{step_2['output'].observationId}}");
});
