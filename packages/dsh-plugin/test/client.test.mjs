import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function mount(preset, writable = true) {
  let client, command;
  const slots = new Map();
  const calls = [], blocks = new Map(), cleanups = [];
  const native = { writable, blocked: writable ? undefined : 'active-writer', configOptions: [{ id: 'native-model', category: 'model', type: 'select', currentValue: 'b', options: [{ group: 'family', name: 'Family', options: [{ value: 'b', name: 'Native B' }] }] }] };
  runInNewContext(readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: module => { client = module.factory(() => ({ createElement: (type, props, ...children) => ({ type, props, children }) })); } } },
    fetch: async (url, options) => { calls.push([url, options]); return { ok: true, json: async () => native }; },
  });
  const ctx = {
    uiConversation: { events: { register: () => {} } },
    effect: setup => { const cleanup = setup(); if (cleanup) cleanups.push(cleanup); }, on: () => {},
    conversation: { blocks: { set: (id, block) => blocks.set(id, block) } },
    locale: { register: () => {}, bind: () => key => key },
    slots: { inject: (_key, setup) => setup(), register: (options, component) => { slots.set(options.key ?? options.name, { options, component }); } },
    sessions: { binding: () => ({ session: { projections: { faceOf: () => ({ getSnapshot: () => preset }) } } }), subagentAddress: () => undefined },
    remote: { $on: () => {}, session: {
      modelCatalog: async () => ({ ok: true, value: { groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'dsh-model', name: 'DSH model' }] }] } }),
      selectModel: async value => { calls.push(value); return { ok: true }; },
    } },
    commandUi: { register: value => { command = value; } },
  };
  client.apply(ctx);
  return { command, calls, slots, blocks, native, dispose: () => { for (const cleanup of cleanups) cleanup(); } };
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


test('ACP cards register without redeclaring native slots and display command, status and output', () => {
  const { slots } = mount('oneagents-acp-codex');
  const { options, component } = slots.get('oneagents-acp-tools');
  assert.equal(options.name, 'conversation.chat.node');
  assert.equal(options.children, undefined);
  const tree = component({ t: key => key, node: { data: { roots: [{
    kind: 'tool-result', callId: 'remote-exec', call: { name: 'Bash', argsRaw: '{"command":"ls -la"}' },
    content: [{ type: 'text', text: 'README.md' }], isError: false,
  }] } } });
  const card = tree.children[0][0];
  assert.equal(card.type, 'details');
  assert.equal(card.props['data-acp-status'], 'completed');
  assert.equal(card.children[0].children[0].children[0], 'Bash');
  assert.equal(card.children[0].children[3].children[0], 'ls -la');
  assert.equal(card.children[1].children[0], 'README.md');
});
