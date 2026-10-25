import test from 'node:test';
import assert from 'node:assert/strict';
import type { AcpProcessExit, AcpProcessLaunch, AcpProcessStarted } from '@1agents/acp-service/runtime';
import { createCapacityLifecycle } from '../src/capacity-lifecycle.js';
import type { CapacityLease, CapacityRequest } from '../src/capacity.js';

const launch = (launchId: string): AcpProcessLaunch => ({
  launchId, scope: { kind: 'runtime-session', sessionKey: `session-${launchId}` },
  command: 'test-agent', args: [], cwd: process.cwd(),
});
const started = (launchId: string, pid = 123): AcpProcessStarted => ({
  ...launch(launchId), pid, startedAt: '2026-10-23T00:00:00.000Z',
});
const exited = (launchId: string, pid = 123): AcpProcessExit => ({
  ...started(launchId, pid), exitCode: 0, signal: null, exitedAt: '2026-10-23T00:00:01.000Z',
});
const failed = (launchId: string) => ({
  ...launch(launchId), error: new Error('spawn failed'), failedAt: '2026-10-23T00:00:01.000Z',
});

function stubGovernor() {
  const requests: CapacityRequest[] = [];
  const pids = new Map<string, number[]>();
  const releases = new Map<string, number>();
  return {
    requests, pids, releases,
    async acquire(request: CapacityRequest): Promise<CapacityLease> {
      requests.push(request);
      return {
        async recheck() {},
        async spawned(pid) { pids.set(request.id, [...(pids.get(request.id) ?? []), pid]); },
        async release() { releases.set(request.id, (releases.get(request.id) ?? 0) + 1); },
      };
    },
  };
}

test('capacity denial rejects before launch and does not register or release a process', async () => {
  const denial = new Error('capacity full');
  let acquisitions = 0;
  const lifecycle = createCapacityLifecycle({ async acquire() { acquisitions++; throw denial; } });
  await assert.rejects(Promise.resolve(lifecycle.onBeforeSpawn!(launch('denied'))), error => error === denial);
  await lifecycle.onSpawnFailed!(failed('denied'));
  await lifecycle.onExit!(exited('denied'));
  assert.equal(acquisitions, 1);
  // Rejection removes only the failed attempt's in-memory entry.
  await assert.rejects(Promise.resolve(lifecycle.onBeforeSpawn!(launch('denied'))), error => error === denial);
  assert.equal(acquisitions, 2);
});

test('spawn admission reserves automatic process capacity and binds the child PID', async () => {
  const governor = stubGovernor();
  const lifecycle = createCapacityLifecycle(governor);
  await lifecycle.onBeforeSpawn!(launch('one'));
  await lifecycle.onSpawned!(started('one', 456));
  assert.deepEqual(governor.requests, [{ kind: 'process', source: 'automatic', id: 'one' }]);
  assert.deepEqual(governor.pids.get('one'), [456]);
  assert.equal(governor.releases.size, 0);
});

test('interactive source is forwarded and failure or exit releases a launch only once', async () => {
  const governor = stubGovernor();
  const lifecycle = createCapacityLifecycle(governor, 'interactive');
  await lifecycle.onBeforeSpawn!(launch('failure'));
  await Promise.all([
    lifecycle.onSpawnFailed!(failed('failure')),
    lifecycle.onExit!(exited('failure')),
  ]);
  await lifecycle.onSpawnFailed!(failed('failure'));
  await lifecycle.onExit!(exited('failure'));
  assert.equal(governor.requests[0]?.source, 'interactive');
  assert.equal(governor.releases.get('failure'), 1);

  await lifecycle.onBeforeSpawn!(launch('exit'));
  await lifecycle.onSpawned!(started('exit'));
  await lifecycle.onExit!(exited('exit'));
  await lifecycle.onExit!(exited('exit'));
  assert.equal(governor.releases.get('exit'), 1);
});

test('interleaved launch identities retain independent leases', async () => {
  const governor = stubGovernor();
  const lifecycle = createCapacityLifecycle(governor);
  await Promise.all(['one', 'two'].map(id => lifecycle.onBeforeSpawn!(launch(id))));
  await lifecycle.onSpawned!(started('two', 222));
  await lifecycle.onSpawnFailed!(failed('one'));
  assert.equal(governor.releases.get('one'), 1);
  assert.equal(governor.releases.get('two'), undefined);
  await assert.rejects(Promise.resolve(lifecycle.onSpawned!(started('one'))), /has no capacity reservation/);
  await lifecycle.onExit!(exited('two', 222));
  assert.deepEqual(governor.pids.get('two'), [222]);
  assert.equal(governor.releases.get('two'), 1);
});

test('duplicate before callbacks cannot acquire two reservations while admission is pending', async () => {
  let allow!: (lease: CapacityLease) => void;
  let acquisitions = 0;
  const pending = new Promise<CapacityLease>(resolve => { allow = resolve; });
  const lifecycle = createCapacityLifecycle({ acquire() { acquisitions++; return pending; } });
  const first = lifecycle.onBeforeSpawn!(launch('one'));
  await assert.rejects(Promise.resolve(lifecycle.onBeforeSpawn!(launch('one'))), /already has a capacity reservation/);
  allow({ async recheck() {}, async spawned() {}, async release() {} });
  await first;
  assert.equal(acquisitions, 1);
  await lifecycle.onExit!(exited('one'));
});

test('PID registration failure propagates and retains the reservation until exit', async () => {
  const failure = new Error('registration failed');
  let releases = 0;
  const lifecycle = createCapacityLifecycle({ async acquire() {
    return { async recheck() {}, async spawned() { throw failure; }, async release() { releases++; } };
  } });
  await lifecycle.onBeforeSpawn!(launch('one'));
  await assert.rejects(Promise.resolve(lifecycle.onSpawned!(started('one'))), error => error === failure);
  assert.equal(releases, 0);
  await lifecycle.onExit!(exited('one'));
  assert.equal(releases, 1);
});

test('cleanup write failures are observed safely and preserve the lease for retry', async t => {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const unhandled: unknown[] = [];
  const observeUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', observeUnhandled);
  let attempts = 0;
  let ledgerRecorded = true;
  const lifecycle = createCapacityLifecycle({ async acquire() {
    return {
      async recheck() {},
      async spawned() {},
      async release() {
        if (++attempts === 1) throw new Error('private ledger path and credentials');
        ledgerRecorded = false;
      },
    };
  } });
  try {
    await lifecycle.onBeforeSpawn!(launch('one'));
    // Match runtime best-effort observation: the returned promise is intentionally not awaited.
    lifecycle.onSpawnFailed!(failed('one'));
    await new Promise<void>(resolve => { setImmediate(resolve); });
    assert.equal(ledgerRecorded, true);
    assert.equal(attempts, 1);
    assert.deepEqual(warnings, [['ACP capacity reservation cleanup failed; the reservation remains recorded.']]);
    assert.deepEqual(unhandled, []);
    await lifecycle.onExit!(exited('one'));
    assert.equal(ledgerRecorded, false);
    assert.equal(attempts, 2);
    await lifecycle.onExit!(exited('one'));
    assert.equal(attempts, 2);
  } finally { process.off('unhandledRejection', observeUnhandled); }
});
