/** Browser controls for native ACP configuration and ordinary DSH models. */
import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react';
import { toolConversationDefinition } from './tool-conversation.js';

export const inject = ['slots', 'sessions', 'commandUi', 'remote', 'remote.session', 'locale', 'uiConversation'];

const dictionaries = {
  zh: { toolRunning: '执行中', toolFailed: '失败', toolCompleted: '已完成', toolNoOutput: '无输出', model: '模型', choose: '选择模型', loading: '正在连接 Agent…', retry: '重试', mode: '模式', command: 'Agent 指令', effort: '思考强度', unsupported: 'Agent 未提供可切换的模型', description: '选择当前 Agent 的模型', error: '连接失败', noCommands: 'Agent 尚未提供指令', native: 'ACP 设置' },
  en: { toolRunning: 'Running', toolFailed: 'Failed', toolCompleted: 'Completed', toolNoOutput: 'No output', model: 'Model', choose: 'Select model', loading: 'Connecting to Agent…', retry: 'Retry', mode: 'Mode', command: 'Agent commands', effort: 'Reasoning effort', unsupported: 'This Agent does not advertise model selection', description: 'Select this Agent’s model', error: 'Connection failed', noCommands: 'No commands advertised', native: 'ACP settings' },
};

/** Preserve Agent-owned group labels and option ids. */
export function choices(option) {
  return (option.options ?? []).flatMap(item => 'group' in item
    ? item.options.map(value => ({ ...value, group: item.name ?? item.group }))
    : [item]);
}

async function acpRequest(sessionId, change) {
  const response = await fetch(`/api/1agents-acp/session?id=${encodeURIComponent(sessionId)}`, {
    ...(change ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) } : {}),
    credentials: 'same-origin',
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

const selectStyle = { maxWidth: 210, minHeight: 30, borderRadius: 7, border: '1px solid var(--dsw-alias-border-l1, #8885)', color: 'inherit', background: 'var(--dsw-alias-bg-base, transparent)', padding: '3px 7px', fontSize: 12 };

function Select({ title, value, rows, disabled, onSelect, placeholder }) {
  return h('label', { style: { display: 'inline-flex', gap: 5, alignItems: 'center', fontSize: 12 } },
    h('span', null, title),
    h('select', { 'aria-label': title, style: selectStyle, value: value ?? '', disabled, onChange: e => onSelect(e.target.value) },
      h('option', { value: '', disabled: true }, placeholder || title),
      rows.map(row => h('option', { key: row.value, value: row.value, title: row.description }, `${row.group ? `${row.group} · ` : ''}${row.name}`))));
}

/** Remote cards use public chat slots; remote calls have no local inspector. */
export function AcpTools({ node, t }) {
  return h('div', { 'data-oneagents-acp-tools': '', style: { display: 'grid', gap: 6 } }, node.data.roots.map(root => {
    const running = root.phase === 'start';
    const tool = running ? root : root.call;
    const output = running ? [] : root.content;
    const acp = root.meta?.acp;
    let args;
    try { args = JSON.parse(tool.argsRaw); } catch { args = tool.argsRaw; }
    const input = args?.command ?? args?.path ?? args?.file_path ?? acp?.title ?? tool.argsRaw;
    const state = running ? 'running' : root.isError ? 'failed' : 'completed';
    const labels = { running: t('toolRunning'), failed: t('toolFailed'), completed: t('toolCompleted'), noOutput: t('toolNoOutput') };
    return h('details', { key: root.callId, 'data-acp-call': root.callId, 'data-acp-status': state,
      style: { border: '1px solid var(--dsw-alias-border-l1, #8883)', borderRadius: 8, padding: '7px 10px' } },
      h('summary', { style: { cursor: 'pointer', fontSize: 13 } },
        h('strong', null, tool.name), ' ', h('span', { style: { opacity: .65 } }, labels[state]),
        h('code', { style: { display: 'block', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 4 } }, typeof input === 'string' ? input : JSON.stringify(input))),
      h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflow: 'auto', fontSize: 12 } },
        output.length ? output.map(block => block.text ?? '').join('\n') : running ? labels.running : labels.noOutput));
  }));
}

export function apply(ctx) {
  ctx.uiConversation.events.register(toolConversationDefinition);
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'oneagents-acp-tools',
    locale: 'oneagentsAcp',
  }, AcpTools));
  ctx.effect(() => ctx.locale.register('oneagentsAcp', dictionaries));
  const t = ctx.locale.bind('oneagentsAcp');
  const native = new Map();
  const pending = new Map();
  const listeners = new Map();
  const presetOf = id => ctx.sessions.binding(id)?.session.projections.faceOf('agentPreset').getSnapshot();
  const isAcp = id => String(presetOf(id) ?? '').startsWith('oneagents-acp-');
  const publish = (id, value) => { native.set(id, value); for (const fn of listeners.get(id) ?? []) fn(); };
  const load = id => {
    if (!pending.has(id)) {
      const operation = acpRequest(id).then(value => { publish(id, value); return value; }).finally(() => pending.delete(id));
      pending.set(id, operation);
    }
    return pending.get(id);
  };
  const configure = async (id, configId, value) => { const updated = await acpRequest(id, { configId, value }); publish(id, updated); };
  const reset = () => { native.clear(); for (const set of listeners.values()) for (const fn of set) fn(); };
  ctx.remote.$on('agent-preset/selected', reset);
  ctx.on('connection/reset', reset);

  function ModelControls({ sessionId, locked }) {
    const binding = ctx.sessions.binding(sessionId);
    const preset = binding.session.projections.faceOf('agentPreset');
    const selection = binding.session.projections.faceOf('modelSelection');
    const presetId = useSyncExternalStore(fn => preset.subscribe(fn), () => preset.getSnapshot());
    const projected = useSyncExternalStore(fn => selection.subscribe(fn), () => selection.getSnapshot());
    const capabilities = useSyncExternalStore(fn => {
      let set = listeners.get(sessionId);
      if (!set) listeners.set(sessionId, set = new Set());
      set.add(fn); return () => { set.delete(fn); };
    }, () => native.get(sessionId));
    const external = String(presetId ?? '').startsWith('oneagents-acp-');
    const [catalog, setCatalog] = useState(null);
    const [error, setError] = useState('');
    const [loadError, setLoadError] = useState('');
    const [busy, setBusy] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const refresh = async () => {
      try {
        if (external) await load(sessionId);
        else {
          const result = await ctx.remote.session.modelCatalog();
          if (!result.ok) throw new Error(result.error.message);
          setCatalog(result.value);
        }
        setLoadError('');
      } catch (error) { setLoadError(String(error.message ?? error)); }
    };
    useEffect(() => { void refresh(); }, [sessionId, presetId]);
    // Configuration updates can arrive while the remote Agent is working.
    useEffect(() => {
      if (!external) return;
      const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 5000);
      return () => clearInterval(timer);
    }, [external, sessionId, presetId]);
    const change = async action => { setBusy(true); setError(''); try { await action(); } catch (error) { setError(String(error.message ?? error)); } finally { setBusy(false); } };
    const disabled = locked || busy;
    const controls = [];
    if (external && capabilities) {
      const configs = capabilities.configOptions.filter(option => option.type === 'select');
      const model = configs.find(option => option.category === 'model' || option.id === 'model');
      if (model) controls.push(h(Select, { key: model.id, title: model.name || t('model'), value: model.currentValue, rows: choices(model), disabled, onSelect: value => change(() => configure(sessionId, model.id, value)) }));
      else controls.push(h('span', { key: 'unsupported', title: t('unsupported'), style: { fontSize: 12 } }, `ACP · ${capabilities.agent}`));
      const additional = configs.filter(option => option !== model && !(capabilities.modes && (option.category === 'mode' || option.id === 'mode')));
      if (additional.length || capabilities.modes) controls.push(h('button', { key: 'settings', type: 'button', style: selectStyle, onClick: () => setExpanded(!expanded), 'aria-expanded': expanded }, t('native')));
      if (expanded) {
        for (const option of additional) controls.push(h(Select, { key: option.id, title: option.name, value: option.currentValue, rows: choices(option), disabled, onSelect: value => change(() => configure(sessionId, option.id, value)) }));
        if (capabilities.modes) controls.push(h(Select, { key: 'mode', title: t('mode'), value: capabilities.modes.currentModeId, rows: capabilities.modes.availableModes.map(m => ({ value: m.id, name: m.name, description: m.description })), disabled, onSelect: value => change(() => configure(sessionId, '$mode', value)) }));
      }
    } else if (!external && catalog) {
      const current = projected?.next ?? catalog.default;
      const rows = catalog.groups.flatMap(group => group.models.map(model => ({ value: JSON.stringify([group.id, model.id]), name: model.name, group: group.name })));
      const select = async (provider, model, reasoningEffort) => {
        const result = await ctx.remote.session.selectModel({ sessionId, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) });
        if (!result.ok) throw new Error(result.error.message);
      };
      controls.push(h(Select, { key: 'dsh-model', title: t('model'), value: current?.provider === '1agents-acp' ? '' : JSON.stringify([current?.provider, current?.model]), rows, disabled, placeholder: t('choose'), onSelect: value => change(() => select(...JSON.parse(value))) }));
      const model = catalog.groups.find(g => g.id === current?.provider)?.models.find(m => m.id === current?.model);
      if (model?.reasoning) controls.push(h(Select, { key: 'effort', title: t('effort'), value: current.reasoningEffort ?? model.reasoning.defaultEffort, rows: model.reasoning.efforts.map(e => ({ value: e.id, name: e.name })), disabled, onSelect: value => change(() => select(current.provider, current.model, value)) }));
    } else if (!error && !loadError) controls.push(h('span', { key: 'loading', style: { fontSize: 12 } }, t('loading')));
    if (error || loadError) controls.push(h('span', { key: 'error', role: 'alert', style: { color: '#c64b45', fontSize: 12, maxWidth: 360 } }, error || loadError, ' ', h('button', { type: 'button', onClick: () => { setError(''); void refresh(); } }, t('retry'))));
    return h('div', { 'data-oneagents-acp-controls': external ? 'acp' : 'dsh', style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 } }, controls);
  }

  ctx.slots.inject('conversation.input.model', () => ctx.slots.register({ name: 'conversation.input.model', inject: sessionId => ({ sessionId }) }, ModelControls));
  ctx.effect(() => ctx.commandUi.register({
    name: 'model', description: () => t('description'),
    available: session => ctx.sessions.subagentAddress(session.sessionId) === undefined,
    ui: {
      kind: 'popupSelect',
      options: async ({ sessionId }) => {
        if (isAcp(sessionId)) {
          const capabilities = await load(sessionId);
          const model = capabilities?.configOptions.find(option => option.category === 'model' || option.id === 'model');
          if (!model) throw new Error(t('unsupported'));
          return choices(model).map(option => ({ id: JSON.stringify([model.id, option.value]), label: option.name, detail: option.description, active: option.value === model.currentValue }));
        }
        const response = await ctx.remote.session.modelCatalog();
        if (!response.ok) throw new Error(response.error.message);
        return response.value.groups.flatMap(group => group.models.map(model => ({ id: JSON.stringify([group.id, model.id]), label: model.name, detail: group.name })));
      },
      onSelect: async (option, { sessionId }) => {
        const [key, value] = JSON.parse(option.id);
        if (isAcp(sessionId)) await configure(sessionId, key, value);
        else { const result = await ctx.remote.session.selectModel({ sessionId, provider: key, model: value }); if (!result.ok) throw new Error(result.error.message); }
      },
    },
  }));
}
