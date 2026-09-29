/** Installable Cordis bundle. Uses only existing Host services and preset registrations. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { AcpAdapter, type Config } from './adapter.js';
export const name = 'oneagents-acp';
export const inject = ['llm', 'agents', 'approval', 'userQuestions', 'commands', 'sessionProjections', 'webServer', 'sessionController', 'agentPresets'];
export async function apply(ctx: Context, input: Partial<Config> = {}): Promise<void> {
  const homePath = ctx.get('dshHomePath') as ((...parts: string[]) => string) | undefined;
  const home = homePath ? homePath() : process.env.DSH_HOME || join(homedir(), '.dsh');
  const config: Config = {
    serviceUrl: input.serviceUrl ?? 'http://127.0.0.1:36812', agents: input.agents ?? ['codex', 'grok-build'],
    stateDirectory: input.stateDirectory ?? join(home, 'plugins', '1agents-acp', 'sessions'),
    reconnectAttempts: input.reconnectAttempts ?? 5, reconnectDelayMs: input.reconnectDelayMs ?? 1000,
  };
  const url = new URL(config.serviceUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('serviceUrl must use http or https');
  if (!config.agents.length || config.agents.some(a => !/^[a-z0-9_-]+$/i.test(a))) throw new Error('agents must contain ACP registry names');
  if (!Number.isSafeInteger(config.reconnectAttempts) || config.reconnectAttempts < 0 || !Number.isSafeInteger(config.reconnectDelayMs) || config.reconnectDelayMs < 1) throw new Error('Invalid ACP reconnect policy');
  const adapter = new AcpAdapter(ctx, config);
  ctx.effect(() => ctx.llm.registerAdapter(['1agents-acp'], adapter));
  ctx.effect(() => () => adapter.dispose());
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api/1agents-acp', handler: async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname !== '/api/1agents-acp/session' || !['GET', 'POST'].includes(req.method!)) { res.statusCode = 404; res.end('{}'); return; }
      const id = url.searchParams.get('id');
      if (!id || id.length > 256) throw new Error('Session id required');
      const resolved = await ctx.sessionController.resolveAgent(id as SessionId);
      if ('error' in resolved) throw resolved.error;
      const agent = resolved.agent;
      if (req.method === 'GET') { res.end(JSON.stringify(await adapter.describe(agent))); return; }
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new Error('Cross-origin configuration is not allowed');
      let body = '';
      for await (const chunk of req) { body += String(chunk); if (body.length > 16384) throw new Error('Request body too large'); }
      const value = JSON.parse(body);
      if (typeof value.configId !== 'string' || typeof value.value !== 'string') throw new Error('configId and value must be strings');
      res.end(JSON.stringify(await adapter.configure(agent, value.configId, value.value)));
    } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
  } }));
  for (const agent of config.agents) {
    const dispose = await ctx.agentPresets.register({
      id: `oneagents-acp-${agent}`,
      name: `ACP · ${agent === 'grok-build' ? 'Grok' : agent === 'codex' ? 'Codex' : agent}`,
      description: `当前会话直接连接 ${agent}；切换 Agent 请新建会话。`,
      order: 20,
      plugins: [
        { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '', complete: true, includeRuntimeContext: false } },
        { id: 'acp-session', name: '@1agents/dsh-acp/preset', config: { agent } },
      ],
    });
    ctx.effect(() => dispose);
  }
}
