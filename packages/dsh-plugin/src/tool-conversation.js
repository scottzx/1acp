/** Project remote Tool snapshots carried by DSH's existing assistant stream. */
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

function snapshots(event) {
  const fromChunk = (chunk, time) => chunk?.type === 'block-end' && chunk.block?.acpTool
    ? [{ data: chunk.block.acpTool, time }] : [];
  if (event.type === 'assistant/live-chunk') return fromChunk(event.data.chunk, event.time);
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
    return (event.data.stream ?? []).flatMap(record => record.type === 'chunk' ? fromChunk(record.chunk, record.time) : []);
  }
  return [];
}

function fold(previous, match) {
  const tools = new Map(previous?.tools);
  for (const { data, time } of snapshots(match.event)) {
    const current = tools.get(data.tool.toolCallId);
    // Live records and their later durable attempt represent the same stream.
    if (current && current.data.sequence >= data.sequence) continue;
    tools.set(data.tool.toolCallId, { data, seq: current?.seq ?? match.event.seq, time: current?.time ?? time, updatedAt: time });
  }
  return { tools, seq: previous?.seq ?? match.event.seq };
}

export const toolConversationDefinition = {
  kind: 'oneagents-acp-tools', target: 'chat',
  match: event => {
    const first = snapshots(event)[0];
    return first ? { id: first.data.requestId, role: 'start' } : null;
  },
  start: (_context, match) => fold(undefined, match),
  update: (context, match) => fold(context.state, match),
  publication: () => 'immediate',
  buildViewNode: context => {
    const state = context.state;
    if (!state) return null;
    const location = context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' };
    const roots = [...state.tools.values()].map(tool => rootOf(tool, location));
    if (!roots.length) return null;
    // DSH's native Tool kind contributes process activity and an expandable
    // disclosure after reload. Keep one Context per remote stream; additional
    // remote calls are displayed as sibling branches under the first call.
    const [first, ...remaining] = roots;
    return { key: context.key, id: context.id, kind: 'tool-call', target: 'chat',
      // Durable snapshots share the final answer event; anchor them before that
      // answer so DSH retains the completed Turn's process disclosure.
      anchorSeq: location.kind === 'step' ? location.step.start?.seq ?? state.seq : state.seq, location, visibility: 'visible', data: { root: { ...first, subCalls: remaining } } };
  },
};
