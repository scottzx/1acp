import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from './model-route.js';

const route = Object.freeze({ provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' });

/** Model the Cordis scope filter, prepend order, and effect-owned listeners. */
function scopedEvents() {
  const listeners = [];
  const context = scope => {
    const owned = new Set();
    return {
      get agentDefaultModel() { throw new Error('Global model default access is forbidden'); },
      get root() { throw new Error('Root registration is forbidden'); },
      on(event, handler, options = {}) {
        const entry = { scope, event, handler };
        if (options.prepend) listeners.unshift(entry);
        else listeners.push(entry);
        owned.add(entry);
        return () => {
          const index = listeners.indexOf(entry);
          if (index !== -1) listeners.splice(index, 1);
          owned.delete(entry);
        };
      },
      dispose() {
        for (const entry of owned) listeners.splice(listeners.indexOf(entry), 1);
        owned.clear();
      },
    };
  };
  return {
    context,
    scopes: () => listeners.map(entry => entry.scope),
    async waterfall(scopes, event, args, fallback) {
      const handlers = listeners.filter(entry => scopes.includes(entry.scope) && entry.event === event);
      return handlers.reduceRight((next, entry) => () => entry.handler(...args, next), fallback)();
    },
  };
}

test('backup requests keep controls, clear the previous effort, and override a session route', async () => {
  const bus = scopedEvents();
  apply(bus.context('wechat-mp-draft-standard'), route);
  bus.context('draft-session').on('agent/request', async (_payload, next) => ({
    ...await next(), provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high',
  }));
  const seed = Object.freeze({ provider: 'old', model: 'old', temperature: 0.2, maxTokens: 4096, stop: ['END'] });
  const result = await bus.waterfall(['wechat-mp-draft-standard', 'draft-session'], 'agent/request', [{}], async () => seed);
  assert.deepEqual(result, { ...seed, ...route });
  assert.equal(seed.provider, 'old');
  assert.equal(Object.hasOwn(result, 'reasoningEffort'), false);
  assert.strictEqual(result.stop, seed.stop);
});

test('prompt assembly and the actual request state the same backup model', async () => {
  const bus = scopedEvents();
  apply(bus.context('wechat-mp-draft-standard'), route);
  const source = { sections: [{ name: 'persona' }], contexts: [], tools: [], variables: { cwd: '/task' } };
  const result = await bus.waterfall(['wechat-mp-draft-standard'], 'system-prompt/assemble', [source, {}], async () => source);
  assert.deepEqual(result.variables, { cwd: '/task', ...route });
  assert.strictEqual(result.sections, source.sections);
  assert.deepEqual(source.variables, { cwd: '/task' });
});

test('standard and other presets stay on their own route', async () => {
  const bus = scopedEvents();
  const draft = bus.context('wechat-mp-draft-standard');
  apply(draft, route);
  const original = Object.freeze({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' });
  const result = await bus.waterfall(['standard', 'other-session'], 'agent/request', [{}], async () => original);
  assert.strictEqual(result, original);
  draft.dispose();
  const afterUnload = await bus.waterfall(['wechat-mp-draft-standard'], 'agent/request', [{}], async () => original);
  assert.strictEqual(afterUnload, original);
  assert.deepEqual(bus.scopes(), []);
});

test('invalid route configuration rejects before installing listeners', () => {
  const bus = scopedEvents();
  for (const config of [undefined, {}, { provider: '', model: 'x' }, { provider: 'x', model: '  ' }]) {
    assert.throws(() => apply(bus.context('wechat-mp-draft-standard'), config), /requires nonempty/);
  }
  assert.deepEqual(bus.scopes(), []);
});
