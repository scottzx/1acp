/** Stable execution identity shared by live admission and read-only restart reconciliation. */
import { createHash } from 'node:crypto';

/** Bind one A2A task's user message, independent of transport connections. */
export function a2aRequestId(taskId: string, messageId: string): string {
  return `a2a-${createHash('sha256').update(JSON.stringify([taskId, messageId])).digest('hex')}`;
}
