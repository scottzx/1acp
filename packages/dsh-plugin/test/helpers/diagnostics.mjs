import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';
import { Diagnostics } from '../../dist/diagnostics.js';

export async function mountStorage(ctx, root) {
  await ctx.plugin(Storage);
  await ctx.plugin(JsonStorage, { root });
  const domain = await ctx.plugin(StorageDomain, { backend: 'json' });
  await domain.await();
}
export async function diagnosticsFixture(t, root) {
  const ctx = new Context();
  await mountStorage(ctx, root);
  const diagnostics = await Diagnostics.open(ctx.storageDomain);
  t.after(async () => { await diagnostics.close(); await ctx.fiber.dispose(); });
  return { diagnostics, ctx };
}
export const identity = (values = {}) => ({ sessionId: 'test-session', turn: 1, turnStartSeq: 0,
  stepStartSeq: 1, nativeRequestId: 'dsh-' + 'a'.repeat(64), messageIds: ['message-1'], requestIds: ['request-1'], ...values });
