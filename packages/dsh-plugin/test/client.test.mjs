import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function mount(preset, writable = true, assistantChildren, customFetch, reactHooks = {}) {
  let client, command;
  const remoteHandlers = new Map();
  const localHandlers = new Map();
  const presets = new Map();
  const slots = new Map();
  const calls = [], blocks = new Map(), cleanups = [];
  const nativeAssistant = { options: { key: 'assistant-step', priority: 0 }, locale: 'conversation',
    inject: () => ({ hooks: { presentation: {} } }), component: () => null,
    ...(assistantChildren ? { children: assistantChildren } : {}) };
  const nativeBash = { options: { key: 'bash' }, component: () => null };
  const entries = key => key === 'conversation.chat.node' ? [nativeAssistant] : [nativeBash];
  const native = { writable, blocked: writable ? undefined : 'active-writer', configOptions: [{ id: 'native-model', category: 'model', type: 'select', currentValue: 'b', options: [{ group: 'family', name: 'Family', options: [{ value: 'b', name: 'Native B' }] }] }] };
  runInNewContext(readFileSync(process.env.ACP_CLIENT_BUNDLE ?? new URL('../dist/client.js', import.meta.url), 'utf8'), {
    AbortController,
    setInterval: () => 0, clearInterval: () => {},
    window: { __ModuleLoader__: { load: module => { client = module.factory(() => ({ createElement: (type, props, ...children) => ({ type, props, children }), ...reactHooks })); } } },
    document: { createElement: () => ({ remove() {} }), head: { append() {} } },
    fetch: async (url, options) => { calls.push([url, options]); if (customFetch) return customFetch(url, options); return { ok: true, json: async () => native }; },
  });
  const ctx = {
    uiConversation: { events: { register: () => {} } },
    effect: setup => { const cleanup = setup(); if (cleanup) cleanups.push(cleanup); }, on: (name, handler) => localHandlers.set(name, handler),
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
  return { command, calls, slots, blocks, native, nativeAssistant, nativeBash, emitLocal: name => localHandlers.get(name)?.(), emitRemote: (name, ...args) => remoteHandlers.get(name)?.(...args), setPreset: (id, value) => presets.set(id, value), dispose: () => { for (const cleanup of cleanups) cleanup(); } };
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

test('native assistant child slots use the host content factories without redeclaring owned slots', async () => {
  const children = {
    'conversation.chat.reasoning.body': { kind: 'single', scope: 'session' },
    'conversation.chat.message.images': { kind: 'single', scope: 'session' },
  };
  const f = mount('oneagents-acp-codex', true, children);
  const entry = f.slots.get('assistant-step');
  assert.equal(entry.options.children, undefined);
  assert.equal(f.nativeAssistant.children, children);
  assert.equal(entry.options.inject, f.nativeAssistant.inject);
  assert.equal(entry.options.locale, f.nativeAssistant.locale);
  const calls = [];
  const renderFactorySlot = (name, owner) => { calls.push({ name, owner }); return name; };
  const owner = { sessionId: 's', renderFactorySlot, node: { data: { turn: 1, step: 1 } },
    useChat: selector => selector({ nodes: { values: () => [] } }) };
  const standard = entry.component(owner);
  assert.equal(standard.type, f.nativeAssistant.component);
  const reasoning = { text: 'Thinking', running: true };
  const images = { images: [{ attachment: 'image' }], loadImage: () => {}, align: 'start' };
  assert.equal(standard.props.renderSlot('conversation.chat.reasoning.body', reasoning), 'conversation.chat.reasoning.content');
  assert.equal(standard.props.renderSlot('conversation.chat.message.images', images), 'conversation.images.content');
  assert.equal(calls[0].owner, reasoning);
  assert.equal(calls[1].owner, images);
  const transcript = entry.component({ ...owner, node: { data: { acpTranscript: { groups: [
    { kind: 'reasoning', key: 'think', text: 'Thinking' },
  ] } } } }).children[0][0];
  assert.equal(transcript.type, f.nativeAssistant.component);
  transcript.props.renderSlot('conversation.chat.reasoning.body', reasoning);
  assert.equal(calls[2].name, 'conversation.chat.reasoning.content');
  assert.equal((await f.command.ui.options({ sessionId: 's' }))[0].label, 'Native B');
  f.dispose();
  assert.equal(f.slots.has('assistant-step'), false);
  assert.equal(f.nativeAssistant.children, children);
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
  const f = mount('oneagents-acp-codex', true, undefined, () => response);
  const context = { sessionId: 'pending-switch' };
  const loading = f.command.ui.options(context);
  assert.equal(f.blocks.get(context.sessionId).reason, 'loading');
  f.emitRemote('agent-preset/selected', context.sessionId, 'standard');
  const atSelection = f.blocks.get(context.sessionId);
  f.setPreset(context.sessionId, 'standard');
  rejectFetch(new Error('old ACP request failed'));
  assert.equal((await loading).length, 0);
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

test('a late ACP success cannot restore writer contention in standard mode', async () => {
  let resolveFetch;
  const response = new Promise(resolve => { resolveFetch = resolve; });
  const f = mount('oneagents-acp-codex', false, undefined, () => response);
  const context = { sessionId: 'pending-success' };
  const loading = f.command.ui.options(context);
  const signal = f.calls[0][1].signal;
  f.emitRemote('agent-preset/selected', context.sessionId, 'standard');
  assert.equal(signal.aborted, true);
  f.setPreset(context.sessionId, 'standard');
  resolveFetch({ ok: true, json: async () => f.native });
  assert.equal((await loading).length, 0);
  assert.equal(f.blocks.get(context.sessionId), undefined);
  assert.equal((await f.command.ui.options(context))[0].label, 'DSH model');
  f.dispose();
});

for (const outcome of ['success', 'failure']) test('a late ACP configuration ' + outcome + ' is ignored after switching mode', async () => {
  let settle;
  const response = new Promise((resolve, reject) => { settle = outcome === 'success' ? resolve : reject; });
  const f = mount('oneagents-acp-codex', false, undefined, () => response);
  const context = { sessionId: 'config-' + outcome };
  const updating = f.command.ui.onSelect({ id: JSON.stringify(['native-model', 'b']) }, context);
  assert.equal(f.calls[0][1].method, 'POST');
  f.emitRemote('agent-preset/selected', context.sessionId, 'standard');
  f.setPreset(context.sessionId, 'standard');
  settle(outcome === 'success' ? { ok: true, json: async () => f.native } : new Error('old configuration failed'));
  await updating;
  assert.equal(f.blocks.get(context.sessionId), undefined);
  assert.equal((await f.command.ui.options(context))[0].label, 'DSH model');
  f.dispose();
});

test('a current ACP configuration failure remains visible to the caller', async () => {
  const f = mount('oneagents-acp-codex', true, undefined, async () => { throw new Error('configuration failed'); });
  await assert.rejects(f.command.ui.onSelect({ id: JSON.stringify(['native-model', 'b']) }, { sessionId: 'current-config' }), /configuration failed/);
  f.dispose();
});

function hookRenderer() {
  const values = [], effects = [];
  let index = 0, pending = [];
  const hooks = {
    useState(initial) {
      const key = index++;
      if (!(key in values)) values[key] = initial;
      return [values[key], value => { values[key] = value; }];
    },
    useRef(initial) {
      const key = index++;
      if (!(key in values)) values[key] = { current: initial };
      return values[key];
    },
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useEffect(setup, dependencies) {
      const key = index++;
      const previous = effects[key];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        pending.push(() => {
          previous?.cleanup?.();
          effects[key] = { dependencies, cleanup: setup() };
        });
      }
    },
  };
  return {
    hooks,
    render(component, props) {
      index = 0;
      pending = [];
      const tree = component(props);
      for (const effect of pending) effect();
      return tree.children[0];
    },
  };
}

test('configuration busy clears after a same-mode reconnect without showing the old failure', async () => {
  const renderer = hookRenderer();
  let rejectPost;
  const response = new Promise((_resolve, reject) => { rejectPost = reject; });
  const f = mount('oneagents-acp-codex', true, undefined, async (_url, options) =>
    options.method === 'POST' ? response : { ok: true, json: async () => f.native }, renderer.hooks);
  const context = { sessionId: 'reconnect-controls' };
  const component = f.slots.get('conversation.input.model').component;
  const render = () => renderer.render(component, context);
  await f.command.ui.options(context);
  const updating = render()[0].props.onSelect('b');
  assert.equal(render()[0].props.disabled, true);
  f.emitLocal('connection/reset');
  render();
  rejectPost(new Error('old configuration failed'));
  await updating;
  await f.command.ui.options(context);
  const controls = render();
  assert.equal(controls[0].props.disabled, false);
  assert.equal(controls.some(control => control.props?.role === 'alert'), false);
  f.dispose();
});

test('a previous mode configuration cannot clear a newer configuration busy state', async () => {
  const renderer = hookRenderer();
  const posts = [];
  const f = mount('oneagents-acp-codex', true, undefined, async (_url, options) => {
    if (options.method === 'POST') return new Promise(resolve => posts.push(resolve));
    return { ok: true, json: async () => f.native };
  }, renderer.hooks);
  const context = { sessionId: 'switch-controls' };
  const component = f.slots.get('conversation.input.model').component;
  const render = () => renderer.render(component, context);
  await f.command.ui.options(context);
  const first = render()[0].props.onSelect('b');
  f.emitRemote('agent-preset/selected', context.sessionId, 'standard');
  f.setPreset(context.sessionId, 'standard');
  render();
  f.emitRemote('agent-preset/selected', context.sessionId, 'oneagents-acp-codex');
  f.setPreset(context.sessionId, 'oneagents-acp-codex');
  render();
  await f.command.ui.options(context);
  const second = render()[0].props.onSelect('b');
  posts[0]({ ok: true, json: async () => f.native });
  await first;
  let controls = render();
  assert.equal(controls[0].props.disabled, true);
  assert.equal(controls.some(control => control.props?.role === 'alert'), false);
  posts[1]({ ok: true, json: async () => f.native });
  await second;
  controls = render();
  assert.equal(controls[0].props.disabled, false);
  assert.equal(controls.some(control => control.props?.role === 'alert'), false);
  f.dispose();
});
