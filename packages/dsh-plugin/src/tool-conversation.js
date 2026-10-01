/** Ordered ACP observations use DSH's native text/reasoning and atomic Tool views. */
const names = { execute: 'Bash', read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move', search: 'Search', fetch: 'Fetch', think: 'Think' };

function contentOf(tool) {
  const content = (tool.content ?? []).flatMap(item => {
    if (item.type === 'content' && item.content.type === 'text') return [item.content];
    if (item.type === 'diff') return [{ type: 'text', text: `${item.path}\n---\n${item.oldText ?? ''}\n+++\n${item.newText}` }];
    return [];
  });
  if (content.length || tool.rawOutput == null) return content;
  return [{ type: 'text', text: typeof tool.rawOutput === 'string' ? tool.rawOutput : JSON.stringify(tool.rawOutput, null, 2) }];
}

function rootOf(state, location) {
  const { tool, requestId, turn, step } = state.data;
  const name = tool.name && tool.name !== 'Tool' ? tool.name : names[tool.kind] ?? tool.title ?? tool.name ?? 'Tool';
  const input = tool.rawInput ?? (tool.locations?.[0]?.path ? { path: tool.locations[0].path } : tool.title ? { description: tool.title } : {});
  const argsRaw = JSON.stringify(input);
  const head = { callId: `${requestId}:${tool.toolCallId}`, name, argsRaw, turn, step, time: state.time, subCalls: [] };
  const settled = tool.status === 'completed' || tool.status === 'failed';
  const closed = location?.kind === 'step' && location.step.status === 'closed' ? location.step.end
    : (location?.kind === 'step' || location?.kind === 'turn') && location.turn.status === 'closed' ? location.turn.end : undefined;
  if (!settled && !closed) return { ...head, phase: 'start' };
  return { kind: 'tool-result', seq: state.seq, time: settled ? state.updatedAt : closed.time,
    callId: head.callId, call: { name, argsRaw }, callTime: state.time, content: contentOf(tool),
    isError: tool.status === 'failed' || !settled,
    ...(!settled ? { error: { name: 'Interrupted', code: 'interrupted' } } : {}), meta: { acp: tool }, subCalls: [] };
}

function records(event) {
  if (event.type === 'assistant/live-chunk') return [{ chunk: event.data.chunk, time: event.time }];
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') return (event.data.stream ?? []).filter(record => record.type === 'chunk');
  return [];
}

function fold(previous, match) {
  const event = match.event;
  // The durable stream replaces its live prefix; deltas must never be appended twice.
  const replay = event.type !== 'assistant/live-chunk';
  const state = { blocks: new Map(replay ? undefined : previous?.blocks), tools: new Map(replay ? undefined : previous?.tools),
    acp: previous?.acp ?? false, seq: previous?.seq ?? event.seq, final: event.type === 'assistant/message' || previous?.final === true };
  for (const { chunk, time } of records(event)) {
    if (chunk.acpStream || chunk.block?.acpTool) state.acp = true;
    const index = chunk.index;
    if (chunk.type === 'block-start' && (chunk.blockType === 'text' || chunk.blockType === 'reasoning')) {
      state.blocks.set(index, { kind: chunk.blockType, text: '' });
    } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      const kind = chunk.type === 'text-delta' ? 'text' : 'reasoning';
      const current = state.blocks.get(index);
      state.blocks.set(index, { kind, text: (current?.kind === kind ? current.text : '') + chunk.text });
    } else if (chunk.type === 'block-end') {
      const data = chunk.block.acpTool;
      if (data) {
        const current = state.tools.get(data.tool.toolCallId);
        state.blocks.delete(index);
        if (current && current.data.sequence >= data.sequence) continue;
        const position = current?.index ?? index;
        state.blocks.set(position, { kind: 'tool', id: data.tool.toolCallId });
        state.tools.set(data.tool.toolCallId, { data, index: position, seq: current?.seq ?? event.seq, time: current?.time ?? time, updatedAt: time });
      } else if (chunk.block.type === 'text' || chunk.block.type === 'reasoning') {
        state.blocks.set(index, { kind: chunk.block.type, text: chunk.block.text });
      }
    }
  }
  return state;
}

/** Adjacent calls share a disclosure; text or reasoning closes that Tool group. */
export function groupParts(parts) {
  const groups = [];
  for (const part of parts) {
    const last = groups.at(-1);
    if (part.kind === 'tool') {
      if (last?.kind === 'tools') last.roots.push(part.root);
      else groups.push({ kind: 'tools', key: part.root.callId, roots: [part.root] });
    } else groups.push(part);
  }
  return groups;
}

export const toolConversationDefinition = {
  kind: 'oneagents-acp-tools', target: 'chat',
  match: event => ['assistant/live-chunk', 'assistant/message', 'assistant/attempt'].includes(event.type)
    ? { id: `${event.data.turn}:${event.data.step}`, role: 'start' } : null,
  start: (_context, match) => fold(undefined, match),
  update: (context, match) => fold(context.state, match),
  publication: () => 'immediate',
  buildViewNode: context => {
    const state = context.state;
    if (!state?.acp) return null;
    const location = context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' };
    const parts = [];
    for (const [index, block] of [...state.blocks].sort(([a], [b]) => a - b)) {
      if (block.kind === 'tool') parts.push({ kind: 'tool', root: rootOf(state.tools.get(block.id), location) });
      else if (block.text.trim()) {
        const last = parts.at(-1);
        if (last?.kind === block.kind) last.text += block.text;
        else parts.push({ ...block, key: String(index) });
      }
    }
    if (!parts.length) return null;
    const status = state.final ? 'settled' : location.kind === 'step' && location.step.status === 'closed' ? 'interrupted' : 'running';
    const turn = context.matches[0].event.data.turn, step = context.matches[0].event.data.step;
    // This is view data only. A response-shaped node lets DSH keep the ordered
    // transcript outside an additional process group; the original message is untouched.
    const text = parts.filter(part => part.kind === 'text').map(part => part.text).join('\n');
    const blocks = [{ kind: 'text', text: text || parts.filter(part => part.kind === 'tool').map(part => part.root.name ?? part.root.call.name).join(', ') || 'ACP' }];
    return { key: context.key, id: context.id, kind: 'assistant-step', target: 'chat', anchorSeq: state.seq,
      location, visibility: 'visible', data: { status, turn, step, blocks, time: context.matches[0].event.time,
        acpTranscript: { groups: groupParts(parts), status } } };
  },
};
