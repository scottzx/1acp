import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServiceAgentRegistry, discoverAgents, findAgentBinary, type DiscoveryOptions } from '../src/catalog.js';

function fixture(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'acp-discovery-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const options: DiscoveryOptions = { home, env: { PATH: join(home, 'bin') }, packageRoots: [home], platform: 'linux' };
  const executable = (relative: string, contents = '#!/bin/sh\n') => {
    const file = join(home, relative); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, contents, { mode: 0o755 }); return file;
  };
  return { home, options, executable, scan: () => new Map(discoverAgents(options).map(agent => [agent.id, agent])) };
}

test('discovers native harnesses in PATH and user directories without mistaking runners for harnesses', t => {
  const f = fixture(t);
  f.executable('bin/npx'); f.executable('bin/uvx');
  assert.ok([...f.scan().values()].every(agent => !agent.chat_ready));
  const grok = f.executable('.grok/bin/grok');
  f.executable('.local/bin/claude');
  f.executable('bin/agy');
  const statuses = f.scan();
  assert.equal(statuses.get('grok-build')?.path, grok);
  assert.deepEqual(createServiceAgentRegistry(f.options).resolve('grok-build'), [grok, 'agent', 'stdio']);
  assert.equal(statuses.get('grok-build')?.chat_ready, true);
  assert.equal(statuses.get('claude')?.type, 'claudecode');
  assert.equal(statuses.get('claude')?.chat_ready, true);
  assert.equal(statuses.get('antigravity')?.installed, true);
  assert.equal(statuses.get('antigravity')?.chat_ready, false);
  chmodSync(grok, 0o644);
  assert.equal(f.scan().get('grok-build')?.chat_ready, false);
});

test('installed adapter is ready without native CLI, but missing package entry is not', t => {
  const f = fixture(t);
  const folder = join(f.home, 'node_modules/@agentclientprotocol/codex-acp');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: '@agentclientprotocol/codex-acp', bin: { 'codex-acp': 'cli.js' } }));
  assert.equal(f.scan().get('codex')?.chat_ready, false);
  writeFileSync(join(folder, 'cli.js'), '#!/usr/bin/env node\n');
  assert.deepEqual(createServiceAgentRegistry(f.options).resolve('codex'), [process.execPath, join(folder, 'cli.js')]);
  assert.equal(f.scan().get('codex')?.installed, false);
  assert.equal(f.scan().get('codex')?.chat_ready, true);
});

test('native ACP discovery checks the launch binary, not only a display CLI alias', t => {
  const f = fixture(t);
  f.executable('bin/agent');
  assert.equal(f.scan().get('cursor')?.installed, true);
  assert.equal(f.scan().get('cursor')?.chat_ready, false);
  f.executable('bin/cursor-agent');
  assert.equal(f.scan().get('cursor')?.chat_ready, true);
});

test('Windows lookup handles PATHEXT and PATH separators', t => {
  const f = fixture(t);
  const target = f.executable('bin/gemini.CMD');
  assert.equal(findAgentBinary('gemini', { ...f.options, platform: 'win32', env: { PATH: `${f.home}/missing;${f.home}/bin`, PATHEXT: '.EXE;.CMD' } }), target);
});

test('service launch registry preserves unknown commands and runtime aliases', () => {
  const registry = createServiceAgentRegistry();
  assert.deepEqual(registry.resolve('claudecode'), registry.resolve('claude'));
  assert.equal(registry.resolve('custom-harness'), 'custom-harness');
});


test('adapter fallback launches the npx found outside PATH without advertising absent harnesses', t => {
  const f = fixture(t);
  const runner = f.executable('.local/bin/npx');
  assert.equal(f.scan().get('codex')?.chat_ready, false);
  f.executable('.local/bin/codex');
  assert.equal(f.scan().get('codex')?.chat_ready, true);
  const command = createServiceAgentRegistry(f.options).resolve('codex');
  assert.ok(Array.isArray(command));
  assert.equal(command[0], runner);
  assert.ok(command.some(value => value.startsWith('@agentclientprotocol/codex-acp')));
});
