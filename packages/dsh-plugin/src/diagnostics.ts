/** Plugin-owned ACP diagnostics; official DSH session events remain unchanged. */
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';
import { randomUUID } from 'node:crypto';
import { z } from 'dsh-zod';
import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { DirectoryLease } from '@1agents/acp-service/a2a';
import { toSafeError, type SafeError } from '@1agents/acp-service/runtime';

const identitySchema = z.object({
  sessionId: z.string().min(1), turn: z.number().int().nonnegative(),
  turnStartSeq: z.number().int().nonnegative(), stepStartSeq: z.number().int().nonnegative(),
  nativeRequestId: z.string().regex(/^dsh-[a-f0-9]{64}$/),
  messageIds: z.array(z.string().min(1)).min(1), requestIds: z.array(z.string().min(1)),
}).strict();
const errorSchema = z.object({
  category: z.enum(['quota', 'rate_limit', 'budget', 'auth', 'cancelled', 'timeout', 'permission', 'unknown']),
  providerCode: z.enum(['usageLimitExceeded', 'quota_exhausted', 'insufficient_quota', 'rateLimitExceeded',
    'rate_limited', 'rate_limit_exceeded', 'sessionBudgetExceeded', 'budget_exhausted', 'unauthorized',
    'auth_required', 'authentication_required']).optional(),
  retryable: z.boolean(), outcomeUnknown: z.boolean(),
  code: z.string().max(128).optional(), detailCode: z.string().max(128).optional(),
  origin: z.enum(['cli', 'runtime', 'queue', 'acp', 'service', 'transport', 'dsh', 'a2a']),
}).strict().refine(value => {
  const safe = toSafeError(value, { trustedProjection: true });
  return safe.code === value.code && safe.detailCode === value.detailCode;
});
const recordSchema = z.object({
  id: z.string().uuid(), serial: z.number().int().positive(), identity: identitySchema,
  phase: z.enum(['prepared', 'submitted', 'confirmed', 'settled']),
  error: errorSchema.optional(),
}).strict().refine(value => value.phase === 'settled' || value.phase === 'confirmed' || value.error === undefined);
const spec = defineDomain({ name: 'oneagents_acp_diagnostics', version: 1,
  tables: { attempts: domainTable<string, z.infer<typeof recordSchema>>(recordSchema) } });
export type DiagnosticIdentity = z.infer<typeof identitySchema>;

/** Shared by the owned Adapter and A2A backend; every mutating method awaits durability. */
export class Diagnostics {
  private serial = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private constructor(private readonly domain: Domain<typeof spec>) {
    const serials = new Set<number>();
    for (const [key, record] of domain.table('attempts').entries()) {
      if (record.id !== key || serials.has(record.serial)) throw new Error('Invalid ACP diagnostic identity');
      serials.add(record.serial); this.serial = Math.max(this.serial, record.serial);
    }
  }
  /** Open the plugin's schema-validated domain using the configured official storage facility. */
  static async open(facility: DomainFacility): Promise<Diagnostics> {
    let domain: Domain<typeof spec>;
    try { domain = await facility.open(spec); } catch { throw new Error('ACP diagnostic storage could not be opened; check its configuration and version.'); }
    try { return new Diagnostics(domain); }
    catch { await domain.close(); throw new Error('Invalid ACP diagnostic storage identity.'); }
  }
  private write<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('ACP diagnostics are closed'));
    const next = this.chain.then(action); this.chain = next.catch(() => {}); return next;
  }
  /** Persist admission before starting a native delivery attempt. */
  begin(identity: DiagnosticIdentity): Promise<string> {
    const snapshot = identitySchema.parse(identity);
    return this.write(async () => {
      const serial = this.serial + 1;
      if (!Number.isSafeInteger(serial)) throw new Error('ACP diagnostic sequence exhausted');
      const id = randomUUID();
      await this.domain.table('attempts').put(id, { id, serial, identity: snapshot, phase: 'prepared' });
      this.serial = serial; return id;
    });
  }
  /** Mark a conservative delivery attempt, before asking the cooperative SDK to send. */
  submitted(id: string): Promise<void> {
    return this.write(async () => {
      await this.domain.table('attempts').update(id, record => {
        if (record.phase !== 'prepared' && record.phase !== 'submitted') throw new Error('ACP diagnostic attempt already confirmed');
        return { ...record, phase: 'submitted' };
      });
    });
  }
  /** Persist a received terminal reply before allowing host output or cancellation to settle. */
  confirmed(id: string): Promise<void> {
    return this.write(async () => {
      await this.domain.table('attempts').update(id, record => {
        if (record.phase === 'settled') throw new Error('ACP diagnostic attempt already settled');
        return { ...record, phase: 'confirmed' };
      });
    });
  }
  /** Save only the safe whitelist before any failure is given to the official host. */
  settle(id: string, error?: SafeError): Promise<void> {
    const safe = error === undefined ? undefined : errorSchema.parse({
      category: error.category, retryable: error.retryable, outcomeUnknown: error.outcomeUnknown, origin: error.origin,
      ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(error.detailCode === undefined ? {} : { detailCode: error.detailCode }),
    });
    return this.write(async () => {
      await this.domain.table('attempts').update(id, record => {
        if (record.phase === 'settled') throw new Error('ACP diagnostic attempt already settled');
        return { ...record, phase: 'settled', ...(safe === undefined ? {} : { error: safe }) };
      });
    });
  }
  /** Resolve only this request's newest owned attempt; a pending retry never borrows an older failure. */
  find(sessionId: string, requestId: string, turn?: number, turnStartSeq?: number): SafeError | undefined {
    const records = [...this.domain.table('attempts').entries()].map(([, record]) => record)
      .filter(record => record.identity.sessionId === sessionId && record.identity.requestIds.includes(requestId)
        && (turn === undefined || record.identity.turn === turn)
        && (turnStartSeq === undefined || record.identity.turnStartSeq === turnStartSeq));
    const record = records.sort((a, b) => b.serial - a.serial)[0];
    if (!record) return;
    return record.error ? toSafeError(record.error, { trustedProjection: true, origin: 'dsh', operationId: requestId })
      : toSafeError(undefined, { origin: 'dsh', operationId: requestId, outcomeUnknown: record.phase === 'submitted' });
  }
  /** Drain writes before unloading; the owner first drains A2A and the Adapter. */
  async close(): Promise<void> { this.closed = true; await this.chain; await this.domain.close(); }
}

/** Own the official storage plugins until A2A and native calls have drained. */
export async function openDiagnostics(directory: string): Promise<{ diagnostics: Diagnostics; close: () => Promise<void> }> {
  // The host's shared facility can close concurrently during root teardown.
  // This private composition gives the consumer an explicit drain-before-close order.
  const lease = new DirectoryLease(directory);
  const storage = new Context();
  try {
    await storage.plugin(Storage);
    await storage.plugin(JsonStorage, { root: directory });
    const mounted = await storage.plugin(StorageDomain, { backend: 'json' });
    await mounted.await();
    const diagnostics = await Diagnostics.open(storage.storageDomain);
    let closing: Promise<void> | undefined;
    return { diagnostics, close: () => closing ??= (async () => {
      try { await diagnostics.close(); } finally { try { await storage.fiber.dispose(); } finally { lease.close(); } }
    })() };
  } catch {
    try { await storage.fiber.dispose(); } finally { lease.close(); }
    throw new Error('ACP diagnostic storage could not be opened; check its configuration and version.');
  }
}
