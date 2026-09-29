import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { client } from '@agentclientprotocol/sdk';
import { createAgentRegistry, createRuntimeStore } from '@scottzx/1acp/runtime';
import { WebSocket } from 'ws';

test('ACP WebSocket traverses the real 1acp runtime and external stdio Agent', { timeout: 20000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'acp-runtime-'));
  process.env.ACP_STATE_DIR = directory;
  const { runtime } = await import('../src/bridge.js');
  const { serveAcpService } = await import('../src/server.js');
  const { webSocketStream } = await import('../src/acp-connection.js');
  // Configure the lazy runtime before its first Agent starts. Only the Agent
  // process is a fixture; session persistence, permissions and transport are real.
  const options = Reflect.get(runtime, 'options');
  options.sessionStore = createRuntimeStore({ stateDir: directory });
  options.agentRegistry = createAgentRegistry({ overrides: { codex: [process.execPath, fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url))] } });
  const service = await serveAcpService({ host: '127.0.0.1', port: 0, report: false });
  t.after(async () => { await service.close(); delete process.env.ACP_STATE_DIR; rmSync(directory, { recursive: true, force: true }); });
  const ws = new WebSocket(`ws://127.0.0.1:${service.port}/agents/codex`);
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const updates: string[] = [];
  let permissions = 0;
  const connection = client().onNotification('session/update', ({ params }) => { updates.push(params.update.sessionUpdate); })
    .onRequest('session/request_permission', ({ params }) => { permissions++; assert.equal(params.options[0].optionId, 'yes'); return { outcome: { outcome: 'selected' as const, optionId: 'yes' } }; })
    .connect(webSocketStream(ws));
  await connection.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = await connection.agent.request('session/new', { cwd: directory, mcpServers: [] });
  const result = await connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'perform fixture operation' }] });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(permissions, 1);
  assert.ok(updates.includes('tool_call'));
  assert.ok(updates.includes('tool_call_update'));
  assert.ok(updates.includes('agent_message_chunk'));
  await connection.agent.request('session/close', { sessionId });
  const list = await connection.agent.request('session/list', {});
  assert.ok(list.sessions.some(session => session.sessionId === sessionId), 'closed sessions remain resumable');
  await connection.agent.request('session/resume', { sessionId, cwd: directory, mcpServers: [] });
  const resumed = await connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'continue fixture operation' }] });
  assert.equal(resumed.stopReason, 'end_turn');
  assert.equal(permissions, 2);
  await connection.agent.request('session/delete', { sessionId });
  await assert.rejects(connection.agent.request('session/resume', { sessionId, cwd: directory, mcpServers: [] }), { code: -32003 });
  assert.equal((await connection.agent.request('session/list', {})).sessions.length, 0);
  ws.close();
});
