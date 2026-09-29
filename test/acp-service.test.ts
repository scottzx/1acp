import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { serveAcpService } from '../src/server.js';
import { ACP_CAPABILITIES, buildManifest } from '../src/manifest.js';
import { resolveResponsePolicy } from '../src/bridge.js';

test('buildManifest produces valid DreamMate Network Manifest', async () => {
  const manifest = await buildManifest('http://localhost:36812');
  assert.equal(manifest.online, true);
  assert.ok(manifest.node_id);
  assert.ok(manifest.name);
  assert.equal(manifest.services.length, 1);

  const svc = manifest.services[0];
  assert.equal(svc.id, 'acp-service');
  assert.equal(svc.kind, 'agent_runtime');
  assert.ok(svc.capabilities.includes('agent.prompt'));
  assert.ok(svc.capabilities.includes('agent.response_policy'));
  assert.ok(svc.capabilities.includes('runtime.claude'));
  assert.ok(svc.capabilities.includes('runtime.grok'));
  assert.ok(ACP_CAPABILITIES.includes('agent.response_policy'));
  assert.ok(svc.access && svc.access.length > 0);
  assert.equal(svc.access[0].protocol, 'acp');
});

test('serveAcpService serves HTTP endpoints and WebSocket', async () => {
  // Use port 0 to bind to a random available port during test
  const service = await serveAcpService({ port: 0, host: '127.0.0.1', report: false });
  const { port } = service;
  assert.ok(port > 0);

  try {
    // 1. Test GET /health
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json() as { status: string; service: string; kind: string };
    assert.equal(health.status, 'ok');
    assert.equal(health.service, 'acp-service');
    assert.equal(health.kind, 'agent_runtime');

    // 2. Test GET /manifest
    const manifestRes = await fetch(`http://127.0.0.1:${port}/manifest`);
    assert.equal(manifestRes.status, 200);
    const manifest = await manifestRes.json() as { services: Array<{ id: string }> };
    assert.equal(manifest.services[0].id, 'acp-service');

    // 3. Test WebSocket connection
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    // Send an invalid json message, should receive INVALID_JSON error
    const messagePromise = new Promise<string>((resolve) => {
      ws.once('message', (data) => resolve(data.toString()));
    });
    ws.send('invalid json');
    const responseText = await messagePromise;
    const response = JSON.parse(responseText) as { jsonrpc: string; error: { code: number } };
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.error.code, -32700);

    ws.close();
  } finally {
    await service.close();
  }
});

test('CLI supports unified help and command forwarding', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const binPath = fileURLToPath(new URL('../dist/bin/acp-service.js', import.meta.url));

  // 1. Test top-level --help
  const helpOutput = execFileSync(process.execPath, [binPath, '--help'], { encoding: 'utf-8' });
  assert.match(helpOutput, /Usage: acp-service/);
  assert.match(helpOutput, /serve \[options\]/);
  assert.match(helpOutput, /codex \[options\]/);
  assert.match(helpOutput, /claude \[options\]/);
  assert.match(helpOutput, /--port, -p/);

  // 2. Test serve --help
  const serveHelp = execFileSync(process.execPath, [binPath, 'serve', '--help'], { encoding: 'utf-8' });
  assert.match(serveHelp, /用法: acp-service serve/);
  assert.match(serveHelp, /--port/);

  // 3. Test -V / --version
  const versionOutput = execFileSync(process.execPath, [binPath, '-V'], { encoding: 'utf-8' });
  assert.match(versionOutput, /@1agents\/acp-service v/);

  // 4. Test config show forwarding
  const configOutput = execFileSync(process.execPath, [binPath, 'config', 'show'], { encoding: 'utf-8' });
  const config = JSON.parse(configOutput);
  assert.ok(config.defaultAgent);
});

test('resolveResponsePolicy defaults to stream and accepts per-prompt override', () => {
  assert.equal(resolveResponsePolicy(undefined, undefined), 'stream');
  assert.equal(resolveResponsePolicy('live', 'stream'), 'stream');
  assert.equal(resolveResponsePolicy(undefined, 'summary'), 'summary');
  assert.equal(resolveResponsePolicy('summary', 'stream'), 'summary');
  assert.equal(resolveResponsePolicy('stream', 'summary'), 'stream');
});

