/** Verify the tarball installed outside the workspace can load and launch its runtime. */
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const archive = resolve(process.argv[2]);
const directory = mkdtempSync(join(tmpdir(), 'acp-service-package-'));
const flowDirectory = mkdtempSync(join(tmpdir(), 'acp-service-external-flow-'));
try {
  writeFileSync(join(directory, 'package.json'), '{"private":true,"type":"module"}\n');
  execFileSync('npm', ['install', archive, '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], { cwd: directory, stdio: 'inherit', timeout: 180_000 });
  writeFileSync(join(directory, 'smoke.mjs'), `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { execFileSync } from 'node:child_process';
    import { createAgentRegistry, createRuntimeStore } from '@1agents/acp-service/runtime';
    import { defineFlow } from '@1agents/acp-service/flows';
    const require = createRequire(import.meta.url);
    assert.ok(createAgentRegistry().list().includes('codex'));
    assert.ok(createRuntimeStore({ stateDir: './state' }));
    assert.equal(typeof defineFlow, 'function');
    assert.throws(() => require.resolve('@scottzx/1acp'));
    assert.throws(() => require.resolve('@1agents/dsh-acp'));
    assert.throws(() => require.resolve('@deepseek-ai/cordis'));
    const cli = require.resolve('@1agents/acp-service/runtime-cli');
    assert.match(execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }), /Usage:/);
    const service = require.resolve('@1agents/acp-service/package.json').replace(/package\\.json$/, 'dist/bin/acp-service.js');
    assert.match(execFileSync(process.execPath, [service, '--help'], { encoding: 'utf8' }), /acp-service serve/);
    assert.match(execFileSync(process.execPath, [service, 'codex', '--help'], { encoding: 'utf8' }), /codex/);
    const api = await import('@1agents/acp-service');
    assert.equal(typeof api.serveAcpService, 'function');
    assert.equal(typeof api.apply, 'function');
    const serviceApi = await import('@1agents/acp-service/service');
    assert.equal(serviceApi.serveAcpService, api.serveAcpService);
    const server = await api.serveAcpService({ host: '127.0.0.1', port: 0, report: false });
    await server.close();
  `);
  execFileSync(process.execPath, ['smoke.mjs'], { cwd: directory, stdio: 'inherit', timeout: 60_000 });
  mkdirSync(join(directory, 'home'));
  for (const extension of ['ts', 'cts', 'mts', 'mjs']) {
    const flow = join(flowDirectory, `external.flow.${extension}`);
    writeFileSync(flow, `import { compute, defineFlow } from '@1agents/acp-service/flows';
      export default defineFlow({ name: 'installed-flow', startAt: 'done', nodes: {
        done: compute({ run: () => ({ ok: true }) })
      }, edges: [] });`);
    const output = execFileSync(process.execPath, [join(directory, 'node_modules/@1agents/acp-service/dist/bin/acp-service.js'),
      '--approve-all', '--cwd', directory, '--format', 'json', 'flow', 'run', flow], {
      cwd: directory, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, HOME: join(directory, 'home') },
    });
    assert.equal(JSON.parse(output.trim()).status, 'completed');
  }
  // Run the existing real-runtime protocol scenario against the installed
  // package, including detached queue owners, replay and session resume.
  const testDirectory = join(directory, 'test');
  mkdirSync(join(testDirectory, 'fixtures'), { recursive: true });
  cpSync(new URL('../packages/service/test/fixtures/acp-agent.mjs', import.meta.url), join(testDirectory, 'fixtures/acp-agent.mjs'));
  const installedTests = ['acp-runtime.integration.test.ts', 'catalog.test.ts'];
  for (const file of installedTests) {
    const source = readFileSync(new URL(`../packages/service/test/${file}`, import.meta.url), 'utf8')
      .replaceAll("'../src/", "'./node_modules/@1agents/acp-service/dist/src/");
    writeFileSync(join(directory, file), source.replace("'./fixtures/acp-agent.mjs'", "'./test/fixtures/acp-agent.mjs'"));
  }
  execFileSync(process.execPath, ['--test', ...installedTests], { cwd: directory, stdio: 'inherit', timeout: 60_000 });
  if (process.argv[3]) {
    cpSync(new URL('./smoke-dsh-package.mjs', import.meta.url), join(directory, 'dsh-smoke.mjs'));
    execFileSync(process.execPath, ['--expose-internals', 'dsh-smoke.mjs', resolve(process.argv[3])], {
      cwd: directory, stdio: 'inherit', timeout: 60_000,
      env: { ...process.env, ACP_STATE_DIR: join(directory, 'state'), DSH_HOME: join(directory, 'dsh-home') },
    });
  }
  console.log('Installed service tarball smoke test passed');
} finally {
  rmSync(directory, { recursive: true, force: true });
  rmSync(flowDirectory, { recursive: true, force: true });
}
