import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const binPath = fileURLToPath(new URL('../dist/bin/acp-service.js', import.meta.url));

for (const [stdin, signal] of [['ignore', 'SIGTERM'], ['pipe', 'SIGINT']] as const) {
  test(`service stays available with ${stdin} stdin and shuts down on ${signal}`, { timeout: 15_000 }, async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), 'acp-service-process-'));
    const child = spawn(process.execPath, [binPath, 'serve', '--host', '127.0.0.1', '--port', '0', '--no-report'], {
      stdio: [stdin, 'pipe', 'pipe'],
      env: { ...process.env, ACP_STATE_DIR: stateDirectory },
    });
    let output = '';
    child.stdout!.on('data', chunk => { output += chunk.toString(); });
    child.stderr!.on('data', chunk => { output += chunk.toString(); });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal }));
    });
    try {
      const healthUrl = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Service did not start:\n${output}`)), 10_000);
        child.stdout!.on('data', () => {
          const match = output.match(/Health: (http:\/\/127\.0\.0\.1:\d+\/health)/);
          if (match) {
            clearTimeout(timer);
            resolve(match[1]!);
          }
        });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        void closed.then(result => {
          clearTimeout(timer);
          reject(new Error(`Service exited before readiness (${result.code}, ${result.signal}):\n${output}`));
        });
        child.stdin?.end();
      });
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3_000) });
      assert.equal(response.status, 200);
      const health = await response.json() as { status: string; service: string };
      assert.equal(health.status, 'ok');
      assert.equal(health.service, 'acp-service');
      assert.equal(child.exitCode, null);
      child.kill(signal);
      const result = await closed;
      assert.equal(result.code, 0, output);
      assert.equal(result.signal, null, output);
      assert.match(output, new RegExp(`Received ${signal}`));
      assert.match(output, /Cleaning up all active sessions/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
}
