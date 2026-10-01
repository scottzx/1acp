/** Remote tool observations are log-only: they never become local tool requests. */
import type { SessionUpdate } from '@agentclientprotocol/sdk';

export const TOOL_EVENT = 'oneagents-acp/tool';
type ToolUpdate = Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>;
export interface RemoteTool {
  toolCallId: string;
  title?: string | null;
  name?: string;
  status?: ToolUpdate['status'];
  kind?: ToolUpdate['kind'];
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolUpdate['content'];
  locations?: ToolUpdate['locations'];
}
export interface ToolEvent {
  turn: number;
  step: number;
  requestId: string;
  sequence: number;
  tool: RemoteTool;
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'oneagents-acp/tool': ToolEvent;
  }
}

/** ACP updates replace supplied fields and leave omitted fields intact. */
export function mergeTool(previous: RemoteTool | undefined, update: ToolUpdate): RemoteTool {
  const tool: RemoteTool = { ...previous, toolCallId: update.toolCallId };
  for (const key of ['title', 'status', 'kind', 'rawInput', 'rawOutput', 'content', 'locations'] as const) {
    if (update[key] !== undefined && (update[key] !== null || key === 'rawInput' || key === 'rawOutput')) Object.assign(tool, { [key]: update[key] });
  }
  // The service's friendly name is display metadata, separate from ACP's title.
  const name = (update._meta?.['1agents'] as { toolName?: string } | undefined)?.toolName;
  if (name && (name !== 'Tool' || !tool.name)) tool.name = name;
  return tool;
}
