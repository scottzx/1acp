import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import SessionStore from '@deepseek-ai/dsh-session';
import { DshA2ABackend } from '../dist/a2a-executor.js';

async function fixture(t) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'dsh-a2a-executor-')));
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  const agents = new Map(), pending = new Map(), cancels = [], prompts = [];
  const admitted = Promise.withResolvers();
  let activeListeners = 0, createCount = 0, resolveCount = 0, promptBehavior;
  const observe = (...args) => {
    activeListeners++;
    const dispose = ctx.on(...args);
    let disposed = false;
    return () => { if (disposed) return; disposed = true; activeListeners--; dispose(); };
  };
  const event = (agent, type, data) => ctx.emit('session/event', agent.session, { type, data });
  const user = requestId => ({ id: `${requestId}-message`, role: 'user', source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text: requestId }] });
  const insert = (agent, requestId) => {
    const message = user(requestId);
    pending.set(message.id, { agent, message });
    ctx.emit('agent/inbox/inserted', { agent, message });
    return message;
  };
  const makeAgent = session => {
    const agent = {
      id: session.id, session, activeTurn: undefined, ctx: { on: observe },
      inbox: { remove: id => {
        const entry = pending.get(id);
        if (!entry) return false;
        pending.delete(id);
        ctx.emit('agent/inbox/discarded', entry);
        return true;
      } },
      cancel: (cause, options) => {
        cancels.push({ agent, cause, options });
        event(agent, 'turn/end', { turn: agent.activeTurn, reason: { kind: 'aborted', reason: cause } });
        agent.activeTurn = undefined;
      },
    };
    agents.set(agent.id, agent);
    return agent;
  };
  const controller = {
    inspect: async id => {
      const agent = agents.get(id);
      if (!agent) throw new Error(`Session ${id} not found`);
      return { meta: agent.session.header, events: [] };
    },
    create: async request => {
      const existing = request.sessionId && agents.get(request.sessionId);
      if (existing) {
        if (existing.session.header.cwd !== request.cwd) throw new Error('Existing session cwd conflicts');
        if (request.agentPreset !== undefined && existing.session.header.agentPreset !== request.agentPreset) throw new Error('Existing session preset conflicts');
        return { sessionId: existing.id, agentPreset: existing.session.header.agentPreset };
      }
      createCount++;
      const session = ctx.sessions.create(`dsh-a2a-${createCount}`, { meta: { cwd: request.cwd, agentPreset: request.agentPreset ?? 'default-preset' } });
      const agent = makeAgent(session);
      return { sessionId: agent.id, agentPreset: agent.session.header.agentPreset };
    },
    resolveAgent: async id => {
      resolveCount++;
      return agents.has(id) ? { agent: agents.get(id) } : { error: new Error('DSH Agent is unavailable') };
    },
    prompt: async (request, signal) => {
      prompts.push({ request, signal });
      admitted.resolve();
      if (promptBehavior) return promptBehavior(request, signal);
      insert(agents.get(request.sessionId), request.requestId);
      return { accepted: true };
    },
  };
  const host = { sessionController: controller };
  const backend = new DshA2ABackend(host);
  t.after(async () => { await ctx.fiber.dispose(); await rm(cwd, { recursive: true, force: true }); });
  return {
    cwd, backend, ctx, agents, pending, cancels, prompts, controller, admitted,
    get listenerCount() { return activeListeners; },
    get createCount() { return createCount; }, get resolveCount() { return resolveCount; },
    set promptBehavior(value) { promptBehavior = value; },
    user, insert, event,
    claim: (agent, requestId, turn) => {
      const message = user(requestId);
      pending.delete(message.id);
      agent.activeTurn = turn;
      ctx.emit('agent/inbox/claimed', { agent, message, turn });
    },
    output: (agent, turn, text) => event(agent, 'assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text }] } }),
    finish: (agent, turn, reason) => event(agent, 'turn/end', { turn, reason }),
  };
}

test('prepare creates a real DSH Session and adopts its original directory and preset', async t => {
  const f = await fixture(t);
  const created = await f.backend.prepare({ cwd: join(f.cwd, '.'), agentPreset: 'oneagents-acp-codex' });
  assert.deepEqual(created, { sessionId: 'dsh-a2a-1', cwd: f.cwd, agentPreset: 'oneagents-acp-codex' });
  assert.equal(f.agents.get(created.sessionId).session.header.cwd, f.cwd);
  const restored = await f.backend.prepare({ sessionId: created.sessionId });
  assert.deepEqual(restored, created);
  assert.equal(f.createCount, 1);
  assert.equal(f.resolveCount, 2);
  await assert.rejects(f.backend.prepare({ sessionId: created.sessionId, agentPreset: 'other' }), /preset conflicts/);
  await assert.rejects(f.backend.prepare({ sessionId: created.sessionId, cwd: tmpdir() }), /cwd conflicts/);
});

test('prepare rejects missing sessions and invalid remote directories before creating a session', async t => {
  const f = await fixture(t);
  const file = join(f.cwd, 'file.txt'); await writeFile(file, 'text');
  await assert.rejects(f.backend.prepare({ cwd: 'relative' }), /absolute directory/);
  await assert.rejects(f.backend.prepare({ cwd: file }), /point to a directory/);
  await assert.rejects(f.backend.prepare({ cwd: join(f.cwd, 'missing') }), /ENOENT/);
  await assert.rejects(f.backend.prepare({ sessionId: 'missing-session' }), /not found/);
  assert.equal(f.createCount, 0);
});

test('run follows only its claimed turn and returns the final assistant text without waiting for later UI work', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId), signal = new AbortController();
  const result = f.backend.run(target, 'A2A task', { requestId: 'task-1', signal: signal.signal });
  await f.admitted.promise;
  f.claim(agent, 'ui-request', 1); f.output(agent, 1, 'Unrelated output'); f.finish(agent, 1, { kind: 'completed' });
  f.claim(agent, 'task-1', 2); f.output(agent, 2, 'Thinking'); f.output(agent, 2, 'Final answer');
  f.finish(agent, 2, { kind: 'completed' });
  f.claim(agent, 'later-ui-request', 3);
  signal.abort();
  assert.deepEqual(await result, { outcome: 'completed', text: 'Final answer' });
  assert.equal(f.cancels.length, 0);
  assert.equal(f.listenerCount, 0);
  assert.equal(f.prompts[0].request.mode, 'queue');
  assert.equal(f.prompts[0].request.content[0].text, 'A2A task');
});

for (const [reason, outcome, detail] of [
  [{ kind: 'blocked' }, 'input-required', /blocked/],
  [{ kind: 'error', error: { message: 'Provider failed', code: 'UNKNOWN' } }, 'failed', /Provider failed/],
  [{ kind: 'max-tokens' }, 'failed', /token limit/],
  [{ kind: 'interrupted' }, 'failed', /interrupted/],
]) {
  test(`run reports DSH ${reason.kind} from its exact turn`, async t => {
    const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
    const agent = f.agents.get(target.sessionId);
    const result = f.backend.run(target, 'task', { requestId: 'task', signal: new AbortController().signal });
    await f.admitted.promise;
    f.claim(agent, 'task', 5); f.finish(agent, 5, reason);
    const value = await result;
    assert.equal(value.outcome, outcome); assert.match(value.detail, detail);
    assert.equal(f.listenerCount, 0);
  });
}

test('canceling queued A2A work removes only its inbox item and leaves the active UI turn running', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId), abort = new AbortController();
  f.insert(agent, 'ui-pending'); agent.activeTurn = 10;
  const result = f.backend.run(target, 'task', { requestId: 'task', signal: abort.signal });
  await f.admitted.promise; abort.abort();
  assert.equal((await result).outcome, 'failed');
  assert.equal(f.pending.has('task-message'), false);
  assert.equal(f.pending.has('ui-pending-message'), true);
  assert.equal(agent.activeTurn, 10); assert.equal(f.cancels.length, 0);
  assert.equal(f.listenerCount, 0);
});

test('canceling the claimed A2A turn preserves other pending prompts', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId), abort = new AbortController();
  const result = f.backend.run(target, 'task', { requestId: 'task', signal: abort.signal });
  await f.admitted.promise;
  f.claim(agent, 'task', 20); f.insert(agent, 'ui-pending'); abort.abort();
  assert.equal((await result).outcome, 'failed');
  assert.equal(f.cancels.length, 1);
  assert.deepEqual(f.cancels[0].options, { keepInbox: true });
  assert.equal(f.pending.has('ui-pending-message'), true);
  assert.equal(f.listenerCount, 0);
});

test('cancellation during async prompt admission removes the late task without canceling an unrelated turn', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId), abort = new AbortController(), release = Promise.withResolvers();
  f.promptBehavior = async request => { await release.promise; f.insert(agent, request.requestId); return { accepted: true }; };
  agent.activeTurn = 4;
  const result = f.backend.run(target, 'task', { requestId: 'task', signal: abort.signal });
  await f.admitted.promise; abort.abort(); release.resolve();
  assert.equal((await result).outcome, 'failed');
  assert.equal(f.pending.size, 0); assert.equal(f.cancels.length, 0);
  assert.equal(f.listenerCount, 0);
});

test('two A2A tasks on one session are admitted in order and receive their separate turn results', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId);
  const first = f.backend.run(target, 'first', { requestId: 'first', signal: new AbortController().signal });
  const second = f.backend.run(target, 'second', { requestId: 'second', signal: new AbortController().signal });
  await f.admitted.promise;
  assert.deepEqual(f.prompts.map(value => value.request.requestId), ['first']);
  f.claim(agent, 'first', 1); f.output(agent, 1, 'First answer'); f.finish(agent, 1, { kind: 'completed' });
  assert.equal((await first).text, 'First answer');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.prompts.map(value => value.request.requestId), ['first', 'second']);
  f.claim(agent, 'second', 2); f.output(agent, 2, 'Second answer'); f.finish(agent, 2, { kind: 'completed' });
  assert.equal((await second).text, 'Second answer');
  assert.equal(f.listenerCount, 0);
});

test('canceling an A2A task waiting behind another run returns immediately without touching that run', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
  const agent = f.agents.get(target.sessionId), abort = new AbortController();
  const first = f.backend.run(target, 'first', { requestId: 'first', signal: new AbortController().signal });
  const second = f.backend.run(target, 'second', { requestId: 'second', signal: abort.signal });
  await f.admitted.promise; f.claim(agent, 'first', 1); abort.abort();
  await assert.rejects(second, { name: 'AbortError' });
  assert.equal(f.cancels.length, 0);
  assert.equal(f.prompts.length, 1);
  f.output(agent, 1, 'First answer'); f.finish(agent, 1, { kind: 'completed' });
  assert.equal((await first).text, 'First answer');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.prompts.length, 1);
  assert.equal(f.listenerCount, 0);
});

test('prompt rejection, Agent disposal, and pre-admission cancellation release every listener', async t => {
  const f = await fixture(t), target = await f.backend.prepare({ cwd: f.cwd });
  f.promptBehavior = async () => { throw new Error('Admission failed'); };
  await assert.rejects(f.backend.run(target, 'task', { requestId: 'failed', signal: new AbortController().signal }), /Admission failed/);
  assert.equal(f.listenerCount, 0);
  f.promptBehavior = undefined;
  const result = f.backend.run(target, 'task', { requestId: 'disposed', signal: new AbortController().signal });
  await new Promise(resolve => setImmediate(resolve));
  f.ctx.emit('agent/disposed', { agent: f.agents.get(target.sessionId) });
  assert.match((await result).detail, /disposed/);
  assert.equal(f.listenerCount, 0);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.backend.run(target, 'task', { requestId: 'canceled', signal: abort.signal }), { name: 'AbortError' });
  assert.equal(f.listenerCount, 0);
});

test('real DSH registry and agent-loop emit completed and canceled A2A turns without an API key', {
  skip: process.env.DSH_SOURCE ? false : 'Set DSH_SOURCE to a built matching DSH checkout for the real loop smoke test',
  timeout: 10000,
}, async t => {
  const requireHost = createRequire(join(process.env.DSH_SOURCE, 'packages/core/agent-loop/package.json'));
  const load = name => import(pathToFileURL(requireHost.resolve(name)).href);
  const [{ default: LlmRuntime, LlmAdapter, createUserMessage }, { default: SessionProjections },
    { default: SystemPrompt }, { default: Tools }, { default: Agents }, { default: AgentLoop }] = await Promise.all([
    load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-session-projection'), load('@deepseek-ai/dsh-system-prompt'),
    load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-agent-loop'),
  ]);
  const ctx = new Context(), started = Promise.withResolvers(), requests = [];
  let notifyHang = () => started.resolve();
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'dsh-a2a-real-loop-')));
  t.after(async () => { await ctx.fiber.dispose(); await rm(cwd, { recursive: true, force: true }); });
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections, SystemPrompt, Tools, Agents]) await ctx.plugin(plugin);
  await ctx.plugin(AgentLoop, { agents: [] });
  class KeylessAdapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model }; }
    async *stream(options) {
      requests.push(options);
      const user = options.messages.findLast(message => message.role === 'user');
      const text = user.content.filter(part => part.type === 'text').map(part => part.text).join('');
      if (text.startsWith('hang')) {
        notifyHang();
        await new Promise((resolve, reject) => {
          if (options.signal.aborted) { reject(options.signal.reason); return; }
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
        return;
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: `Completed ${text}` };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `Completed ${text}` } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['keyless-a2a'], new KeylessAdapter());
  let nextId = 0;
  ctx.provide('sessionController', {
    create: async request => {
      const sessionId = request.sessionId ?? `real-dsh-a2a-${++nextId}`;
      if (!ctx.agents.get(sessionId)) await ctx.agents.create({
        sessionId, meta: { cwd: request.cwd }, agentOptions: { provider: 'keyless-a2a', model: 'fixture' },
      });
      return { sessionId };
    },
    inspect: async sessionId => ({ meta: ctx.agents.get(sessionId).session.header, events: [] }),
    resolveAgent: async sessionId => ({ agent: ctx.agents.get(sessionId) }),
    prompt: async request => {
      ctx.agents.get(request.sessionId).followup(createUserMessage({
        content: request.content, source: { kind: 'user', rpcId: request.requestId },
      }));
      return { accepted: true };
    },
  });
  const backend = new DshA2ABackend(ctx), target = await backend.prepare({ cwd });
  assert.deepEqual(await backend.run(target, 'real task', { requestId: 'real-task', signal: new AbortController().signal }), {
    outcome: 'completed', text: 'Completed real task',
  });
  assert.deepEqual(await backend.prepare({ sessionId: target.sessionId }), target);
  const abort = new AbortController();
  const canceled = backend.run(target, 'hang', { requestId: 'real-cancel', signal: abort.signal });
  await started.promise; abort.abort();
  assert.equal((await canceled).outcome, 'failed');
  await ctx.agents.get(target.sessionId).whenIdle();
  const events = ctx.agents.get(target.sessionId).session.snapshotEvents();
  assert.deepEqual(events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind), ['completed', 'aborted']);
  assert.deepEqual(events.filter(event => event.type === 'user/message').map(event => event.data.source.rpcId), ['real-task', 'real-cancel']);
  assert.equal(requests.length, 2);

  const unloadingStarted = Promise.withResolvers();
  notifyHang = () => unloadingStarted.resolve();
  let unloadTask;
  const owner = await ctx.plugin({
    name: 'a2a-execution-owner',
    apply: pluginCtx => {
      const ownBackend = new DshA2ABackend(pluginCtx), abort = new AbortController();
      pluginCtx.effect(() => async () => { abort.abort(); await unloadTask; });
      unloadTask = ownBackend.run(target, 'hang-unload', { requestId: 'real-unload', signal: abort.signal });
    },
  });
  await unloadingStarted.promise;
  await owner.dispose();
  assert.equal((await unloadTask).outcome, 'failed');
  await ctx.agents.get(target.sessionId).whenIdle();
  assert.equal(ctx.agents.get(target.sessionId).session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'aborted');
  assert.equal(requests.length, 3);
});
