import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { client, type SessionNotification } from '@agentclientprotocol/sdk';
import { attachAcpConnection, webSocketStream, type RuntimeBackend, type RuntimePeer } from '../src/acp-connection.js';
import { AcpState } from '../src/acp-state.js';
import { dispatchCommand, activeSessions, pendingPermissions, pendingAskUserQuestions, pendingExitPlanModes } from '../src/bridge.js';

async function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'acp-protocol-'));
  const state = new AcpState(directory);
  const sessions = new Map<string, any>();
  const records = new Map<string, any>();
  let starts = 0;
  const pending = new Map<string, () => void>();
  const backend: RuntimeBackend = {
    sessions, record: async id => records.get(id), status: async () => ({ configOptions: [] }), history: async () => [],
    async dispatch(peer, command) {
      const id = command.sessionId;
      const emit = (event: object) => peer.send(JSON.stringify({ ...event, sessionId: id }));
      if (command.action === 'ensure_session') {
        const session = sessions.get(id) || { handle: { cwd: command.workspacePath }, agentType: command.agentType };
        if (session.ws && session.ws !== peer) session.ws.send(JSON.stringify({ event: 'session_taken_over', sessionId: id }));
        session.ws = peer; sessions.set(id, session); records.set(id, { cwd: command.workspacePath });
        if (session.permission) emit(session.permission);
        emit({ event: 'session_ready', agentSessionId: 'native', turnProtocolVersion: 3 });
      } else if (command.action === 'prompt') {
        starts++;
        const session = sessions.get(id)!; session.activeTurn = {};
        const finish = () => {
          session.permission = undefined;
          session.ws.send(JSON.stringify({ event: 'text_delta', sessionId: id, text: 'answer', type: 'output' }));
          session.activeTurn = null;
          session.ws.send(JSON.stringify({ event: 'done', sessionId: id, stopReason: 'end_turn' }));
        };
        if (command.text === 'tools') {
          const content = [{ type: 'content', content: { type: 'text', text: 'README.md' } }];
          emit({ event: 'tool_call', toolCallId: 'exec-1', toolName: 'Bash', title: 'ls -la', kind: 'execute', status: 'in_progress', arguments: { command: 'ls -la' } });
          emit({ event: 'tool_call', toolCallId: 'exec-1', content });
          emit({ event: 'tool_call', toolCallId: 'exec-1', status: 'completed', rawOutput: { stdout: 'README.md' } });
          emit({ event: 'tool_result', toolCallId: 'exec-1', text: '', isError: false });
          queueMicrotask(finish);
        } else if (command.text === 'ask' || command.text === 'plan') {
          session.permission = { event: command.text === 'ask' ? 'ask_user_question' : 'exit_plan_mode', requestId: 'logical-interaction', toolCallId: 'tool', questions: [{ question: 'Proceed?' }], planContent: 'Plan' };
          pending.set(id, finish); emit(session.permission);
        } else if (command.text === 'permission') {
          session.permission = { event: 'permission_request', requestId: 'logical-permission', toolCallId: 'tool', toolName: 'Write', options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }, { optionId: 'no', kind: 'reject_once', name: 'Reject' }] };
          pending.set(id, finish); emit(session.permission);
        } else if (command.text === 'wait') pending.set(id, finish);
        else { queueMicrotask(finish); }
      } else if (command.action === 'respond_ask_user_question' || command.action === 'respond_exit_plan_mode') {
        pending.get(id)?.(); pending.delete(id);
      } else if (command.action === 'respond_permission') {
        assert.equal(command.behavior, 'allow_once'); pending.get(id)?.(); pending.delete(id);
      } else if (command.action === 'cancel_turn') {
        const session = sessions.get(id)!; session.activeTurn = null;
        emit({ event: 'done', stopped: true }); pending.delete(id);
      } else if (command.action === 'close_session') {
        sessions.delete(id);
      }
    },
  };
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => attachAcpConnection(ws, req, backend, state));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  async function connect(permission?: (p: any) => Promise<any>, agentName = 'codex', extensionHandler?: (p: any) => Promise<any>) {
    const updates: SessionNotification[] = [];
    const events: any[] = [];
    let summaryArrived!: () => void;
    const summaryReceived = new Promise<void>(resolve => { summaryArrived = resolve; });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agents/${agentName}`);
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const connection = client().onNotification('session/update', ({ params }) => { updates.push(params); })
      .onRequest('session/request_permission', async ({ params }) => permission ? permission(params) : ({ outcome: { outcome: 'cancelled' as const } }))
      .onRequest('_x.ai/ask_user_question', (p: unknown) => p, ({ params }) => extensionHandler!(params))
      .onRequest('_x.ai/exit_plan_mode', (p: unknown) => p, ({ params }) => extensionHandler!(params))
      .onNotification('_1agents/events/turn_complete', (p: unknown) => p, ({ params }) => { events.push(params); summaryArrived(); })
      .connect(webSocketStream(ws));
    await connection.agent.request('initialize', { protocolVersion: 1, clientCapabilities: extensionHandler ? { _meta: { '1agents': { version: 1 } } } : {} });
    return { connection, ws, updates, events, summaryReceived };
  }
  return { connect, sessions, state, backend, starts: () => starts, port };
}

test('official ACP client creates, prompts, replays and resumes without replay', async t => {
  const f = await fixture(t); const a = await f.connect();
  const { sessionId } = await a.connection.agent.request('session/new', { cwd: '/tmp', mcpServers: [] });
  const result = await a.connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello' }] });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(a.updates.filter(u => u.update.sessionUpdate === 'agent_message_chunk').length, 1);
  a.ws.close(); await a.connection.closed;
  const b = await f.connect();
  await b.connection.agent.request('session/load', { sessionId, cwd: '/tmp', mcpServers: [] });
  assert.deepEqual(b.updates.map(u => u.update.sessionUpdate), ['user_message_chunk', 'agent_message_chunk']);
  const c = await f.connect();
  await c.connection.agent.request('session/resume', { sessionId, cwd: '/tmp', mcpServers: [] });
  assert.equal(c.updates.length, 0);
  await assert.rejects(b.connection.agent.request('session/prompt', { sessionId, prompt: [] }), /not attached/);
  const wrong = await f.connect(undefined, 'grok-build');
  await assert.rejects(wrong.connection.agent.request('session/resume', { sessionId, cwd: '/tmp', mcpServers: [] }), { code: -32602 });
  await c.connection.agent.request('session/close', { sessionId });
});

test('tool observations preserve ACP titles, structured output and sparse update semantics through replay', async t => {
  const f = await fixture(t); const a = await f.connect();
  const { sessionId } = await a.connection.agent.request('session/new', { cwd: '/tmp', mcpServers: [] });
  await a.connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'tools' }] });
  const tools = a.updates.map(u => u.update).filter(u => u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update');
  assert.equal(tools.length, 4);
  assert.equal(tools[0].sessionUpdate, 'tool_call');
  assert.equal(tools[0].title, 'ls -la');
  assert.deepEqual(tools[0].rawInput, { command: 'ls -la' });
  assert.ok(tools.slice(1).every(u => u.sessionUpdate === 'tool_call_update'));
  assert.equal(tools[1].title, undefined);
  assert.equal(tools[1].status, undefined);
  assert.equal(tools[1].content?.[0].type, 'content');
  assert.deepEqual(tools[2].rawOutput, { stdout: 'README.md' });
  assert.equal(tools[3].content, undefined); // Empty legacy terminal notification must not erase content.
  assert.equal(tools[3].rawOutput, undefined);
  a.ws.close(); await a.connection.closed;
  const b = await f.connect();
  await b.connection.agent.request('session/load', { sessionId, cwd: '/tmp', mcpServers: [] });
  const replayed = b.updates.map(u => u.update).filter(u => u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update');
  assert.deepEqual(replayed, tools);
});

test('pending permission survives a dropped transport and settles once after resume', async t => {
  const f = await fixture(t);
  let seen!: () => void; const received = new Promise<void>(r => { seen = r; });
  let late!: (value: any) => void;
  const a = await f.connect(async () => { seen(); return new Promise(r => { late = r; }); });
  const { sessionId } = await a.connection.agent.request('session/new', { cwd: '/tmp', mcpServers: [] });
  const turn = a.connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'permission' }] }).catch(() => undefined);
  await received; a.ws.terminate(); await a.connection.closed; await turn;
  let approved!: () => void; const approval = new Promise<void>(r => { approved = r; });
  const b = await f.connect(async p => { assert.equal(p.options[0].optionId, 'yes'); approved(); return { outcome: { outcome: 'selected', optionId: 'yes' } }; });
  await b.connection.agent.request('session/resume', { sessionId, cwd: '/tmp', mcpServers: [] });
  await approval;
  late({ outcome: { outcome: 'selected', optionId: 'yes' } });
  // A subsequent RPC forms a transport barrier after the approval response.
  await b.connection.agent.request('session/resume', { sessionId, cwd: '/tmp', mcpServers: [] });
  assert.equal(f.starts(), 1);
  assert.equal(f.sessions.get(sessionId).permission, undefined);
});

test('cancellation settles the original prompt and structured attachments are recorded', async t => {
  const f = await fixture(t); const a = await f.connect();
  const { sessionId } = await a.connection.agent.request('session/new', { cwd: '/tmp', mcpServers: [] });
  const result = a.connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'wait' }, { type: 'image', mimeType: 'image/png', data: 'AA==' }] });
  await a.connection.agent.notify('session/cancel', { sessionId });
  assert.equal((await result).stopReason, 'cancelled');
  assert.equal(f.state.history(sessionId)[1]?.sessionUpdate, 'user_message_chunk');
  await assert.rejects(a.connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }, { type: 'text', text: 'after' }] }), { code: -32602 });
});

for (const [kind, map, response, outcome] of [
  ['permission_request', pendingPermissions, 'respond_permission', { behavior: 'allow_once' }],
  ['ask_user_question', pendingAskUserQuestions, 'respond_ask_user_question', { outcome: 'accepted', answers: { q: 'yes' } }],
  ['exit_plan_mode', pendingExitPlanModes, 'respond_exit_plan_mode', { outcome: 'rejected' }],
] as const) {
  test(`runtime replays ${kind}, rejects previous owner and ignores duplicate answers`, async t => {
    const id = `reconnect-${kind}`; const requestId = `pending-${kind}`;
    const old = { readyState: 1, send() {} }; const events: any[] = [];
    const next = { readyState: 1, send(raw: string) { events.push(JSON.parse(raw)); } };
    let settled = 0;
    const timer = setTimeout(() => {}, 30_000);
    activeSessions.set(id, { ws: old, handle: {}, activeTurn: { hostTurnId: 'turn', eventSequence: 0 }, agentType: 'codex', responsePolicy: 'summary' });
    map.set(requestId, { sessionId: id, timer, resolve() { settled++; }, payload: { event: kind, sessionId: id, requestId } });
    t.after(() => { clearTimeout(timer); map.delete(requestId); activeSessions.delete(id); });
    await dispatchCommand(next, { action: 'ensure_session', sessionId: id, workspacePath: '/tmp', agentType: 'codex', responsePolicy: 'summary' });
    assert.equal(events.filter(e => e.event === kind).length, 1);
    await dispatchCommand(old, { action: response, sessionId: id, requestId, ...outcome });
    assert.equal(settled, 0);
    await dispatchCommand(next, { action: response, sessionId: id, requestId, ...outcome });
    await dispatchCommand(next, { action: response, sessionId: id, requestId, ...outcome });
    assert.equal(settled, 1);
    const after: any[] = [];
    await dispatchCommand({ readyState: 1, send(raw: string) { after.push(JSON.parse(raw)); } }, { action: 'ensure_session', sessionId: id, workspacePath: '/tmp', agentType: 'codex', responsePolicy: 'summary' });
    assert.equal(after.filter(e => e.event === kind).length, 0);
  });
}

for (const text of ['ask', 'plan']) {
  test(`Grok ${text} request is reissued after reconnect without restarting the turn`, async t => {
    const f = await fixture(t);
    let seen!: () => void; const received = new Promise<void>(r => { seen = r; });
    const a = await f.connect(undefined, 'grok-build', async () => { seen(); return new Promise(() => {}); });
    const { sessionId } = await a.connection.agent.request('session/new', { cwd: '/tmp', mcpServers: [] });
    const turn = a.connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }).catch(() => undefined);
    await received; a.ws.terminate(); await a.connection.closed; await turn;
    const b = await f.connect(undefined, 'grok-build', async () => text === 'ask' ? ({ outcome: 'accepted', answers: { q: 'yes' } }) : ({ outcome: 'approved' }));
    await b.connection.agent.request('session/resume', { sessionId, cwd: '/tmp', mcpServers: [] });
    await b.connection.agent.request('session/resume', { sessionId, cwd: '/tmp', mcpServers: [] });
    assert.equal(f.starts(), 1);
    assert.equal(f.sessions.get(sessionId).permission, undefined);
  });
}

test('summary delivery retains a complete standard replay log', async t => {
  const f = await fixture(t); const a = await f.connect(undefined, 'codex', async () => ({}));
  const { sessionId } = await a.connection.agent.request('session/new', { cwd: '/tmp', mcpServers: [], _meta: { '1agents': { responsePolicy: 'summary' } } });
  const result = await a.connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello' }] });
  assert.equal(a.updates.length, 0);
  assert.equal((result._meta?.['1agents'] as any).resultText, 'answer');
  await a.summaryReceived;
  assert.equal(a.events.length, 1);
  await a.connection.agent.request('session/load', { sessionId, cwd: '/tmp', mcpServers: [] });
  assert.deepEqual(a.updates.map(u => u.update.sessionUpdate), ['user_message_chunk', 'agent_message_chunk']);
});

test('live takeover rejects the old prompt and cannot accept its late approval', async t => {
  const f = await fixture(t);
  let seen!: () => void; const received = new Promise<void>(r => { seen = r; });
  let late!: (v: any) => void;
  const a = await f.connect(async () => { seen(); return new Promise(resolve => { late = resolve; }); });
  const { sessionId } = await a.connection.agent.request('session/new', { cwd: '/tmp', mcpServers: [] });
  const original = a.connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'permission' }] });
  const rejected = assert.rejects(original, /taken over/);
  await received;
  const b = await f.connect(async () => ({ outcome: { outcome: 'selected', optionId: 'yes' } }));
  await b.connection.agent.request('session/resume', { sessionId, cwd: '/tmp', mcpServers: [] });
  await rejected;
  late({ outcome: { outcome: 'selected', optionId: 'yes' } });
  await b.connection.agent.request('session/resume', { sessionId, cwd: '/tmp', mcpServers: [] });
  assert.equal(f.starts(), 1);
});

test('deleting from another connection settles the active prompt and prevents resume', async t => {
  const f = await fixture(t); const a = await f.connect(); const b = await f.connect();
  const { sessionId } = await a.connection.agent.request('session/new', { cwd: '/tmp', mcpServers: [] });
  const turn = a.connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'wait' }] });
  await a.connection.agent.request('session/list', {});
  await b.connection.agent.request('session/delete', { sessionId });
  assert.equal((await turn).stopReason, 'cancelled');
  await assert.rejects(b.connection.agent.request('session/resume', { sessionId, cwd: '/tmp', mcpServers: [] }), { code: -32003 });
});

test('load advertises current native commands even when the runtime emits no new command event', async t => {
  const f = await fixture(t);
  f.backend.status = async () => ({ configOptions: [], availableCommands: [{ name: 'review', description: 'Review changes', hasInput: true, inputHint: 'Scope' }] });
  const a = await f.connect();
  const { sessionId } = await a.connection.agent.request('session/new', { cwd: '/tmp', mcpServers: [] });
  a.ws.close(); await a.connection.closed;
  const b = await f.connect();
  await b.connection.agent.request('session/load', { sessionId, cwd: '/tmp', mcpServers: [] });
  assert.deepEqual(b.updates.at(-1)?.update, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review changes', input: { hint: 'Scope' } }] });
  assert.equal(f.starts(), 0);
});

test('native model config retains ACP select tags and grouped choices through load and updates', async t => {
  const f = await fixture(t);
  const native = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'a', options: [{ group: 'family', name: 'Family', options: [{ value: 'a', name: 'A' }] }] }];
  f.backend.status = async () => ({ configOptions: [{ id: 'model', name: 'Model', currentValue: 'a', options: [{ value: 'a', name: 'A' }] }], details: { configOptions: native } });
  const a = await f.connect();
  const result = await a.connection.agent.request('session/new', { cwd: '/tmp', mcpServers: [] });
  assert.deepEqual(result.configOptions, native);
  const updated = await a.connection.agent.request('session/set_config_option', { sessionId: result.sessionId, configId: 'model', value: 'a' });
  assert.deepEqual(updated.configOptions, native);
});
