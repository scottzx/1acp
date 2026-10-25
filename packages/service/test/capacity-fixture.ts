import { join } from 'node:path';
import type { CapacityOptions } from '../src/capacity.js';
import { CapacityGovernor } from '../src/capacity.js';
import { createCapacityLifecycle } from '../src/capacity-lifecycle.js';

/** Keep transport/domain regressions independent of device load and other test workers. */
export function testCapacity(root: string): CapacityOptions {
  return { directory: join(root, 'test-capacity'), softLimit: 100, hardLimit: 101,
    memoryReserveBytes: 0, estimatedInstanceBytes: 1,
    memoryProvider: () => ({ totalBytes: 1024, availableBytes: 1024 }) };
}

export function testCapacityLifecycle(root: string) {
  return createCapacityLifecycle(new CapacityGovernor(testCapacity(root)));
}
