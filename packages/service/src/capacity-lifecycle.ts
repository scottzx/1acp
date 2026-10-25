/** Bind runtime launch admission to durable device capacity reservations. */
import type { AcpProcessLifecycle } from '@1agents/acp-service/runtime';
import type { CapacityGovernor, CapacityLease, CapacitySource } from './capacity.js';

interface LaunchReservation {
  lease: Promise<CapacityLease>;
  releasing?: Promise<void>;
}

/** The runtime owns child termination; capacity remains reserved until its exit is observed. */
export function createCapacityLifecycle(
  governor: Pick<CapacityGovernor, 'acquire'>,
  source: CapacitySource = 'automatic',
): AcpProcessLifecycle {
  const reservations = new Map<string, LaunchReservation>();

  const release = (launchId: string): Promise<void> => {
    const entry = reservations.get(launchId);
    if (!entry) return Promise.resolve();
    if (entry.releasing) return entry.releasing;
    const operation = (async () => {
      try {
        const lease = await entry.lease;
        await lease.release();
        if (reservations.get(launchId) === entry) reservations.delete(launchId);
      } catch {
        // Retain the entry and durable reservation so a later observation can retry.
        console.warn('ACP capacity reservation cleanup failed; the reservation remains recorded.');
      } finally {
        entry.releasing = undefined;
      }
    })();
    entry.releasing = operation;
    return operation;
  };

  return {
    async onBeforeSpawn(launch) {
      if (reservations.has(launch.launchId)) throw new Error('ACP process launch already has a capacity reservation');
      // Install the entry before awaiting admission so concurrent duplicate callbacks cannot leak a slot.
      const entry: LaunchReservation = {
        lease: Promise.resolve().then(() => governor.acquire({ kind: 'process', source, id: launch.launchId })),
      };
      reservations.set(launch.launchId, entry);
      try { await entry.lease; }
      catch (error) {
        if (reservations.get(launch.launchId) === entry) reservations.delete(launch.launchId);
        throw error;
      }
    },
    async onSpawned(process) {
      const entry = reservations.get(process.launchId);
      if (!entry) throw new Error('ACP process launch has no capacity reservation');
      const lease = await entry.lease;
      // Propagate registration failures: the runtime then stops the child and reports its exit.
      await lease.spawned(process.pid);
    },
    onSpawnFailed: failure => release(failure.launchId),
    onExit: exit => release(exit.launchId),
  };
}
