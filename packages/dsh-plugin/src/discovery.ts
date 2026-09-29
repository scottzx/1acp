/** Service-owned harness inventory; the plugin never probes its own host or maintains a harness list. */
import { object } from './transport.js';
export async function discoverPresets(serviceUrl: string): Promise<Array<{ id: string; label: string }>> {
  const response = await fetch(new URL('/agents', serviceUrl), { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`ACP discovery failed: HTTP ${response.status}`);
  const body = object(await response.json());
  if (!Array.isArray(body.agents)) throw new Error('ACP discovery requires an agents array');
  const agents = new Map<string, { id: string; label: string }>();
  for (const value of body.agents) {
    const agent = object(value);
    if (typeof agent.id !== 'string' || !/^[a-z0-9_-]+$/i.test(agent.id) || typeof agent.label !== 'string' || typeof agent.chat_ready !== 'boolean') {
      throw new Error('Invalid ACP discovery entry');
    }
    if (agent.chat_ready) agents.set(agent.id, { id: agent.id, label: agent.label });
  }
  return [...agents.values()];
}
