/** Native-session admission shared by DSH plugins. Reading history remains the caller's responsibility. */
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-session-persistence';
import { AcpAdapter, type Config } from './adapter.js';
import { discoverPresets } from './discovery.js';
import { State } from './state.js';

/** Whether a provider is enabled and advertised by the configured service. */
export interface ImportAvailability { available: boolean; agent?: string; reason?: string }
/** Original native identity, workspace and the reader’s ordered historical events. */
export interface NativeSessionInput {
  provider: string;
  nativeSessionId: string;
  cwd: string;
  /** Current DSH events, contiguous from sequence zero. */
  events: readonly SessionEvent[];
}
/** Completed restoration and workspace attachment, safe for client navigation. */
export interface ImportResult {
  success: true;
  dshSessionId: SessionId;
  workspace: string;
  workspaceId: string;
  agent: string;
  continuation: 'native';
}
declare module '@deepseek-ai/cordis' {
  interface Context { oneagentsAcpSessions: NativeSessions }
}
const providers: Readonly<Record<string, string>> = { claude: 'claude', codex: 'codex', grok: 'grok-build' };

/** Owns import identities and serializes retries through remote import, local creation and workspace attachment. */
export class NativeSessions {
  private readonly state: State;
  private readonly pending = new Map<string, Promise<ImportResult>>();
  private disposed = false;
  constructor(private readonly ctx: Context, private readonly adapter: AcpAdapter, private readonly config: Config) {
    this.state = new State(config.stateDirectory);
  }
  /** Check configured Agent availability without starting or restoring a native session.
   * @param provider Reader provider identifier.
   * @returns Availability, registry Agent and an actionable failure reason when unavailable.
   */
  async availability(provider: string): Promise<ImportAvailability> {
    const agent = Object.hasOwn(providers, provider) ? providers[provider] : undefined;
    if (!agent) return { available: false, reason: `暂不支持 ${provider} 原会话续聊，可继续只读查看` };
    if (this.disposed || !this.config.agents.includes(agent)) return { available: false, agent, reason: `ACP 未启用 ${agent}` };
    try {
      const agents = await discoverPresets(this.config.serviceUrl);
      return agents.some(value => value.id === agent)
        ? { available: true, agent }
        : { available: false, agent, reason: `${agent} 尚未就绪，请检查安装和 ACP 配置` };
    } catch (error) {
      return { available: false, agent, reason: `ACP 服务不可用：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  /** Restore one native session; repeated calls return its existing DSH identity and never replace its history.
   * @param input Native identity, original workspace and historical events.
   * @returns The attached DSH session after native restoration succeeds.
   */
  async importSession(input: NativeSessionInput): Promise<ImportResult> {
    if (this.disposed) throw new Error('ACP plugin has been stopped');
    const identity = JSON.stringify([new URL(this.config.serviceUrl).href, input.provider, input.nativeSessionId]);
    const id = `session-acp-${createHash('sha256').update(identity).digest('hex')}` as SessionId;
    const previous = this.pending.get(id);
    if (previous) {
      await previous;
      // Re-check this caller's cwd even when it raced another import.
      return this.importSession(input);
    }
    const operation = this.admit(id, input);
    this.pending.set(id, operation);
    try { return await operation; }
    finally { if (this.pending.get(id) === operation) this.pending.delete(id); }
  }
  /** Stop new admissions and await callers already creating or attaching a session. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled(this.pending.values());
  }
  private async admit(id: SessionId, input: NativeSessionInput): Promise<ImportResult> {
    const available = await this.availability(input.provider);
    if (!available.available || !available.agent) throw new Error(available.reason);
    if (!input.nativeSessionId.trim()) throw new Error('Native session ID is required');
    if (!isAbsolute(input.cwd)) throw new Error('原会话缺少绝对工作目录，无法续聊');
    let cwd: string;
    try {
      cwd = await realpath(input.cwd);
      if (!(await stat(cwd)).isDirectory()) throw new Error('Not a directory');
    } catch (error) { throw new Error(`原会话工作目录不可用：${input.cwd}`, { cause: error }); }
    const agent = available.agent;
    const preset = `oneagents-acp-${agent}`;
    const endpoint = new URL(`/agents/${encodeURIComponent(agent)}`, this.config.serviceUrl);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    let binding = this.state.get(id);
    if (binding && (binding.cwd !== cwd || binding.agent !== agent || binding.endpoint !== endpoint.href
      || binding.imported?.provider !== input.provider || binding.imported.nativeSessionId !== input.nativeSessionId)) {
      throw new Error('Imported session binding does not match the native session or workspace');
    }
    const existing = await this.ctx.sessionPersistence.stat(id);
    const live = this.ctx.agents.get(id);
    const header = live?.session.header ?? existing?.header;
    if (header && (!binding || header.cwd !== cwd || header.agentPreset !== preset)) throw new Error('DSH session identity is already in use');
    if (!header) {
      // Use DSH's validation before contacting the native Agent. No session is published here.
      this.ctx.sessions.prepare(id, { seed: input.events, meta: { cwd, agentPreset: preset } });
      await this.ctx.agentPresets.resolve(preset);
    }
    if (!binding) {
      binding = { ...await this.adapter.importNative(agent, cwd, input.nativeSessionId), imported: {
        provider: input.provider, nativeSessionId: input.nativeSessionId, messageIds: [],
      } };
      // The service ID survives local creation/attachment failure and plugin restart.
      this.state.save(id, binding);
    }
    if (!header) {
      binding.imported!.messageIds = input.events.flatMap(event => event.type === 'user/message' ? [event.data.id] : []);
      this.state.save(id, binding);
      await this.ctx.agents.create({
        sessionId: id, seed: input.events,
        meta: { cwd, agentPreset: preset },
        agentOptions: { provider: '1agents-acp', model: agent },
        setup: async scope => { await this.ctx.agentPresets.mount(scope, preset); },
      });
    }
    const resolved = await this.ctx.sessionController.resolveAgent(id);
    if ('error' in resolved) throw resolved.error;
    await this.adapter.describe(resolved.agent);
    const workspace = await this.ctx.workspaceRegistry.create(cwd);
    await workspace.attachSession(id);
    return { success: true, dshSessionId: id, workspace: cwd, workspaceId: workspace.id, agent, continuation: 'native' };
  }
}
