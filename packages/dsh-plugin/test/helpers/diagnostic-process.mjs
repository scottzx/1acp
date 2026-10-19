import { identity } from './diagnostics.mjs';
import { openDiagnostics } from '../../dist/diagnostics.js';
import { toSafeError } from '@1agents/acp-service/runtime';
const [root, mode] = process.argv.slice(2);
const owner = await openDiagnostics(root), store = owner.diagnostics;
if (mode === 'read') {
  process.stdout.write(JSON.stringify(store.find('test-session', 'request-1')) + '\n');
  await owner.close();
} else {
  const id = await store.begin(identity());
  if (mode !== 'prepared') await store.submitted(id);
  if (mode === 'confirmed') await store.confirmed(id);
  if (mode === 'failed') await store.settle(id, toSafeError({ codexErrorInfo: 'usageLimitExceeded',
    message: 'SYNTHETIC_SECRET_CANARY_NOT_REAL' }, { origin: 'acp' }));
  process.send({ durable: true, mode });
  // Keep the owning child alive until the parent crashes it after acknowledgement.
  setInterval(() => {}, 1000);
}
