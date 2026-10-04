import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { inject } from '../dist/index.js';
import { mountDshA2A } from '../dist/a2a.js';
import { FileA2AStore } from '@1agents/acp-service/a2a';

const realDsh = { skip: process.env.DSH_SOURCE ? false : 'Set DSH_SOURCE to a built matching DSH checkout for the real Loader/webServer smoke test', timeout: 10000 };

async function fixture(t) {
  const requireHost = createRequire(join(process.env.DSH_SOURCE, 'packages/client/modules/package.json'));
  const load = name => import(pathToFileURL(requireHost.resolve(name)).href);
  const [{ default: Loader }, { default: WebServer }] = await Promise.all([
    load('@deepseek-ai/cordis-plugin-loader'), load('@deepseek-ai/dsh-host-webserver'),
  ]);
  const directory = await mkdtemp(join(tmpdir(), 'dsh-a2a-plugin-')), ctx = new Context();
  const presets = new Map();
  let adapters = 0;
  for (const name of inject) if (name !== 'webServer') ctx.provide(name, {});
  ctx.set('llm', { registerAdapter: () => { adapters++; return () => { adapters--; }; } });
  ctx.set('agentPresets', { register: async definition => {
    presets.set(definition.id, definition);
    return () => presets.delete(definition.id);
  } });
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  class MemoryLoader extends Loader { write() {} }
  await ctx.plugin(MemoryLoader, { baseUrl: pathToFileURL(resolve(import.meta.dirname, '..')).href + '/' });
  const url = `http://127.0.0.1:${ctx.webServer.port}`;
  const stateDirectory = join(directory, 'a2a');
  const config = {
    serviceMode: 'external', serviceUrl: 'http://127.0.0.1:36812', agents: ['codex'],
    stateDirectory: join(directory, 'acp'),
    a2a: { token: 'test-token', stateDirectory, publicUrl: url },
  };
  const mount = async override => {
    const id = await ctx.loader.create({ name: './dist/index.js', config: { ...config, ...override } });
    const fiber = ctx.loader.resolve(id).fiber;
    assert.ok(fiber, 'The real Loader must create the plugin fiber');
    return fiber;
  };
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { ctx, url, stateDirectory, config, mount, presets, get adapters() { return adapters; } };
}

test('real Cordis Loader mounts the top-level DSH A2A plugin and disposal removes routes and its storage lock', realDsh, async t => {
  const f = await fixture(t), fiber = await f.mount();
  await fiber.await();
  const response = await fetch(`${f.url}/.well-known/agent-card.json`);
  assert.equal(response.status, 200);
  const card = await response.json();
  assert.equal(card.supportedInterfaces[0].url, `${f.url}/a2a`);
  assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC');
  assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
  assert.equal((await fetch(`${f.url}/a2a`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal(f.presets.has('oneagents-acp-codex'), true); assert.equal(f.adapters, 1);
  await access(join(f.stateDirectory, '.lock'));
  await fiber.dispose();
  assert.equal((await fetch(`${f.url}/.well-known/agent-card.json`)).status, 404);
  assert.equal((await fetch(`${f.url}/a2a`, { method: 'POST' })).status, 404);
  await assert.rejects(access(join(f.stateDirectory, '.lock')), { code: 'ENOENT' });
  assert.equal(f.presets.size, 0); assert.equal(f.adapters, 0);
  const reloaded = await f.mount(); await reloaded.await();
  assert.equal((await fetch(`${f.url}/.well-known/agent-card.json`)).status, 200);
  await reloaded.dispose();
});

test('explicitly disabled A2A mounts no route and needs no token', realDsh, async t => {
  const f = await fixture(t), fiber = await f.mount({ a2a: { enabled: false, stateDirectory: f.stateDirectory } });
  await fiber.await();
  assert.equal((await fetch(`${f.url}/.well-known/agent-card.json`)).status, 404);
  await assert.rejects(access(join(f.stateDirectory, '.lock')), { code: 'ENOENT' });
  await fiber.dispose();
});

test('route registration failure rolls back the A2A store and partial routes before retry', realDsh, async t => {
  const f = await fixture(t);
  const removeCollision = f.ctx.webServer.register({ kind: 'exact', path: '/a2a', handler: (_req, res) => { res.end('external'); } });
  const failed = await f.mount();
  await assert.rejects(failed.await(), /duplicate exact route/);
  assert.equal((await fetch(`${f.url}/.well-known/agent-card.json`)).status, 404);
  assert.equal(await (await fetch(`${f.url}/a2a`)).text(), 'external');
  await assert.rejects(access(join(f.stateDirectory, '.lock')), { code: 'ENOENT' });
  await failed.dispose(); removeCollision();
  const retry = await f.mount(); await retry.await();
  assert.equal((await fetch(`${f.url}/.well-known/agent-card.json`)).status, 200);
  await retry.dispose();
});

test('unloading live A2A cancels active and waiting tasks, drains the real DSH turn, and preserves UI input', realDsh, async t => {
  const loopRequire = createRequire(join(process.env.DSH_SOURCE, 'packages/core/agent-loop/package.json'));
  const loadHost = name => import(pathToFileURL(loopRequire.resolve(name)).href);
  const serviceRequire = createRequire(createRequire(import.meta.url).resolve('@1agents/acp-service/package.json'));
  const loadSdk = name => import(pathToFileURL(serviceRequire.resolve(name)).href);
  const [{ default: LlmRuntime, LlmAdapter, createUserMessage }, { default: Sessions }, { default: Projections },
    { default: SystemPrompt }, { default: Tools }, { default: Agents }, { default: AgentLoop }, { default: WebServer },
    { SendMessageRequest, TaskState }, { ClientFactory }, { ServerCallContext }] = await Promise.all([
    loadHost('@deepseek-ai/dsh-llm'), loadHost('@deepseek-ai/dsh-session'), loadHost('@deepseek-ai/dsh-session-projection'),
    loadHost('@deepseek-ai/dsh-system-prompt'), loadHost('@deepseek-ai/dsh-tools'), loadHost('@deepseek-ai/dsh-agent'),
    loadHost('@deepseek-ai/dsh-agent-loop'),
    import(pathToFileURL(createRequire(join(process.env.DSH_SOURCE, 'packages/client/modules/package.json')).resolve('@deepseek-ai/dsh-host-webserver')).href),
    loadSdk('@a2a-js/sdk'), loadSdk('@a2a-js/sdk/client'), loadSdk('@a2a-js/sdk/server'),
  ]);
  const ctx = new Context(), started = Promise.withResolvers(), directory = await mkdtemp(join(tmpdir(), 'dsh-a2a-live-plugin-'));
  const stateDirectory = join(directory, 'a2a');
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  for (const plugin of [LlmRuntime, Sessions, Projections, SystemPrompt, Tools, Agents]) await ctx.plugin(plugin);
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  let requests = 0;
  class HangingAdapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model }; }
    async *stream(options) {
      requests++; started.resolve();
      await new Promise((resolve, reject) => {
        if (options.signal.aborted) { reject(options.signal.reason); return; }
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
  }
  ctx.llm.registerAdapter(['keyless-live-a2a'], new HangingAdapter());
  ctx.provide('sessionController', {
    create: async request => {
      const sessionId = request.sessionId ?? 'live-a2a-session';
      if (!ctx.agents.get(sessionId)) await ctx.agents.create({ sessionId,
        meta: { cwd: request.cwd }, agentOptions: { provider: 'keyless-live-a2a', model: 'fixture' } });
      return { sessionId };
    },
    inspect: async sessionId => ({ meta: ctx.agents.get(sessionId).session.header, events: [] }),
    resolveAgent: async sessionId => ({ agent: ctx.agents.get(sessionId) }),
    prompt: async request => {
      ctx.agents.get(request.sessionId).followup(createUserMessage({ content: request.content,
        source: { kind: 'user', rpcId: request.requestId } }));
      return { accepted: true };
    },
  });
  const publicUrl = `http://127.0.0.1:${ctx.webServer.port}`;
  const owner = await ctx.plugin({ name: 'live-a2a-server', inject: ['webServer', 'sessionController'], apply: pluginCtx => mountDshA2A(pluginCtx, {
    token: 'live-test-token', publicUrl, stateDirectory, defaultCwd: directory,
  }, stateDirectory) });
  const client = await new ClientFactory().createFromUrl(publicUrl);
  const authenticated = { serviceParameters: { Authorization: 'Bearer live-test-token' } };
  const first = await client.sendMessage(SendMessageRequest.fromJSON({
    message: { messageId: 'live-first', role: 'ROLE_USER', parts: [{ text: 'work' }] },
    configuration: { returnImmediately: true },
  }), authenticated);
  await started.promise;
  const second = await client.sendMessage(SendMessageRequest.fromJSON({
    message: { messageId: 'live-second', role: 'ROLE_USER', contextId: first.contextId, parts: [{ text: 'queued work' }] },
    configuration: { returnImmediately: true },
  }), authenticated);
  const agent = ctx.agents.get('live-a2a-session');
  const uiMessage = createUserMessage({ content: [{ type: 'text', text: 'UI follow-up' }], source: { kind: 'user', rpcId: 'ui-pending' } });
  agent.followup(uiMessage);
  await owner.dispose();
  await agent.whenIdle();
  assert.equal(requests, 1, 'The waiting A2A task must never enter the model');
  assert.deepEqual(agent.inbox.nextTurn.map(message => message.source.rpcId), ['ui-pending']);
  assert.equal(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'aborted');
  assert.equal((await fetch(`${publicUrl}/a2a`, { method: 'POST' })).status, 404);
  const store = new FileA2AStore(stateDirectory);
  try {
    const scope = new ServerCallContext({ user: { isAuthenticated: true, userName: 'dsh-a2a' } });
    assert.equal((await store.taskStore.load(first.id, scope)).status.state, TaskState.TASK_STATE_CANCELED);
    assert.equal((await store.taskStore.load(second.id, scope)).status.state, TaskState.TASK_STATE_CANCELED);
  } finally { store.close(); }
});
