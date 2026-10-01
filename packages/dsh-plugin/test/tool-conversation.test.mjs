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
  stdin: { contents: `export { ConversationNodeAssembler } from ${JSON.stringify(resolve(dsh, 'packages/client/ui-conversation/src/client/conversation/assembler.ts'))};`, resolveDir: dsh, loader: 'ts' },
  tsconfig: resolve(dsh, 'tsconfig.base.json'), bundle: true, platform: 'node', format: 'esm', write: false,
});
const directory = mkdtempSync(resolve(tmpdir(), 'acp-dsh-projection-'));
const path = resolve(directory, 'assembler.mjs');
writeFileSync(path, bundle.outputFiles[0].text);
const { ConversationNodeAssembler } = await import(pathToFileURL(path).href);
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
const observation = (seq, tool, requestId = 'turn-1') => row(seq, 'oneagents-acp/tool', { turn: 1, step: 1, requestId, sequence: seq, tool });
const started = { toolCallId: 'exec-1', name: 'Bash', title: 'ls -la', status: 'in_progress', kind: 'execute', rawInput: { command: 'ls -la' } };
const roots = assembler => [...assembler.snapshot('chat').values()].map(node => node.data.root);

test('DSH folds running, sparse updates and terminal observations into one native tool card', () => {
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
  assembler.append(observation(4, started, 'turn-2')); assembler.flush();
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

test('remote observations remain outside the real DSH model message surface', () => {
  const session = Session.create('remote-observations');
  session.append('oneagents-acp/tool', observation(0, started).event.data);
  assert.equal(session.seq, 1);
  assert.deepEqual(session.deriveMessages(), []);
});
