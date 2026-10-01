/** Compose already-registered DSH renderers without copying their implementation. */
import React from 'react';
const h = React.createElement;
const toolKeys = { Bash: 'bash', Read: 'read', Edit: 'edit', Write: 'write', Search: 'search', Fetch: 'web_fetch' };

function ToolGroup({ roots, owner, renderTool, label }) {
  const { expanded, toggle } = owner.useDisclosure();
  return h('div', { 'data-oneagents-acp-tool-group': '', style: { margin: '8px 0' } },
    h('button', { type: 'button', 'aria-expanded': expanded, onClick: toggle,
      style: { border: 0, background: 'transparent', color: 'inherit', opacity: .7, cursor: 'pointer', font: 'inherit', fontSize: 14, padding: '4px 0' } },
      `${expanded ? '⌃' : '⌄'} ${label(roots.length)}`),
    expanded ? h('div', { style: { paddingTop: 6 } }, roots.map(root => renderTool(root, owner))) : null);
}

/** Effect-owned slot replacement; native Session messages and non-ACP renderers stay intact. */
export function installTranscriptView(ctx) {
  ctx.slots.inject('conversation.chat.node', () => {
    const native = [...ctx.slots.entries('conversation.chat.node')].reverse().find(entry => entry.options.key === 'assistant-step');
    if (!native || native.children) throw new Error('DSH native assistant renderer is unavailable');
    const tTool = ctx.locale.bind('conversation');
    const t = ctx.locale.bind('oneagentsAcp');
    const renderTool = (root, owner) => {
      const name = root.name ?? root.call?.name ?? 'Tool';
      const entries = ctx.slots.entries('tool.call.toolview');
      const key = toolKeys[name] ?? name;
      const entry = [...entries].reverse().find(entry => entry.options.key === key && !entry.children)
        ?? entries.find(entry => entry.options.key === 'sleep' && !entry.children);
      if (!entry) throw new Error(`DSH atomic Tool renderer is unavailable for ${name}`);
      return h(entry.component, { ...owner, key: root.callId, callId: root.callId, toolName: key,
        phase: root.phase === 'start' ? 'start' : 'result', block: root,
        home: ctx.remote.$host?.home, inspect: undefined, t: tTool });
    };
    function Assistant(props) {
      const projected = props.useChat?.(snapshot => snapshot?.nodes.values().some(node => node.data.acpTranscript
        && node.data.turn === props.node.data.turn && node.data.step === props.node.data.step));
      const transcript = props.node.data.acpTranscript;
      if (transcript) return h('div', { 'data-oneagents-acp-transcript': '' }, transcript.groups.map(group => {
        if (group.kind === 'tools') return h(ToolGroup, { key: group.key, roots: group.roots, owner: props, renderTool,
          label: count => t('toolGroup').replace('{count}', String(count)) });
        const node = { ...props.node, data: { ...props.node.data, acpTranscript: undefined,
          blocks: [{ kind: group.kind, text: group.text }] } };
        return h(native.component, { ...props, key: group.key, node, groupPart: undefined, turnProcess: undefined });
      }));
      const preset = ctx.sessions.binding(props.sessionId)?.session.projections.faceOf('agentPreset').getSnapshot();
      return projected && typeof preset === 'string' && preset.startsWith('oneagents-acp-')
        ? h('span', { hidden: true, 'data-oneagents-acp-original': '' }) : h(native.component, props);
    }
    // Public keyed replacement retains the original renderer registration. Its
    // locale and presentation Hook are also used for the ACP native components.
    return ctx.slots.register({ name: 'conversation.chat.node', key: 'assistant-step',
      priority: (native.options.priority ?? 0) - 1, locale: native.locale, inject: native.inject }, Assistant);
  });
  ctx.effect(() => {
    const style = document.createElement('style');
    // The ordinary per-Step projection remains available to DSH's timing,
    // navigation and action owners; suppress its now-empty duplicate group.
    style.textContent = '[data-step-process]:has([data-oneagents-acp-original]):not(:has([data-oneagents-acp-transcript])){display:none}';
    document.head.append(style);
    return () => style.remove();
  });
}
