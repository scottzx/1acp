import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentRegistry, createRuntimeStore } from '@1agents/acp-service/runtime';
import { nativeFixture } from './helpers/native-errors.mjs';

for (const mode of ['terminal-gap', 'native-pending', 'terminal-saved', 'graceful-active']) {
  test(`official host cold restart reconciles ${mode} from the plugin domain without native resend`, {
    skip: process.env.DSH_SOURCE ? false : 'Set DSH_SOURCE to an official built DSH checkout', timeout: 30000,
  }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'acp-host-restart-'));
    const children = new Set(); let service;
    const oldState = process.env.ACP_STATE_DIR;
    t.after(async () => {
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      }
      await service?.close();
      if (oldState === undefined) delete process.env.ACP_STATE_DIR; else process.env.ACP_STATE_DIR = oldState;
      await rm(directory, { recursive: true, force: true });
    });
    const calls = join(directory, 'calls.txt'), events = join(directory, 'events.jsonl'), nativePath = join(directory, 'native.mjs');
    await writeFile(calls, ''); await writeFile(events, ''); await writeFile(nativePath, nativeFixture);
    process.env.ACP_STATE_DIR = join(directory, 'runtime');
    const serviceRoot = dirname(createRequire(import.meta.url).resolve('@1agents/acp-service/package.json'));
    const bridge = await import(pathToFileURL(join(serviceRoot, 'dist/src/bridge.js')).href);
    const options = Reflect.get(bridge.runtime, 'options');
    options.sessionStore = createRuntimeStore({ stateDir: process.env.ACP_STATE_DIR });
    options.agentRegistry = createAgentRegistry({ overrides: { codex: [process.execPath, nativePath, calls, events] } });
    const { serveAcpService } = await import('@1agents/acp-service/service');
    service = await serveAcpService({ host: '127.0.0.1', port: 0, report: false });
    const sdk = createRequire(join(serviceRoot, 'package.json'));
    const { SendMessageRequest, GetTaskRequest, TaskState } = await import(pathToFileURL(sdk.resolve('@a2a-js/sdk')).href);
    const { ClientFactory } = await import(pathToFileURL(sdk.resolve('@a2a-js/sdk/client')).href);
    const auth = { serviceParameters: { Authorization: 'Bearer synthetic-test-token' } };
    async function start(kind) {
      const child = fork(new URL('./helpers/host-process.mjs', import.meta.url), [directory, `http://127.0.0.1:${service.port}`, kind],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.add(child); let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
      const ready = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(stderr); })]);
      assert.equal(ready[0].ready, true); return { child, client: await new ClientFactory().createFromUrl(ready[0].url) };
    }
    const first = await start(mode); const exited = once(first.child, 'exit');
    const kind = mode === 'native-pending' ? 'restart-pending' : mode === 'graceful-active' ? 'confirmed-active-cancel' : 'quota';
    const admitted = await first.client.sendMessage(SendMessageRequest.fromJSON({
      message: { messageId: 'restart-request', role: 'ROLE_USER', parts: [{ text: kind }] },
      configuration: { returnImmediately: true },
    }), auth);
    const deadline = Date.now() + 10000;
    let before;
    if (mode === 'graceful-active') {
      while (!(await readFile(calls, 'utf8')).includes(kind)) {
        assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5));
      }
      first.child.send('close'); assert.equal((await exited)[0], 0);
    } else if (mode === 'terminal-saved') {
      do {
        before = await first.client.getTask(GetTaskRequest.fromJSON({ id: admitted.id }), auth);
        if (before.status.state === TaskState.TASK_STATE_FAILED) break;
        assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));
      } while (true);
      first.child.send('close'); assert.equal((await exited)[0], 0);
    } else {
      if (mode === 'native-pending') {
        while (!(await readFile(calls, 'utf8')).includes('restart-pending')) {
          assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.ok(!(await readFile(events, 'utf8')).includes('late-provider-error'));
        first.child.kill('SIGKILL');
      }
      assert.equal((await exited)[1], 'SIGKILL');
    }
    const countBefore = (await readFile(calls, 'utf8')).trim().split('\n').length;
    assert.equal(countBefore, 1);
    const second = await start('normal');
    const task = await second.client.getTask(GetTaskRequest.fromJSON({ id: admitted.id }), auth);
    assert.equal(task.status.state, mode === 'graceful-active' ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED);
    const error = task.metadata['1agents'].error;
    if (mode === 'graceful-active') t.diagnostic(JSON.stringify({ shutdownError: error, diagnostics: JSON.parse(await readFile(join(directory, 'adapter/diagnostics/oneagents_acp_diagnostics.json'), 'utf8')), nativeEvents: await readFile(events, 'utf8') }));
    assert.equal(error.category, mode === 'native-pending' ? 'unknown' : mode === 'graceful-active' ? 'cancelled' : 'quota');
    assert.equal(error.providerCode, mode === 'native-pending' || mode === 'graceful-active' ? undefined : 'usageLimitExceeded');
    assert.equal(error.outcomeUnknown, mode === 'native-pending');
    assert.match(error.operationId, /^a2a-[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(task).includes('SYNTHETIC_SECRET_CANARY'));
    if (mode === 'terminal-saved') assert.deepEqual(error, before.metadata['1agents'].error);
    else if (mode !== 'graceful-active') assert.match(task.status.message.parts[0].content.value, /interrupted.*not restarted/i);
    assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, countBefore);
    const again = await second.client.getTask(GetTaskRequest.fromJSON({ id: admitted.id }), auth);
    assert.deepEqual(again.metadata['1agents'].error, error);
    const exitSecond = once(second.child, 'exit'); second.child.send('close'); assert.equal((await exitSecond)[0], 0);
    t.diagnostic(JSON.stringify({ mode, state: task.status.state, error, nativeCalls: countBefore }));
  });
}
