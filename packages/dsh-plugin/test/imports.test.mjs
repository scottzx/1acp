import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agent as acpAgent, RequestError } from '@agentclientprotocol/sdk';
import { WebSocketServer } from 'ws';
import { Session } from '@deepseek-ai/dsh-session';
import { NativeSessions } from '../dist/imports.js';
import { AcpAdapter } from '../dist/adapter.js';
import { State } from '../dist/state.js';
import { stream } from '../dist/transport.js';

const user = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
const seed = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
  { type: 'system/message', seq: 2, time: 1, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'system-head', role: 'system', source: { kind: 'system-prompt' }, content: [] } } },
  { type: 'user/message', seq: 3, time: 1, surfaceOp: 'append', data: user('old-question', 'old question') },
  { type: 'step/end', seq: 4, time: 2, data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: 5, time: 2, data: { turn: 1, reason: { kind: 'interrupted' } } },
];

async function fixture(t) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-native-import-')));
  const server = createServer((req, res) => { assert.equal(req.url, '/agents'); res.end(JSON.stringify({ agents: ['codex', 'claude', 'grok-build'].map(id => ({ id, label: id, chat_ready: true })) })); });
  const wss = new WebSocketServer({ server });
  const calls = [], prompts = [], paths = [];
  const flags = { createFailure: false, attachFailure: false, importFailure: false, resumeFailure: false, writerBusy: false, resumeBusy: false, disconnect: false };
  const executed = new Set();
  wss.on('connection', (ws, request) => {
    paths.push(request.url);
    let connection;
    const app = acpAgent()
      .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: { _meta: { '1agents': { version: 1 } } } }))
      .onRequest('_1agents/session/import', value => value, ({ params }) => {
        calls.push(['import', params.sessionId]);
        if (flags.writerBusy) throw new RequestError(-32000, 'thread native-123 already has an active writer');
        if (flags.importFailure) throw new RequestError(-32000, 'Native session cannot be restored');
        return { sessionId: `service-${calls.filter(c => c[0] === 'import').length}` };
      })
      .onRequest('session/resume', ({ params }) => {
        calls.push(['resume', params.sessionId]);
        if (flags.resumeBusy) throw new RequestError(-32000, 'thread native-123 already has an active writer');
        if (flags.resumeFailure) throw new RequestError(-32000, 'Authentication required');
        return {};
      })
      .onRequest('session/load', () => { throw new Error('Incomplete native replay must not use load'); })
      .onRequest('session/new', () => { throw new Error('Import must never create an empty native session'); })
      .onRequest('session/prompt', async ({ params }) => {
        prompts.push(params);
        const turnId = params._meta['1agents'].turnId;
        executed.add(turnId);
        if (flags.disconnect) { flags.disconnect = false; ws.terminate(); return new Promise(() => {}); }
        await connection.client.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'continued' }, _meta: { '1agents': { turnId, sequence: 1 } } } });
        return { stopReason: 'end_turn' };
      });
    connection = app.connect(stream(ws));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { serviceUrl: `http://127.0.0.1:${server.address().port}`, agents: ['codex', 'claude', 'grok-build'], stateDirectory: join(cwd, 'bindings'), reconnectAttempts: 1, reconnectDelayMs: 1 };
  const live = new Map(), stored = new Map(), attachments = new Set();
  let creates = 0;
  const makeAgent = session => ({ id: session.id, session, ctx: { inject: async (_deps, apply) => { apply({ commands: { register: () => () => {} }, effect: () => {} }); return { dispose: async () => {} }; } } });
  const ctx = {
    sessions: { prepare: (id, options) => Session.create(id, options.seed) },
    agents: { get: id => live.get(id), create: async options => {
      if (flags.createFailure) throw new Error('Local create failed');
      const session = Session.create(options.sessionId, options.seed, { version: 4, id: options.sessionId, createdAt: 1, isSeeded: false, delegationDepth: 0, ...options.meta });
      await options.setup({});
      const agent = makeAgent(session); live.set(agent.id, agent); stored.set(agent.id, session); creates++; return { agent };
    } },
    agentPresets: { resolve: async id => ({ id }), mount: async (_scope, id) => ({ id }) },
    sessionPersistence: { stat: async id => stored.has(id) ? { header: stored.get(id).header } : undefined },
    sessionController: { resolveAgent: async id => {
      if (!live.has(id) && stored.has(id)) live.set(id, makeAgent(stored.get(id)));
      return live.has(id) ? { agent: live.get(id) } : { error: new Error('Not found') };
    } },
    workspaceRegistry: { create: async path => ({ id: 'workspace', attachSession: async id => {
      assert.equal(path, cwd); if (flags.attachFailure) throw new Error('Workspace attach failed'); attachments.add(id);
    } }) },
    sessionProjections: { stateOf: (session, key) => key === 'agentPreset' ? session.header.agentPreset : { openTurnStartSeq: null, lastTurn: 1 } },
  };
  let adapter = new AcpAdapter(ctx, config), service = new NativeSessions(ctx, adapter, config);
  t.after(async () => { await Promise.all([service.dispose(), adapter.dispose()]); for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); rmSync(cwd, { recursive: true, force: true }); });
  return {
    cwd, config, ctx, flags, calls, prompts, paths, stored, executed,
    get adapter() { return adapter; }, get service() { return service; },
    input: { provider: 'codex', nativeSessionId: 'native-123', cwd, events: seed },
    counts: () => ({ creates, attachments: attachments.size }),
    restart: async () => { await Promise.all([service.dispose(), adapter.dispose()]); live.clear(); adapter = new AcpAdapter(ctx, config); service = new NativeSessions(ctx, adapter, config); },
  };
}

test('native import validates real DSH seed, deduplicates admission and restores after restart', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.service.importSession(f.input), f.service.importSession(f.input)]);
  assert.equal(results[0].dshSessionId, results[1].dshSessionId);
  assert.deepEqual(f.counts(), { creates: 1, attachments: 1 });
  assert.equal(f.calls.filter(c => c[0] === 'import').length, 1);
  await f.restart();
  const restored = await f.service.importSession({ ...f.input, events: [] });
  assert.equal(restored.dshSessionId, results[0].dshSessionId);
  assert.equal(f.stored.get(restored.dshSessionId).deriveMessages()[0].content[0].text, 'old question');
  assert.deepEqual(f.calls, [['import', 'native-123'], ['resume', 'service-1'], ['resume', 'service-1']]);
});

test('an imported trailing user message is never resent; reconnect repeats only the current request ID', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const result = await f.service.importSession(f.input);
  f.flags.disconnect = true;
  const output = [];
  for await (const chunk of f.adapter.stream({ provider: '1agents-acp', model: 'codex', sessionId: result.dshSessionId, messages: [user('old-question', 'old question'), user('new-question', 'continue')] })) output.push(chunk);
  assert.equal(output.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'continued');
  assert.equal(f.executed.size, 1);
  assert.equal(f.prompts.length, 2);
  assert.ok(f.prompts.every(p => p.sessionId === 'service-1' && p.prompt[0].text === 'continue'));
});

test('saved service identity survives local creation and workspace failures', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  f.flags.createFailure = true;
  await assert.rejects(f.service.importSession(f.input), /Local create/);
  await f.restart(); f.flags.createFailure = false; f.flags.attachFailure = true;
  await assert.rejects(f.service.importSession(f.input), /Workspace attach/);
  f.flags.attachFailure = false;
  await f.service.importSession(f.input);
  assert.equal(f.calls.filter(c => c[0] === 'import').length, 1);
  assert.deepEqual(f.counts(), { creates: 1, attachments: 1 });
});

test('unsupported providers, invalid cwd and malformed seed create no native session', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.availability('antigravity')).available, false);
  await assert.rejects(f.service.importSession({ ...f.input, provider: 'antigravity' }), /暂不支持/);
  await assert.rejects(f.service.importSession({ ...f.input, cwd: join(f.cwd, 'missing') }), /工作目录/);
  await assert.rejects(f.service.importSession({ ...f.input, events: [{ ...seed[0], seq: 7 }] }), /contiguous/);
  assert.equal(f.calls.length, 0);
});

test('restore errors remain errors; local imported history is not replaced', async t => {
  const f = await fixture(t);
  f.flags.importFailure = true;
  await assert.rejects(f.service.importSession(f.input), /cannot be restored/);
  assert.equal(f.counts().creates, 0);
  f.flags.importFailure = false; f.flags.resumeFailure = true;
  await assert.rejects(f.service.importSession(f.input), /Authentication/);
  f.flags.resumeFailure = false;
  const result = await f.service.importSession(f.input);
  assert.equal(new State(f.config.stateDirectory).get(result.dshSessionId).restoreMethod, 'session/resume');
  assert.equal(f.counts().creates, 1);
});

test('provider identities and endpoints are distinct; original cwd cannot change', async t => {
  const f = await fixture(t);
  const codex = await f.service.importSession(f.input);
  const claude = await f.service.importSession({ ...f.input, provider: 'claude' });
  const grok = await f.service.importSession({ ...f.input, provider: 'grok' });
  assert.equal(new Set([codex.dshSessionId, claude.dshSessionId, grok.dshSessionId]).size, 3);
  assert.ok(f.paths.includes('/agents/grok-build'));
  await assert.rejects(f.service.importSession({ ...f.input, cwd: tmpdir() }), /binding does not match/);
});

test('existing binding JSON accepts legacy load mode and rejects corrupted restore metadata', async t => {
  const { writeFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const f = await fixture(t);
  const state = new State(f.config.stateDirectory);
  state.save('legacy', { agent: 'codex', cwd: f.cwd, endpoint: 'ws://localhost/agents/codex', sessionId: 'service-old' });
  assert.equal(state.get('legacy').restoreMethod, undefined);
  const file = join(f.config.stateDirectory, createHash('sha256').update('legacy').digest('hex') + '.json');
  writeFileSync(file, JSON.stringify({ ...state.get('legacy'), restoreMethod: 'session/new' }));
  assert.throws(() => state.get('legacy'), /Invalid ACP restore method/);
});

test('missing plugin Agent configuration and an unavailable service leave imports read-only', async t => {
  const f = await fixture(t);
  const unconfigured = new NativeSessions(f.ctx, f.adapter, { ...f.config, agents: [] });
  assert.deepEqual(await unconfigured.availability('codex'), { available: false, agent: 'codex', reason: 'ACP 未启用 codex' });
  const unavailable = new NativeSessions(f.ctx, f.adapter, { ...f.config, serviceUrl: 'http://127.0.0.1:1' });
  assert.equal((await unavailable.availability('codex')).available, false);
  await assert.rejects(unavailable.importSession(f.input), /ACP 服务不可用/);
  assert.equal(f.calls.length, 0);
});


test('an empty native import cannot be replaced by draft preset switching', async t => {
  const f = await fixture(t);
  const result = await f.service.importSession({ ...f.input, events: [] });
  const agent = f.ctx.agents.get(result.dshSessionId);
  const saved = new State(f.config.stateDirectory).get(agent.id);
  f.ctx.sessionProjections.stateOf = (_session, key) => key === 'agentPreset' ? 'oneagents-acp-claude' : { openTurnStartSeq: null, lastTurn: 0 };
  await assert.rejects(f.adapter.describe(agent), /bound to another ACP Agent/);
  assert.deepEqual(new State(f.config.stateDirectory).get(agent.id), saved);
});


test('an active native writer blocks prompts, not DSH history creation; release restores the same session after restart', async t => {
  const f = await fixture(t);
  f.flags.writerBusy = true;
  const opened = await f.service.importSession(f.input);
  assert.equal(opened.writable, false);
  assert.equal(opened.blocked, 'active-writer');
  assert.deepEqual(f.counts(), { creates: 1, attachments: 1 });
  assert.equal(f.stored.get(opened.dshSessionId).deriveMessages()[0].content[0].text, 'old question');
  const state = new State(f.config.stateDirectory);
  assert.equal(state.get(opened.dshSessionId).sessionId, undefined);
  assert.equal(state.get(opened.dshSessionId).imported.nativeSessionId, 'native-123');
  await f.restart();
  const reopened = await f.service.importSession({ ...f.input, events: [] });
  assert.equal(reopened.dshSessionId, opened.dshSessionId);
  assert.equal(reopened.writable, false);
  const options = { provider: '1agents-acp', model: 'codex', sessionId: opened.dshSessionId, messages: [user('new-question', 'continue')] };
  await assert.rejects(async () => { for await (const _ of f.adapter.stream(options)) {} }, /active writer/);
  assert.equal(f.prompts.length, 0);
  f.flags.writerBusy = false;
  const ready = await f.adapter.describe(f.ctx.agents.get(opened.dshSessionId));
  assert.equal(ready.writable, true);
  for await (const _ of f.adapter.stream(options)) {}
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].sessionId, state.get(opened.dshSessionId).sessionId);
  assert.equal(f.prompts[0].prompt[0].text, 'continue');
  assert.deepEqual(f.counts(), { creates: 1, attachments: 1 });
});

test('writer contention during resume still opens history and later reuses the saved service identity', async t => {
  const f = await fixture(t);
  f.flags.resumeBusy = true;
  const opened = await f.service.importSession(f.input);
  assert.equal(opened.writable, false);
  assert.deepEqual(f.counts(), { creates: 1, attachments: 1 });
  const saved = new State(f.config.stateDirectory).get(opened.dshSessionId);
  f.flags.resumeBusy = false;
  assert.equal((await f.adapter.describe(f.ctx.agents.get(opened.dshSessionId))).writable, true);
  assert.equal(f.calls.filter(c => c[0] === 'import').length, 1);
  assert.equal(new State(f.config.stateDirectory).get(opened.dshSessionId).sessionId, saved.sessionId);
});
