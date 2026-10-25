import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { client } from '@agentclientprotocol/sdk';
import { WebSocket, WebSocketServer } from 'ws';
import { createAgentRegistry, createRuntimeStore } from '@1agents/acp-service/runtime';
import { CapacityGovernor } from '../src/capacity.js';

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('ACP startup cancellation did not drain');
    await delay(10);
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

test('SDK cancellation retires session startup without knowing its generated ID', { timeout: 60_000 }, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'acp-startup-cancel-')));
  const capacityDirectory = join(directory, 'capacity');
  const estimate = 256 * 1024 ** 2;
  const settings = { ACP_STATE_DIR: directory, ACP_CAPACITY_DIRECTORY: capacityDirectory,
    ACP_CAPACITY_SOFT_LIMIT: '10000', ACP_CAPACITY_HARD_LIMIT: '10001', ACP_CAPACITY_MEMORY_RESERVE_MB: '0',
    ACP_CAPACITY_INSTANCE_MEMORY_MB: '256' };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const bridge = await import('../src/bridge.js');
  const { attachAcpConnection, webSocketStream } = await import('../src/acp-connection.js');
  const { AcpState } = await import('../src/acp-state.js');
  const options = Reflect.get(bridge.runtime, 'options');
  options.sessionStore = createRuntimeStore({ stateDir: directory });
  options.agentRegistry = createAgentRegistry({ overrides: { codex: [process.execPath,
    fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url))] } });
  const config = { directory: capacityDirectory, softLimit: 10000, hardLimit: 10001, memoryReserveBytes: 0,
    estimatedInstanceBytes: estimate };
  // Reserve enough startup budget to exceed all physical memory. Real bridge
  // admission must wait on memory while its process count remains below soft.
  const governor = new CapacityGovernor({ ...config,
    memoryProvider: () => ({ totalBytes: 1024 ** 5, availableBytes: 1024 ** 5 }) });
  const realGovernor = new CapacityGovernor(config);
  const commands: Array<Record<string, any>> = [];
  const dispatched = new Set<Promise<void>>();
  let statusGate: ReturnType<typeof deferred<Record<string, any>>> | undefined;
  let statusEntered: ReturnType<typeof deferred<void>> | undefined;
  const backend: import('../src/acp-connection.js').RuntimeBackend = {
    sessions: bridge.activeSessions,
    record: id => bridge.readRuntimeRecord(id),
    history: id => bridge.loadSessionHistory(id),
    status: async id => {
      if (statusGate) { statusEntered!.resolve(); return statusGate.promise; }
      return bridge.runtime.getStatus({ handle: bridge.activeSessions.get(id).handle });
    },
    dispatch(peer, command) {
      commands.push(command);
      if (command.action === 'ensure_session') assert.ok(command.initializationSignal instanceof AbortSignal);
      const operation = bridge.dispatchCommand(peer, command);
      dispatched.add(operation);
      void operation.finally(() => dispatched.delete(operation));
      return operation;
    },
  };
  const state = new AcpState(directory);
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => attachAcpConnection(ws, req, backend, state));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/agents/codex`);
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const connection = client().connect(webSocketStream(ws));
  t.after(async () => {
    statusGate?.resolve({ configOptions: [] });
    await bridge.killAllManagedAgents();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  await connection.agent.request('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { '1agents': { version: 1 } } } });
  const { sessionId: savedId } = await connection.agent.request('session/new', { cwd: directory, mcpServers: [] });
  await connection.agent.request('session/close', { sessionId: savedId });
  await until(async () => (await governor.snapshot('process')).used === 0);
  const queued = () => existsSync(join(capacityDirectory, 'queue'))
    ? readdirSync(join(capacityDirectory, 'queue')).filter(name => name.startsWith('entry-')).length : 0;

  for (const method of ['session/new'] as const) {
    await t.test(`${method} cancels a real memory wait before process startup`, async () => {
      const occupied = [];
      try {
        for (let index = 0; index <= Math.ceil(totalmem() / estimate); index++) {
          occupied.push(await governor.acquire({ kind: 'process', source: 'automatic', id: `${method}-${index}` }));
        }
        assert.equal((await realGovernor.snapshot('process')).memory.availableSlots, 0);
        const cancellation = new AbortController();
        const params = { cwd: directory, mcpServers: [], ...(method === 'session/new' ? {} : { sessionId: savedId }),
          _meta: { '1agents': { initializationSignal: { aborted: false, forged: true } } } };
        const request = connection.agent.request(method, params, { cancellationSignal: cancellation.signal });
        const canceled = assert.rejects(request);
        await until(() => queued() === 1);
        const initialization = commands.filter(command => command.action === 'ensure_session').at(-1)!;
        const internalId = initialization.sessionId;
        if (method === 'session/new') assert.notEqual(internalId, savedId);
        cancellation.abort();
        await canceled;
        await until(() => queued() === 0 && dispatched.size === 0);
        assert.equal(bridge.activeSessions.has(internalId), false);
        assert.ok(commands.some(command => command.action === 'close_session' && command.sessionId === internalId));
      } finally { await Promise.all(occupied.map(lease => lease.release())); }
      await delay(800);
      assert.equal((await governor.snapshot('process')).used, 0, 'canceled startup created a late child');
      assert.equal(bridge.activeSessions.size, 0);
    });
  }

  for (const method of ['session/load', 'session/resume'] as const) {
    await t.test(`${method} forwards cancellation while attachment status is pending`, async () => {
      statusGate = deferred<Record<string, any>>(); statusEntered = deferred<void>();
      const cancellation = new AbortController();
      const request = connection.agent.request(method, { cwd: directory, sessionId: savedId, mcpServers: [] },
        { cancellationSignal: cancellation.signal });
      const canceled = assert.rejects(request);
      try {
        await statusEntered.promise;
        const initialization = commands.filter(command => command.action === 'ensure_session').at(-1)!;
        cancellation.abort(); await canceled;
        await until(() => !bridge.activeSessions.has(savedId) && dispatched.size === 0);
        assert.equal(initialization.initializationSignal.aborted, true);
        assert.equal(queued(), 0);
      } finally { statusGate.resolve({ configOptions: [] }); statusGate = undefined; }
    });
  }

  await t.test('cancellation during attachment status closes the already-started child before the read finishes', async () => {
    statusGate = deferred<Record<string, any>>(); statusEntered = deferred<void>();
    const cancellation = new AbortController();
    const request = connection.agent.request('session/new', { cwd: directory, mcpServers: [] }, { cancellationSignal: cancellation.signal });
    const canceled = assert.rejects(request);
    await statusEntered.promise;
    const id = commands.filter(command => command.action === 'ensure_session').at(-1)!.sessionId;
    cancellation.abort(); await canceled;
    await until(() => !bridge.activeSessions.has(id) && dispatched.size === 0);
    await until(async () => (await governor.snapshot('process')).used === 0);
    statusGate.resolve({ configOptions: [] }); statusGate = undefined;
  });

  for (const takeover of [false, true]) {
    await t.test(`canceling a live load preserves the ${takeover ? 'newer owner' : 'original user and turn'}`, async () => {
      const { sessionId } = await connection.agent.request('session/new', { cwd: directory, mcpServers: [] });
      const session = bridge.activeSessions.get(sessionId);
      const handle = session.handle, originalPeer = session.ws;
      let canceledTurns = 0;
      const activeTurn = { cancel: async () => { canceledTurns++; } };
      session.activeTurn = activeTurn;
      const otherWs = new WebSocket(`ws://127.0.0.1:${address.port}/agents/codex`);
      await new Promise<void>((resolve, reject) => { otherWs.once('open', resolve); otherWs.once('error', reject); });
      const other = client().connect(webSocketStream(otherWs));
      await other.agent.request('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { '1agents': { version: 1 } } } });
      const gate = deferred<Record<string, any>>(); statusGate = gate; statusEntered = deferred<void>();
      const cancellation = new AbortController();
      const request = other.agent.request('session/load', { sessionId, cwd: directory, mcpServers: [] },
        { cancellationSignal: cancellation.signal });
      const canceled = assert.rejects(request);
      try {
        await statusEntered.promise;
        statusGate = undefined;
        if (takeover) await connection.agent.request('session/resume', { sessionId, cwd: directory, mcpServers: [] });
        const expectedPeer = takeover ? session.ws : originalPeer;
        cancellation.abort(); await canceled;
        await until(() => dispatched.size === 0 && bridge.activeSessions.get(sessionId)?.ws === expectedPeer);
        assert.equal(bridge.activeSessions.get(sessionId)?.handle, handle);
        assert.equal(bridge.activeSessions.get(sessionId)?.activeTurn, activeTurn);
        assert.equal(canceledTurns, 0);
        assert.equal((await governor.snapshot('process')).used, 1);
        // The original connection remains usable when its interrupted takeover
        // is revoked, and remains usable after a newer successful resume.
        await connection.agent.request('session/close', { sessionId });
      } finally {
        gate.resolve({ configOptions: [] }); statusGate = undefined;
        otherWs.close();
      }
      await until(async () => (await governor.snapshot('process')).used === 0);
    });
  }
});
