import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Session } from '@deepseek-ai/dsh-session';
import { toolConversationDefinition } from '../src/tool-conversation.js';

// Exercise the target DSH engine, not a local imitation of its match lifecycle.
// The development declaration links already identify the matching DSH checkout.
const dsh = resolve(realpathSync(new URL('../node_modules/@deepseek-ai/dsh-agent', import.meta.url)), '../../..');
const bundle = await build({
  stdin: { contents: `export { ConversationNodeAssembler } from ${JSON.stringify(resolve(dsh, 'packages/client/ui-conversation/src/client/conversation/assembler.ts'))}; export { ChatSnapshotBuilder } from ${JSON.stringify(resolve(dsh, 'packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'))}; export { assistantDefinition } from ${JSON.stringify(resolve(dsh, 'packages/client/ui-chat/src/client/conversation-nodes/assistant.ts'))}; export { turnProcessDefinition } from ${JSON.stringify(resolve(dsh, 'packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts'))}; export { validateStoredEvents } from ${JSON.stringify(resolve(dsh, 'packages/session/session-persistence/src/storage-contract.ts'))};`, resolveDir: dsh, loader: 'ts' },
  tsconfig: resolve(dsh, 'tsconfig.base.json'), bundle: true, platform: 'node', target: 'es2022', format: 'esm', write: false,
  plugins: [{ name: 'dsh-built-session', setup(build) { build.onResolve({ filter: /^@deepseek-ai\/dsh-session$/ }, () => ({ path: import.meta.resolve('@deepseek-ai/dsh-session').replace('file://', ''), external: true })); } }],
});
const directory = mkdtempSync(resolve(tmpdir(), 'acp-dsh-projection-'));
const path = resolve(directory, 'assembler.mjs');
writeFileSync(path, bundle.outputFiles[0].text);
const { ConversationNodeAssembler, validateStoredEvents, ChatSnapshotBuilder, assistantDefinition, turnProcessDefinition } = await import(pathToFileURL(path).href);
rmSync(directory, { recursive: true, force: true });

function engine() {
  const events = { entries: () => [toolConversationDefinition], fallbackEntry: () => undefined };
  const views = { entries: () => [{ target: 'chat', create: () => {
    let nodes = new Map();
    return { empty: nodes, replace: value => nodes = new Map(value.nodes.map(node => [node.key, node])),
      apply: ({ upserts }) => { nodes = new Map(nodes); for (const node of upserts) nodes.set(node.key, node); return nodes; } };
  } }] };
  const assembler = new ConversationNodeAssembler(events, views);
  assembler.activateTarget('chat');
  return assembler;
}
const row = (seq, type, data) => ({ type: 'event', event: { seq, time: 1000 + seq, type, data } });
const snapshot = (seq, tool, requestId = 'turn-1') => ({ type: 'block-end', index: seq, block: { type: 'text', text: '', acpTool: { turn: 1, step: 1, requestId, sequence: seq, tool } } });
const observation = (seq, tool, requestId = 'turn-1') => row(seq, 'assistant/live-chunk', { turn: 1, step: 1, chunk: snapshot(seq, tool, requestId) });
const started = { toolCallId: 'exec-1', name: 'Bash', title: 'ls -la', status: 'in_progress', kind: 'execute', rawInput: { command: 'ls -la' } };
const roots = assembler => [...assembler.snapshot('chat').values()].flatMap(node => node.data.acpTranscript.groups.flatMap(group => group.roots ?? []));

test('DSH folds running, sparse updates and terminal observations into one ACP tool card', () => {
  const assembler = engine();
  assembler.replaceWindow([row(0, 'turn/start', { turn: 1 }), row(1, 'step/start', { turn: 1, step: 1 }), observation(2, started)], false);
  assembler.flush();
  assert.equal(roots(assembler)[0].phase, 'start');
  const output = { ...started, status: 'completed', rawOutput: 'README.md' };
  assembler.append(observation(3, output)); assembler.flush();
  assert.equal(roots(assembler).length, 1);
  const root = roots(assembler)[0];
  assert.equal(root.kind, 'tool-result');
  assert.equal(root.call.name, 'Bash');
  assert.equal(root.call.argsRaw, '{"command":"ls -la"}');
  assert.equal(root.content[0].text, 'README.md');
  assert.equal(root.callTime, 1002);
  assert.equal(root.time, 1003);
});

test('DSH restores a cut window from its complete observation and keeps distinct turns separate', () => {
  const assembler = engine();
  assembler.replaceWindow([observation(3, { ...started, status: 'failed', rawOutput: 'Permission denied' })], true);
  assembler.flush();
  assert.equal(roots(assembler)[0].isError, true);
  assert.equal(roots(assembler)[0].call.name, 'Bash');
  const next = observation(4, started, 'turn-2');
  next.event.data.turn = 2; next.event.data.chunk.block.acpTool.turn = 2;
  assembler.append(next); assembler.flush();
  assert.equal(roots(assembler).length, 2);
  assert.notEqual(roots(assembler)[0].callId, roots(assembler)[1].callId);
});

test('DSH closes unfinished remote tool cards when the owning step is interrupted', () => {
  const assembler = engine();
  assembler.replaceWindow([row(0, 'turn/start', { turn: 1 }), row(1, 'step/start', { turn: 1, step: 1 }), observation(2, started)], false);
  assembler.flush();
  assembler.append(row(3, 'step/end', { turn: 1, step: 1 })); assembler.flush();
  const root = roots(assembler)[0];
  assert.equal(root.kind, 'tool-result');
  assert.equal(root.error.code, 'interrupted');
  assert.equal(root.isError, true);
});

test('remote snapshots survive DSH persistence validation and rebuild every ACP card after reload', () => {
  const session = Session.create('remote-observations');
  const chunks = [snapshot(2, started), snapshot(3, { ...started, status: 'completed', rawOutput: 'README.md' }), snapshot(4, { ...started, toolCallId: 'exec-2', status: 'failed', rawOutput: 'Missing' })];
  const stream = chunks.flatMap(chunk => [
    { type: 'chunk', time: 1000 + chunk.index, chunk: { type: 'block-start', index: chunk.index, blockType: 'text' } },
    { type: 'chunk', time: 1000 + chunk.index, chunk },
  ]);
  session.append('assistant/message', {
    turn: 1, step: 1, stream, message: { id: 'remote-answer', role: 'assistant', source: { kind: 'model', provider: '1agents-acp', model: 'codex' }, content: chunks.map(c => c.block) },
  }, { surfaceOp: 'append' });
  const stored = validateStoredEvents(session.header, JSON.parse(JSON.stringify(session.snapshotEvents())));
  const restored = Session.create(session.id, stored, session.header);
  assert.equal(restored.deriveMessages()[0].content.every(block => block.type === 'text' && block.text === ''), true);
  const assembler = engine();
  assembler.replaceWindow(restored.snapshotEvents().map(event => ({ type: 'event', event })), false);
  assembler.flush();
  assert.equal(roots(assembler).length, 2);
  const nodes = [...assembler.snapshot('chat').values()];
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, 'assistant-step');
  assert.equal(roots(assembler).every(root => root.subCalls.length === 0), true);
  assert.equal(roots(assembler)[0].callTime, 1002);
  assert.equal(roots(assembler)[0].content[0].text, 'README.md');
  assert.equal(roots(assembler)[1].isError, true);
});

test('durable attempts do not duplicate tools already seen live and still restore cancelled calls', () => {
  const assembler = engine();
  assembler.replaceWindow([observation(2, started)], false); assembler.flush();
  const chunk = snapshot(3, { ...started, status: 'completed', rawOutput: 'done' });
  assembler.append(observation(3, chunk.block.acpTool.tool)); assembler.flush();
  assembler.append(row(4, 'assistant/attempt', { turn: 1, step: 1, stream: [
    { type: 'chunk', time: 1002, chunk: snapshot(2, started) }, { type: 'chunk', time: 1003, chunk },
  ] })); assembler.flush();
  assert.equal(roots(assembler).length, 1);
  assert.equal(roots(assembler)[0].content[0].text, 'done');
  assert.equal(roots(assembler)[0].callTime, 1002);
});


test('completed persisted ACP transcripts use their own Tool disclosures without an extra process tree', () => {
  const assembler = new ConversationNodeAssembler(
    { entries: () => [toolConversationDefinition, assistantDefinition, turnProcessDefinition], fallbackEntry: () => undefined },
    { entries: () => [{ target: 'chat', create: () => new ChatSnapshotBuilder() }] },
  );
  assembler.activateTarget('chat');
  const message = row(3, 'assistant/message', {
    turn: 1, step: 1,
    stream: [{ type: 'chunk', time: 1002, chunk: snapshot(2, { ...started, status: 'completed' }) }],
    message: { id: 'answer', role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
  });
  message.event.surfaceOp = 'append';
  assembler.replaceWindow([row(0, 'turn/start', { turn: 1 }), row(1, 'step/start', { turn: 1, step: 1 }), message,
    row(4, 'step/end', { turn: 1, step: 1 }), row(5, 'turn/end', { turn: 1 })], false);
  assembler.flush();
  const chat = assembler.snapshot('chat');
  const card = chat.nodes.values().find(node => node.data.acpTranscript);
  const process = chat.nodes.processSource(card.key).getSnapshot();
  assert.equal(process.turnClosed, true);
  assert.equal(process.hasExternalProcess, false);
  assert.equal(card.anchorSeq, process.spec.answerAnchorSeq);
  assert.equal(card.data.acpTranscript.groups[0].roots[0].subCalls.length, 0);
});


test('native prose and thinking retain their order between independently collapsed Tool groups after reload', () => {
  const text = (index, kind, value) => ({ type: 'block-end', index, block: { type: kind, text: value } });
  const stream = [text(0, 'text', 'First commentary'), snapshot(1, { ...started, toolCallId: 'a', status: 'completed' }),
    snapshot(2, { ...started, toolCallId: 'b', status: 'completed' }), text(3, 'reasoning', 'Review results'),
    snapshot(4, { ...started, toolCallId: 'c', status: 'completed' }), text(5, 'text', 'Next commentary'),
    snapshot(6, { ...started, toolCallId: 'd', status: 'completed' }), text(7, 'text', 'Final answer')]
    .map(chunk => ({ type: 'chunk', time: 1000 + chunk.index, chunk }));
  const assembler = engine();
  assembler.replaceWindow([row(10, 'assistant/message', { turn: 1, step: 1, stream })], false); assembler.flush();
  const groups = [...assembler.snapshot('chat').values()][0].data.acpTranscript.groups;
  assert.deepEqual(groups.map(group => group.kind), ['text', 'tools', 'reasoning', 'tools', 'text', 'tools', 'text']);
  assert.deepEqual(groups.filter(group => group.kind === 'tools').map(group => group.roots.length), [2, 1, 1]);
  assert.equal(roots(assembler).every(root => root.subCalls.length === 0), true);
  assert.equal(groups[0].text, 'First commentary');
  assert.equal(groups.at(-1).text, 'Final answer');
});


test('legacy live prose before the first ACP Tool remains in the transcript when updates arrive', () => {
  const assembler = engine();
  assembler.replaceWindow([row(1, 'assistant/live-chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Before Tool' } })], false);
  assembler.flush();
  assert.equal(assembler.snapshot('chat').size, 0);
  assembler.append(observation(2, started)); assembler.flush();
  const groups = [...assembler.snapshot('chat').values()][0].data.acpTranscript.groups;
  assert.equal(groups[0].text, 'Before Tool');
  assert.equal(groups[1].roots.length, 1);
});
