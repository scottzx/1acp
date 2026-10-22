import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function mount(preset, writable = true, customFetch) {
  let client, command;
  const remoteHandlers = new Map();
  const presets = new Map();
  const slots = new Map();
  const calls = [], blocks = new Map(), cleanups = [];
  const nativeAssistant = { options: { key: 'assistant-step', priority: 0 }, locale: 'conversation',
    inject: () => ({ hooks: { presentation: {} } }), component: () => null };
  const nativeBash = { options: { key: 'bash' }, component: () => null };
  const entries = key => key === 'conversation.chat.node' ? [nativeAssistant] : [nativeBash];
  const native = { writable, blocked: writable ? undefined : 'active-writer', configOptions: [{ id: 'native-model', category: 'model', type: 'select', currentValue: 'b', options: [{ group: 'family', name: 'Family', options: [{ value: 'b', name: 'Native B' }] }] }] };
  runInNewContext(readFileSync(process.env.ACP_CLIENT_BUNDLE ?? new URL('../dist/client.js', import.meta.url), 'utf8'), {
    AbortController,
    window: { __ModuleLoader__: { load: module => { client = module.factory(() => ({ createElement: (type, props, ...children) => ({ type, props, children }) })); } } },
    document: { createElement: () => ({ remove() {} }), head: { append() {} } },
    fetch: async (url, options) => { calls.push([url, options]); if (customFetch) return customFetch(url, options); return { ok: true, json: async () => native }; },
  });
  const ctx = {
    uiConversation: { events: { register: () => {} } },
    effect: setup => { const cleanup = setup(); if (cleanup) cleanups.push(cleanup); }, on: () => {},
    conversation: { blocks: { set: (id, block) => blocks.set(id, block) } },
    locale: { register: () => {}, bind: () => key => key === 'toolGroup' ? '已调用 {count} 个工具' : key },
    slots: { entries, inject: (_key, setup) => { const cleanup = setup(); if (cleanup) cleanups.push(cleanup); }, register: (options, component) => {
      if (entries(options.name).some(entry => entry.options.key === options.key && (entry.options.priority ?? 0) === (options.priority ?? 0))) throw new Error('duplicate slot priority');
      const key = options.key ?? options.name; slots.set(key, { options, component });
      return () => slots.delete(key);
    } },
    sessions: { binding: id => ({ session: { projections: { faceOf: () => ({ getSnapshot: () => presets.get(id) ?? preset }) } } }), subagentAddress: () => undefined },
    remote: { $on: (name, handler) => remoteHandlers.set(name, handler), session: {
      modelCatalog: async () => ({ ok: true, value: { groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'dsh-model', name: 'DSH model' }] }] } }),
      selectModel: async value => { calls.push(value); return { ok: true }; },
    } },
    commandUi: { register: value => { command = value; } },
  };
  client.apply(ctx);
  return { command, calls, slots, blocks, native, nativeAssistant, nativeBash, emitRemote: (name, ...args) => remoteHandlers.get(name)?.(...args), setPreset: (id, value) => presets.set(id, value), dispose: () => { for (const cleanup of cleanups) cleanup(); } };
}

test('/model in ACP sessions uses native grouped options and forwards the native config id', async () => {
  const { command, calls } = mount('oneagents-acp-codex');
  const context = { sessionId: 'acp-session' };
  assert.equal(command.description(), 'description');
  const options = await command.ui.options(context);
  assert.equal(options[0].label, 'Native B');
  assert.equal(options[0].active, true);
  await command.ui.onSelect(options[0], context);
  assert.deepEqual(JSON.parse(calls[1][1].body), { configId: 'native-model', value: 'b' });
});

test('/model in standard sessions keeps the ordinary DSH selection API', async () => {
  const { command, calls } = mount('standard');
  const context = { sessionId: 'dsh-session' };
  assert.equal(command.description(), 'description');
  const options = await command.ui.options(context);
  assert.equal(options[0].label, 'DSH model');
  await command.ui.onSelect(options[0], context);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ sessionId: 'dsh-session', provider: 'deepseek', model: 'dsh-model' }]);
});


test('native writer contention disables only its composer, then clears after restoration and on unload', async () => {
  const f = mount('oneagents-acp-codex', false);
  const context = { sessionId: 'busy-session' };
  await f.command.ui.options(context);
  assert.equal(f.blocks.get(context.sessionId).reason, 'activeWriter');
  assert.equal(f.blocks.has('other-session'), false);
  f.native.writable = true;
  await f.command.ui.options(context);
  assert.equal(f.blocks.get(context.sessionId), undefined);
  f.native.writable = false;
  await f.command.ui.options(context);
  f.dispose();
  assert.equal(f.blocks.get(context.sessionId), undefined);
});

test('ordered ACP groups reuse native renderers, disclose independent peer calls, and unload cleanly', () => {
  const f = mount('oneagents-acp-codex');
  const entry = f.slots.get('assistant-step');
  assert.ok(entry.options.priority < f.nativeAssistant.options.priority);
  assert.equal(entry.options.inject, f.nativeAssistant.inject);
  assert.equal(entry.options.locale, 'conversation');
  let open = false;
  const roots = [{ callId: 'a', name: 'Bash', phase: 'start', subCalls: [] }, { callId: 'b', name: 'Bash', phase: 'start', subCalls: [] }];
  const owner = { sessionId: 'acp', useChat: selector => selector({ nodes: { values: () => [] } }),
    useDisclosure: () => ({ expanded: open, toggle: () => { open = !open; } }),
    node: { data: { turn: 1, step: 1, acpTranscript: { groups: [
      { kind: 'text', key: 'intro', text: 'Before' }, { kind: 'tools', key: 'a', roots },
      { kind: 'reasoning', key: 'think', text: 'Thinking' }, { kind: 'tools', key: 'c', roots: [roots[0]] },
      { kind: 'text', key: 'answer', text: 'After' },
    ] } } } };
  const rendered = entry.component(owner).children[0];
  assert.equal(rendered[0].type, f.nativeAssistant.component);
  assert.equal(rendered[2].type, f.nativeAssistant.component);
  assert.equal(rendered[4].type, f.nativeAssistant.component);
  assert.equal(rendered[2].props.node.data.blocks[0].kind, 'reasoning');
  const group = rendered[1];
  const closed = group.type(group.props);
  assert.equal(closed.children[0].props['aria-expanded'], false);
  assert.equal(closed.children[1], null);
  assert.equal(closed.children[0].children[0], '⌄ 已调用 2 个工具');
  closed.children[0].props.onClick();
  const peers = group.type(group.props).children[1].children[0];
  assert.equal(peers.length, 2);
  for (const peer of peers) assert.equal(peer.type, f.nativeBash.component);
  assert.equal(peers[0].props.block, roots[0]);
  assert.equal(peers[1].props.block, roots[1]);
  f.dispose();
  assert.equal(f.slots.has('assistant-step'), false);
});

test('standard messages delegate to DSH; an ACP original is hidden only when an ordered projection exists', () => {
  for (const preset of ['standard', 'oneagents-acp-codex']) {
    const f = mount(preset);
    const node = { data: { turn: 1, step: 2 } };
    const owner = { node, sessionId: 's', useChat: selector => selector({ nodes: { values: () => [{ data: {
      turn: 1, step: 2, acpTranscript: {},
    } }] } }) };
    const rendered = f.slots.get('assistant-step').component(owner);
    assert.equal(rendered.type, preset === 'standard' ? f.nativeAssistant.component : 'span');
    const unmatched = f.slots.get('assistant-step').component({ ...owner,
      useChat: selector => selector({ nodes: { values: () => [] } }) });
    assert.equal(unmatched.type, f.nativeAssistant.component);
  }
});

test('standard selection clears ACP loading before the projection catches up', async () => {
  const f = mount('oneagents-acp-codex');
  const context = { sessionId: 'switching' };
  await f.command.ui.options(context);
  f.emitRemote('agent-preset/selected', context.sessionId, 'standard');
  assert.equal(f.blocks.get(context.sessionId), undefined);
  f.setPreset(context.sessionId, 'standard');
  assert.equal((await f.command.ui.options(context))[0].label, 'DSH model');
  f.dispose();
});

test('an in-flight ACP failure cannot restore a block after switching to standard', async () => {
  let rejectFetch;
  const response = new Promise((resolve, reject) => { rejectFetch = reject; });
  const f = mount('oneagents-acp-codex', true, () => response);
  const context = { sessionId: 'pending-switch' };
  const loading = f.command.ui.options(context).catch(error => error);
  assert.equal(f.blocks.get(context.sessionId).reason, 'loading');
  f.emitRemote('agent-preset/selected', context.sessionId, 'standard');
  const atSelection = f.blocks.get(context.sessionId);
  f.setPreset(context.sessionId, 'standard');
  rejectFetch(new Error('old ACP request failed'));
  await loading;
  assert.equal(atSelection, undefined);
  assert.equal(f.blocks.get(context.sessionId), undefined);
  f.dispose();
});

test('preset selection invalidates only the selected session', async () => {
  const f = mount('oneagents-acp-codex', false);
  await f.command.ui.options({ sessionId: 'first' });
  await f.command.ui.options({ sessionId: 'second' });
  assert.equal(f.blocks.get('second').reason, 'activeWriter');
  f.emitRemote('agent-preset/selected', 'first', 'standard');
  assert.equal(f.blocks.get('first'), undefined);
  assert.equal(f.blocks.get('second').reason, 'activeWriter');
  f.dispose();
});
