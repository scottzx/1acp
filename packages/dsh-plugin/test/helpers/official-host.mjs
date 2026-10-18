/** Keyless test host uses official DSH services and the real Loader; only the session-controller fixture delegates directly to Agents. */
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { mountStorage } from './diagnostics.mjs';
export async function officialHost(directory, serviceUrl, onTurnEnd) {
  const requireHost = createRequire(join(process.env.DSH_SOURCE, 'packages/core/agent-loop/package.json'));
  const requireRetry = createRequire(join(process.env.DSH_SOURCE, 'packages/llm/llm-retry/package.json'));
  const load = name => import(pathToFileURL(requireHost.resolve(name)).href);
  const [{ default: Llm }, { default: Sessions, Session }, { default: Projections }, { default: SystemPrompt },
    { default: Tools }, { default: Agents }, { default: AgentLoop }, LlmRetry, { agentPresetProjectionDefinition }] = await Promise.all([
    load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-session'), load('@deepseek-ai/dsh-session-projection'),
    load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-agent'),
    load('@deepseek-ai/dsh-agent-loop'), import(pathToFileURL(requireRetry.resolve('@deepseek-ai/dsh-llm-retry')).href), import('@deepseek-ai/dsh-agent-preset-registry'),
  ]);
  const clientRequire = createRequire(join(process.env.DSH_SOURCE, 'packages/client/modules/package.json'));
  const [{ default: Loader }, { default: WebServer }] = await Promise.all([
    import(pathToFileURL(clientRequire.resolve('@deepseek-ai/cordis-plugin-loader')).href),
    import(pathToFileURL(clientRequire.resolve('@deepseek-ai/dsh-host-webserver')).href),
  ]);
  const persistenceRequire = createRequire(join(process.env.DSH_SOURCE, 'packages/session/session-persistence-jsonl/package.json'));
  const { default: JsonlPersistence } = await import(pathToFileURL(persistenceRequire.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href);
  const ctx = new Context();
  await mountStorage(ctx, join(directory, 'diagnostics'));
  const logs = [], stateDirectory = join(directory, 'a2a');

  for (const plugin of [Llm, Sessions, Projections, SystemPrompt, Tools, Agents]) await ctx.plugin(plugin);
  ctx.sessionProjections.register(agentPresetProjectionDefinition);
  await ctx.plugin(JsonlPersistence, { root: join(directory, 'sessions'), compression: 'none' });
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(LlmRetry, {});
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  for (const name of ['approval', 'userQuestions', 'workspaceRegistry']) ctx.provide(name, {});
  ctx.provide('commands', { register: () => () => {} });
  ctx.provide('agentPresets', { register: async () => () => {} });
  let nextSession = 0;
  // The controller fixture delegates task creation and input to actual Agents;
  // the error path, native process, host loop, transport and task store are real.
  ctx.provide('sessionController', {
    create: async request => {
      const sessionId = request.sessionId ?? `synthetic-pipeline-session-${++nextSession}`;
      if (!ctx.agents.get(sessionId)) try { await ctx.agents.create({ sessionId,
        meta: { cwd: request.cwd, agentPreset: 'oneagents-acp-codex' },
        agentOptions: { provider: '1agents-acp', model: 'codex' } }); }
      catch (error) { throw error; }
      return { sessionId };
    },
    inspect: async id => ({ meta: ctx.agents.get(id).session.header, events: [] }),
    resolveAgent: async id => ({ agent: ctx.agents.get(id) }),
    prompt: async request => {
      const { createUserMessage } = await load('@deepseek-ai/dsh-llm');
      ctx.agents.get(request.sessionId).followup(createUserMessage({ content: request.content,
        source: { kind: 'user', rpcId: request.requestId } }));
      return { accepted: true };
    },
  });
  if (onTurnEnd) ctx.on('session/event', (session, event) => { if (event.type === 'turn/end') onTurnEnd(session, event); });
  class MemoryLoader extends Loader { write() {} }
  await ctx.plugin(MemoryLoader, { baseUrl: pathToFileURL(resolve(import.meta.dirname, '../..')).href + '/' });
  const url = `http://127.0.0.1:${ctx.webServer.port}`;
  const id = await ctx.loader.create({ name: './dist/index.js', config: {
    serviceMode: 'external', serviceUrl: serviceUrl, agents: ['codex'],
    stateDirectory: join(directory, 'adapter'), reconnectAttempts: 0,
    a2a: { token: 'synthetic-test-token', publicUrl: url, stateDirectory, defaultCwd: directory },
  } });
  const fiber = ctx.loader.resolve(id).fiber; await fiber.await();
  return { ctx, fiber, url, stateDirectory, Session, close: () => ctx.fiber.dispose() };
}
