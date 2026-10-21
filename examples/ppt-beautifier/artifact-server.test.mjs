import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createArtifactServer, loadConfig } from './artifact-server.mjs';

function request(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method }, res => {
      const chunks = [];
      res.on('data', data => chunks.push(data));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ppt-artifacts-'));
  const root = path.join(directory, 'artifacts');
  await mkdir(path.join(root, 'job-1'), { recursive: true });
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 255, 97]);
  await writeFile(path.join(root, 'job-1', 'report.pptx'), bytes);
  await writeFile(path.join(root, 'job-1', '预览.png'), 'PNG preview');
  await writeFile(path.join(root, 'job-1', 'report.pdf'), 'PDF report');
  await writeFile(path.join(root, 'job-1', 'private.json'), '{"secret":true}');
  await writeFile(path.join(directory, 'outside.pptx'), 'outside');
  const server = await createArtifactServer({ host: '127.0.0.1', port: 0, root });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { root, directory, bytes, port: server.address().port };
}

test('downloads exact bytes with PPTX MIME and attachment headers; HEAD omits body', async t => {
  const f = await fixture(t);
  const response = await request(f.port, '/artifacts/job-1/report.pptx');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, f.bytes);
  assert.equal(response.headers['content-type'], 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  assert.equal(response.headers['content-length'], String(f.bytes.length));
  assert.match(response.headers['content-disposition'], /^attachment;/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  const head = await request(f.port, '/artifacts/job-1/report.pptx', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], String(f.bytes.length));
});

test('serves PNG, PDF, Unicode filenames, and health without exposing root', async t => {
  const f = await fixture(t);
  const png = await request(f.port, `/artifacts/job-1/${encodeURIComponent('预览.png')}`);
  assert.equal(png.status, 200);
  assert.equal(png.headers['content-type'], 'image/png');
  assert.match(png.headers['content-disposition'], /^inline;/);
  assert.equal(png.body.toString(), 'PNG preview');
  const pdf = await request(f.port, '/artifacts/job-1/report.pdf');
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.match(pdf.headers['content-disposition'], /^attachment;/);
  const health = await request(f.port, '/health');
  assert.deepEqual(JSON.parse(health.body), { status: 'ok', service: 'ppt-beautifier-artifacts' });
  const head = await request(f.port, '/health', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
});

test('serves exact bytes through immutable revision URLs, retaining flat URL support', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'job-1', 'revision-2'));
  await writeFile(path.join(f.root, 'job-1', 'revision-2', 'report.pptx'), f.bytes);
  const url = '/artifacts/job-1/revision-2/report.pptx';
  assert.deepEqual((await request(f.port, url)).body, f.bytes);
  const head = await request(f.port, url, 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], String(f.bytes.length));
  assert.deepEqual((await request(f.port, '/artifacts/job-1/report.pptx')).body, f.bytes);
});

test('rejects traversal, arbitrary nesting, hidden files, unsupported types, listings, and writes', async t => {
  const f = await fixture(t);
  for (const pathname of [
    '/', '/artifacts', '/artifacts/', '/artifacts/job-1', '/artifacts/job-1/',
    '/artifacts/../outside.pptx', '/artifacts/%2e%2e/outside.pptx',
    '/artifacts/job-1/%2e%2e%2foutside.pptx', '/artifacts/job-1/%2foutside.pptx',
    '/artifacts/job-1/%5c..%5coutside.pptx', '/artifacts/job-1/report.pptx/extra',
    '/artifacts/job-1/private.json', '/artifacts/job-1/.hidden.pptx',
    '/artifacts/job-1/report%00.pptx', '/artifacts/job-1/%invalid.png',
    '/artifacts/job-1/revision-0/report.pptx', '/artifacts/job-1/other/report.pptx',
    '/artifacts/job-1/%2e%2e/report.pptx', '/artifacts/job-1/revision-1%2f..%2f/report.pptx',
    '/artifacts/job-1/revision-1/nested/report.pptx',
  ]) {
    assert.equal((await request(f.port, pathname)).status, 404, pathname);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const result = await request(f.port, '/artifacts/job-1/report.pptx', method);
    assert.equal(result.status, 405, method);
    assert.equal(result.headers.allow, 'GET, HEAD');
  }
});

test('refuses artifact and job-directory symlinks outside and inside the root', async t => {
  const f = await fixture(t);
  await symlink(path.join(f.directory, 'outside.pptx'), path.join(f.root, 'job-1', 'outside-link.pptx'));
  await symlink(path.join(f.root, 'job-1', 'report.pptx'), path.join(f.root, 'job-1', 'inside-link.pptx'));
  await symlink(f.directory, path.join(f.root, 'outside-job'));
  await symlink(path.join(f.root, 'job-1'), path.join(f.root, 'inside-job'));
  await symlink(path.join(f.root, 'job-1'), path.join(f.root, 'job-1', 'revision-2'));
  await symlink(f.directory, path.join(f.root, 'job-1', 'revision-3'));
  for (const pathname of [
    '/artifacts/job-1/outside-link.pptx', '/artifacts/job-1/inside-link.pptx',
    '/artifacts/outside-job/outside.pptx', '/artifacts/inside-job/report.pptx',
    '/artifacts/job-1/revision-2/report.pptx', '/artifacts/job-1/revision-3/outside.pptx',
  ]) assert.equal((await request(f.port, pathname)).status, 404, pathname);
});

test('loads private config and refuses broad permissions, symlinks, and invalid settings', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ppt-artifact-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'config.json');
  const config = { host: '100.88.227.56', port: 36818, root: '/Users/scott/.local/share/1agents/ppt-beautifier/workspace/artifacts' };
  await writeFile(filename, JSON.stringify(config), { mode: 0o600 });
  assert.deepEqual(await loadConfig(filename), config);
  await symlink(filename, path.join(directory, 'link.json'));
  await assert.rejects(loadConfig(path.join(directory, 'link.json')), /regular file/);
  if (process.platform !== 'win32') {
    await chmod(filename, 0o644);
    await assert.rejects(loadConfig(filename), /mode 0600 or 0400/);
    await chmod(filename, 0o600);
  }
  for (const invalid of [
    { ...config, root: '../private' }, { ...config, host: 'example.com' },
    { ...config, port: 65536 }, { ...config, extra: true },
  ]) {
    await writeFile(filename, JSON.stringify(invalid));
    await assert.rejects(loadConfig(filename), /Expected config/);
  }
});
