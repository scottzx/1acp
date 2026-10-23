import { readFile, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { StockBridge, atomicJson } from './bridge.mjs';
import { createWorkbenchAdapter } from './adapter.mjs';

// Stop the dedicated bridge first. Preparation and formal submission are separate phases.
const [configPath, mode, ...keys] = process.argv.slice(2);
if (!['prepare', 'submit'].includes(mode) || !keys.length || keys.some(key => !/^[a-f0-9]{64}$/.test(key))) throw new Error('config prepare|submit original-key... required');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const leasePath = join(config.stateDirectory, 'service.lock'), lease = await open(leasePath, 'wx', 0o600);
try {
  await lease.writeFile(String(process.pid));
  const bridge = await new StockBridge(config, await createWorkbenchAdapter(config)).initialize();
  const receipt = mode === 'prepare' ? await bridge.prepareInterruptedRecovery(keys) : await bridge.submitInterruptedRecovery(keys);
  await atomicJson(join(config.stateDirectory, `interrupted-recovery-${mode}.json`), receipt);
  console.log(JSON.stringify(receipt));
} finally { await lease.close(); await unlink(leasePath); }
