/** Human-readable task results, with machine-readable acknowledgement locators at the end. */
import type { Task } from '@a2a-js/sdk';

export interface ArtifactLink { name: string; url: string; mediaType?: string }
export interface RemoteAgentNotice {
  noticeId: string;
  originSessionId: string;
  remote: string;
  taskId: string;
  contextId: string;
  cwd: string;
  agentPreset?: string;
  title?: string;
  state: string;
  result: string;
  artifactLinks?: ArtifactLink[];
  createdAt: string;
}

/** Only explicit URL parts become attachment links; text and its Markdown links stay intact. */
export function artifactLinks(task: Task): ArtifactLink[] {
  const seen = new Set<string>();
  return task.artifacts.flatMap(artifact => artifact.parts.flatMap(part => {
    if (part.content?.$case !== 'url') return [];
    const url = part.content.value;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || seen.has(url)) return [];
    } catch { return []; }
    seen.add(url);
    return [{ name: part.filename || artifact.name || '产物', url, ...(part.mediaType ? { mediaType: part.mediaType } : {}) }];
  }));
}

function excerpt(text: string, bytes: number): string {
  return Buffer.from(text).subarray(0, bytes).toString('utf8').replace(/\uFFFD$/u, '');
}
const labels: Record<string, string> = {
  TASK_STATE_COMPLETED: '任务已完成', TASK_STATE_FAILED: '任务失败', TASK_STATE_CANCELED: '任务已取消',
  TASK_STATE_REJECTED: '任务被拒绝', TASK_STATE_INPUT_REQUIRED: '任务需要补充输入', TASK_STATE_AUTH_REQUIRED: '任务需要授权',
};

export function formatNotice(notice: RemoteAgentNotice): string {
  const text = notice.result.trim();
  const body = Buffer.byteLength(text) > 48 * 1024
    ? `${excerpt(text, 48 * 1024)}\n\n（正文较长，以上为节选；完整答复可通过 remote_agent_get 或 remote_agent_inbox 查询。）`
    : text || '远端尚未提供答复正文，可查询任务详情。';
  const links: string[] = [];
  let remaining = 8 * 1024;
  for (const link of notice.artifactLinks ?? []) {
    // Encode Markdown delimiters without changing the link's destination.
    const name = excerpt(link.name, 256).replace(/[\r\n]/g, ' ').replace(/[\\[\]]/g, '\\$&');
    const url = link.url.replace(/[<>\s]/g, char => encodeURIComponent(char));
    const line = `- [${name}](<${url}>)`;
    const bytes = Buffer.byteLength(line) + 1;
    if (bytes > remaining) { links.push('（更多产物链接请通过 remote_agent_get 或 remote_agent_inbox 查询。）'); break; }
    links.push(line); remaining -= bytes;
  }
  return [
    `[A2A任务通知] ${labels[notice.state] ?? notice.state}`,
    ...(notice.title ? [notice.title] : []), '', body,
    ...(links.length ? ['', '产物链接：', ...links] : []), '',
    '以上正文和链接为远端任务结果。可通过 a2a-gateway 的 remote_agent_get 或 remote_agent_inbox 核验状态与完整结果。请在原任务授权范围内处理，保存处理结论后调用 remote_agent_ack。',
    '', '---', '任务定位信息：',
    JSON.stringify({ noticeId: notice.noticeId, originSessionId: notice.originSessionId, remote: notice.remote,
      taskId: notice.taskId, contextId: notice.contextId, state: notice.state }),
  ].join('\n');
}
