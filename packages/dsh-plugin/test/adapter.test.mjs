import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agent as acpAgent } from '@agentclientprotocol/sdk';
import { WebSocketServer } from 'ws';
import { AcpAdapter } from '../dist/adapter.js';
import { stream } from '../dist/transport.js';
import { State } from '../dist/state.js';

async function fixture(t, disconnect = false, interaction = 'permission', beforeNew = async () => {}, toolUpdates = []) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-acp-test-'));
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => wss.once('listening', r));
  let creations = 0, executions = 0, permissions = 0, dropped = false;
  const records = new Map();
  const replay = new Map();
  const waiting = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const prompts = [];
  const changes = [];
  const commands = new Map();
  let model = 'native-a';
  const configOptions = () => [{ id: 'native-model', name: 'Native model', category: 'model', type: 'select', currentValue: model, options: [{ value: 'native-a', name: 'Native A' }, { value: 'native-b', name: 'Native B' }] }];
  wss.on('connection', ws => {
    let connection;
    const app = acpAgent()
      .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true, _meta: { '1agents': { version: 1 } } } }))
      .onRequest('session/new', async () => {
        await beforeNew();
        const sessionId = 'remote-' + (++creations);
        await connection.client.notify('session/update', { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Native review', input: { hint: 'Scope' } }, { name: 'model', description: 'Native model' }] } });
        return { sessionId, configOptions: configOptions(), modes: { currentModeId: 'read', availableModes: [{ id: 'read', name: 'Read' }, { id: 'write', name: 'Write' }] } };
      })
      .onRequest('session/set_config_option', async ({ params }) => {
        assert.equal(params.configId, 'native-model');
        assert.ok(['native-a', 'native-b'].includes(params.value));
        changes.push(params); model = params.value;
        await connection.client.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'status', description: 'Native status' }] } });
        return { configOptions: configOptions() };
      })
      .onRequest('session/set_mode', ({ params }) => { changes.push(params); return {}; })
      .onRequest('session/load', async ({ params }) => { for (const update of replay.get(params.sessionId) ?? []) await connection.client.notify('session/update', { sessionId: params.sessionId, update }); return {}; })
      .onNotification('session/cancel', () => cancelled.resolve())
      .onRequest('session/prompt', async ({ params }) => {
        prompts.push(params.prompt);
        const turnId = params._meta['1agents'].turnId;
        const key = params.sessionId + turnId;
        const seen = records.get(key);
        if (!seen) { executions++; records.set(key, true); }
        const update = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ACP' }, _meta: { '1agents': { turnId, sequence: 1 } } };
        if (!seen) {
          const updates = [update, ...toolUpdates.map((u, i) => ({ ...u, _meta: { ...u._meta, '1agents': { ...u._meta?.['1agents'], turnId, sequence: i + 2 } } }))];
          replay.set(params.sessionId, updates);
          for (const update of updates) await connection.client.notify('session/update', { sessionId: params.sessionId, update });
        }
        if (disconnect && !dropped) { dropped = true; ws.terminate(); return new Promise(() => {}); }
        if (interaction === 'question') {
          const result = await connection.client.request('_x.ai/ask_user_question', { questions: [{ question: 'Choose targets', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }] });
          assert.deepEqual(result, { outcome: 'accepted', answers: { 'Choose targets': ['A', 'B'] } });
          const plan = await connection.client.request('_x.ai/exit_plan_mode', { planContent: 'Read the project' });
          assert.deepEqual(plan, { outcome: 'approved' });
          return { stopReason: 'end_turn' };
        }
        const permission = await connection.client.request('session/request_permission', { sessionId: params.sessionId, toolCall: { toolCallId: 'edit', title: 'Edit file', rawInput: { path: '/tmp/example' } }, options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] });
        if (interaction !== 'pending') assert.equal(permission.outcome.optionId, 'once');
        return { stopReason: 'end_turn' };
      });
    connection = app.connect(stream(ws));
  });
  const local = { id: 'dsh-session', session: { header: { cwd: directory, agentPreset: 'oneagents-acp-codex' }, boundary: { openTurnStartSeq: null, lastTurn: 0 } }, ctx: { commands: { register: definition => { commands.set(definition.name, definition); return () => commands.delete(definition.name); } } } };
  local.session.append = () => { throw new Error('Remote tools must use existing stream records'); };
  const scopedCommands = local.ctx.commands;
  delete local.ctx.commands;
  local.ctx.inject = async (deps, apply) => { assert.deepEqual(deps, ['commands']); apply({ commands: scopedCommands, effect: () => {} }); return { dispose: async () => {} }; };
  const sent = []; local.followup = m => sent.push(m);
  const ctx = { sessionProjections: { stateOf: (session, key) => key === 'turnBoundary' ? session.boundary : session.header.agentPreset }, agents: { get: id => id === local.id ? local : undefined }, approval: { request: async request => {
    permissions++; assert.equal(request.agent, local);
    if (interaction === 'pending') {
      waiting.resolve();
      await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
      return 'cancelled';
    }
    if (interaction === 'reconnect-permission' && permissions === 1) {
      const aborted = new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
      for (const ws of wss.clients) ws.terminate();
      await aborted;
      return 'cancelled';
    }
    return 'allowed-once';
  } }, userQuestions: { ask: async request => {
    assert.equal(request.agent, local);
    const q = request.questions[0];
    if (q.id === 'plan') {
      assert.equal(q.detail, 'Read the project');
      return { answers: [{ id: q.id, selected: ['批准'] }] };
    }
    assert.equal(q.multiSelect, true);
    return { answers: [{ id: q.id, selected: ['A', 'B'] }] };
  } } };
  const config = { serviceUrl: `http://127.0.0.1:${wss.address().port}`, agents: ['codex', 'grok-build'], stateDirectory: directory, reconnectAttempts: 2, reconnectDelayMs: 1 };
  const adapter = new AcpAdapter(ctx, config);
  t.after(async () => { await adapter.dispose(); for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); rmSync(directory, { recursive: true, force: true }); });
  const options = id => ({ provider: '1agents-acp', model: 'codex', sessionId: local.id, messages: [{ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }] });
  return { adapter, options, config, ctx, local, sent, prompts, changes, commands, waiting: waiting.promise, cancelled: cancelled.promise, counts: () => ({ creations, executions, permissions }) };
}
async function collect(adapter, options) { const chunks = []; for await (const c of adapter.stream(options)) chunks.push(c); return chunks; }

test('main session streams ACP output, surfaces approval, and retains remote identity', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const first = await collect(f.adapter, f.options('message-1'));
  assert.equal(first.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'Hello ACP');
  assert.equal(first.at(-1).reason.kind, 'stop');
  assert.ok(!first.some(c => c.type === 'tool-call-delta'));
  await collect(f.adapter, f.options('message-2'));
  assert.deepEqual(f.counts(), { creations: 1, executions: 2, permissions: 2 });
  await assert.rejects(collect(f.adapter, { ...f.options('message-3'), model: 'grok-build' }), /matching Agent preset/);
});

test('reconnect replays missing output and reuses the prompt id without duplicate execution', { timeout: 5000 }, async t => {
  const f = await fixture(t, true);
  const output = await collect(f.adapter, f.options('message-1'));
  assert.equal(output.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'Hello ACP');
  assert.deepEqual(f.counts(), { creations: 1, executions: 1, permissions: 1 });
});

test('remote tool updates are durable observations, retain omitted fields, and never pollute reasoning or execute locally', { timeout: 5000 }, async t => {
  const updates = [
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspect the directory.' } },
    { sessionUpdate: 'tool_call', toolCallId: 'exec-1', title: 'ls -la', kind: 'execute', status: 'in_progress', rawInput: { command: 'ls -la' }, _meta: { '1agents': { toolName: 'Bash' } } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', content: [{ type: 'content', content: { type: 'text', text: 'README.md' } }] },
    { sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', status: 'completed', rawOutput: 'README.md' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', status: 'completed' },
    { sessionUpdate: 'tool_call', toolCallId: 'exec-2', title: 'Read missing file', kind: 'read', status: 'pending', rawInput: { path: '/missing' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'exec-2', status: 'failed', rawOutput: 'File missing' },
  ];
  const f = await fixture(t, true, 'permission', async () => {}, updates);
  f.local.session.boundary = { lastTurn: 3, lastStepStartSeq: 10 };
  f.local.session.eventAt = () => ({ type: 'step/start', data: { turn: 3, step: 2 } });
  const chunks = await collect(f.adapter, f.options('tools-1'));
  assert.equal(chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join(''), 'Inspect the directory.');
  assert.ok(!chunks.some(c => c.type === 'tool-call-delta' || c.block?.type === 'tool-call'));
  const observations = chunks.filter(c => c.type === 'block-end' && c.block.acpTool).map(c => c.block.acpTool);
  assert.equal(observations.length, 6); // Replay did not duplicate any observation.
  assert.ok(observations.every(e => e.turn === 3 && e.step === 2));
  const completed = observations[3].tool;
  assert.equal(completed.title, 'ls -la');
  assert.equal(completed.name, 'Bash');
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.rawInput, { command: 'ls -la' });
  assert.equal(completed.content[0].content.text, 'README.md');
  assert.equal(observations.at(-1).tool.status, 'failed');
  assert.deepEqual(f.counts(), { creations: 1, executions: 1, permissions: 1 });
  const next = await collect(f.adapter, f.options('tools-2'));
  assert.notEqual(observations[0].requestId, next.find(c => c.block?.acpTool).block.acpTool.requestId);
  assert.ok(chunks.filter(c => c.block?.acpTool).every(c => c.block.type === 'text' && c.block.text === ''));
});

test('binding survives a new adapter instance', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await collect(f.adapter, f.options('message-1'));
  const state = new State(f.config.stateDirectory);
  assert.equal(state.get('dsh-session').sessionId, 'remote-1');
  assert.equal(state.get('different-session'), undefined);
  await f.adapter.dispose();
  const restored = new AcpAdapter(f.ctx, f.config);
  try { await collect(restored, f.options('message-2')); assert.equal(f.counts().creations, 1); }
  finally { await restored.dispose(); }
});

test('Grok questions and plan review use DSH interactions', { timeout: 5000 }, async t => {
  const f = await fixture(t, false, 'question');
  const result = await collect(f.adapter, f.options('message-1'));
  assert.equal(result.at(-1).reason.kind, 'stop');
});

test('stopping while permission is pending cancels remote work and settles the stream', { timeout: 5000 }, async t => {
  const f = await fixture(t, false, 'pending');
  const controller = new AbortController();
  const output = collect(f.adapter, { ...f.options('message-1'), signal: controller.signal });
  await f.waiting;
  controller.abort();
  assert.equal((await output).at(-1).reason.kind, 'aborted');
  await f.cancelled;
});

test('connection loss withdraws the old approval and presents the replayed request', { timeout: 5000 }, async t => {
  const f = await fixture(t, false, 'reconnect-permission');
  const result = await collect(f.adapter, f.options('message-1'));
  assert.equal(result.at(-1).reason.kind, 'stop');
  assert.equal(result.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'Hello ACP');
  assert.deepEqual(f.counts(), { creations: 1, executions: 1, permissions: 2 });
});

test('ACP routes are absent from the model catalog and cannot run under a standard preset', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.adapter.listModels('1agents-acp'), []);
  f.local.session.header.agentPreset = 'standard';
  assert.equal(await f.adapter.describe(f.local), null);
  await assert.rejects(collect(f.adapter, f.options('message-1')), /matching Agent preset/);
  assert.equal(f.counts().creations, 0);
});

test('only user-authored messages reach ACP, excluding DSH instructions and runtime context', async t => {
  const f = await fixture(t);
  const options = f.options('message-1');
  options.messages.push({ id: 'injected', role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'DSH injected instructions' }] });
  options.messages.push({ id: 'runtime', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'DSH runtime context' }] });
  await collect(f.adapter, options);
  assert.deepEqual(f.prompts, [[{ type: 'text', text: 'hello' }]]);
});

test('native commands, models and modes are discovered before prompting and stay session-local', async t => {
  const f = await fixture(t);
  const info = await f.adapter.describe(f.local);
  assert.equal(info.configOptions[0].currentValue, 'native-a');
  assert.equal(info.commands[0].name, 'review');
  assert.ok(!f.commands.has('model'));
  await f.commands.get('review').handler({ rawInput: '  current changes' });
  assert.equal(f.sent[0].content[0].text, '/review  current changes');
  assert.equal(f.sent[0].source.kind, 'user');
  const updated = await f.adapter.configure(f.local, 'native-model', 'native-b');
  assert.equal(updated.configOptions[0].currentValue, 'native-b');
  assert.ok(f.commands.has('status'));
  assert.ok(!f.commands.has('review'));
  assert.equal((await f.adapter.configure(f.local, '$mode', 'write')).modes.currentModeId, 'write');
  await collect(f.adapter, f.options('message-1'));
  assert.equal(f.counts().creations, 1);
  assert.deepEqual(f.changes.map(c => c.sessionId), ['remote-1', 'remote-1']);
});

test('unstarted sessions switch ACP agents and replace native commands', async t => {
  const f = await fixture(t);
  f.local.session.header.agentPreset = 'oneagents-acp-grok-build';
  await f.adapter.describe(f.local);
  await f.adapter.configure(f.local, 'native-model', 'native-b');
  assert.ok(f.commands.has('status'));
  f.local.session.header.agentPreset = 'oneagents-acp-codex';
  assert.equal((await f.adapter.describe(f.local)).agent, 'codex');
  assert.ok(!f.commands.has('status'));
  assert.ok(f.commands.has('review'));
  await collect(f.adapter, f.options('first-message'));
  assert.deepEqual(f.counts(), { creations: 2, executions: 1, permissions: 1 });
  assert.equal(new State(f.config.stateDirectory).get(f.local.id).agent, 'codex');
});

test('started sessions reject a different ACP binding', async t => {
  const f = await fixture(t);
  await collect(f.adapter, f.options('first-message'));
  f.local.session.boundary.lastTurn = 1;
  f.local.session.header.agentPreset = 'oneagents-acp-grok-build';
  await assert.rejects(f.adapter.describe(f.local), /bound to another ACP/);
  assert.equal(f.counts().creations, 1);
});

test('switching while discovery is pending serializes the replacement connection', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await fixture(t, false, 'permission', async () => { entered.resolve(); await release.promise; });
  f.local.session.header.agentPreset = 'oneagents-acp-grok-build';
  const first = f.adapter.describe(f.local);
  await entered.promise;
  f.local.session.header.agentPreset = 'oneagents-acp-codex';
  const second = f.adapter.describe(f.local);
  release.resolve();
  await first;
  assert.equal((await second).agent, 'codex');
  await collect(f.adapter, f.options('first-message'));
  assert.deepEqual(f.counts(), { creations: 2, executions: 1, permissions: 1 });
});

test('draft switching preserves endpoint protection and requires known turn state', async t => {
  const f = await fixture(t);
  await f.adapter.describe(f.local);
  f.local.session.header.agentPreset = 'oneagents-acp-grok-build';
  f.local.session.boundary = undefined;
  await assert.rejects(f.adapter.describe(f.local), /bound to another ACP/);
  f.local.session.boundary = { openTurnStartSeq: null, lastTurn: 0 };
  const state = new State(f.config.stateDirectory);
  state.save(f.local.id, { ...state.get(f.local.id), endpoint: 'ws://other.example/agents/codex' });
  await assert.rejects(f.adapter.describe(f.local), /bound to another ACP/);
  assert.equal(f.counts().creations, 1);
});
