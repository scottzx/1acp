/** Project ACP's log-only observations onto DSH's existing Tool card renderer. */
const EVENT = 'oneagents-acp/tool';
const names = { execute: 'Bash', read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move', search: 'Search', fetch: 'Fetch', think: 'Think' };

function contentOf(tool) {
  if (tool.content?.length) return tool.content.flatMap(item => {
    if (item.type === 'content' && item.content.type === 'text') return [item.content];
    if (item.type === 'diff') return [{ type: 'text', text: `${item.path}\n---\n${item.oldText ?? ''}\n+++\n${item.newText}` }];
    return [];
  });
  if (tool.rawOutput === undefined || tool.rawOutput === null) return [];
  return [{ type: 'text', text: typeof tool.rawOutput === 'string' ? tool.rawOutput : JSON.stringify(tool.rawOutput, null, 2) }];
}

function rootOf(state, location) {
  const { tool, requestId, turn, step } = state.data;
  const name = tool.name && tool.name !== 'Tool' ? tool.name : names[tool.kind] ?? tool.title ?? tool.name ?? 'Tool';
  const argsRaw = JSON.stringify(tool.rawInput ?? {});
  const head = { callId: `${requestId}:${tool.toolCallId}`, name, argsRaw, turn, step, time: state.time, subCalls: [] };
  const settled = tool.status === 'completed' || tool.status === 'failed';
  const closed = location?.kind === 'step' && location.step.status === 'closed' ? location.step.end
    : (location?.kind === 'step' || location?.kind === 'turn') && location.turn.status === 'closed' ? location.turn.end : undefined;
  if (!settled && !closed) return { ...head, phase: 'start' };
  return {
    kind: 'tool-result', seq: state.seq, time: settled ? state.updatedAt : closed.time,
    callId: head.callId, call: { name, argsRaw }, callTime: state.time,
    content: contentOf(tool), isError: tool.status === 'failed' || !settled,
    ...(!settled ? { error: { name: 'Interrupted', code: 'interrupted' } } : {}),
    meta: { acp: tool }, subCalls: [],
  };
}

const fromMatch = match => ({ data: match.event.data, seq: match.event.seq, time: match.event.time, updatedAt: match.event.time });
export const toolConversationDefinition = {
  kind: 'oneagents-acp-tool', target: 'chat',
  // Each observation contains a complete merged snapshot, including after a
  // window cut. A start match also updates an already existing context.
  match: event => event.type === EVENT ? { id: `${event.data.requestId}:${event.data.tool.toolCallId}`, role: 'start' } : null,
  start: (_context, match) => fromMatch(match),
  update: (context, match) => ({ ...context.state, data: match.event.data, updatedAt: match.event.time }),
  publication: () => 'immediate',
  buildViewNode: context => {
    const state = context.state;
    if (!state) return null;
    const location = context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' };
    return { key: context.key, id: context.id, kind: 'tool-call', target: 'chat',
      anchorSeq: state.seq, location, visibility: 'visible', data: { root: rootOf(state, location) } };
  },
};
