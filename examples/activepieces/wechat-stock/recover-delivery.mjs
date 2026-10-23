import { readFile, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { StockBridge } from './bridge.mjs';
import { createWorkbenchAdapter } from './adapter.mjs';

// Stop only the dedicated bridge before using this local maintenance command.
// Its exclusive service lease prevents a second writer; no scheduling or submit.
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const key = process.argv[3];
if (!/^[a-f0-9]{64}$/.test(key ?? '')) throw new Error('Original operation key required');
const leasePath = join(config.stateDirectory, 'service.lock');
const lease = await open(leasePath, 'wx', 0o600);
try {
  await lease.writeFile(String(process.pid));
  const adapter = await createWorkbenchAdapter(config);
  const bridge = await new StockBridge(config, adapter).initialize();
  console.log(JSON.stringify(await bridge.recoverDelivery(key)));
} finally { await lease.close(); await unlink(leasePath); }
