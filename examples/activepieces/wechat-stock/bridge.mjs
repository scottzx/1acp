import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { evaluateStock } from './policy.mjs';

export const minimumIntervalMs = 30 * 60 * 1000;
export const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
}

/** Finite AP-requested transactions. No timer and no autonomous scheduling in this service. */
export class StockBridge {
  constructor(config, adapter, clock = () => Date.now()) {
    if (!Number.isSafeInteger(config.policy.checkIntervalMs) || config.policy.checkIntervalMs < minimumIntervalMs) throw new Error('checkIntervalMs must be at least 1800000');
    this.config = config; this.adapter = adapter; this.clock = clock; this.queue = Promise.resolve();
    this.path = join(config.stateDirectory, 'stock.json');
  }
  async initialize() {
    await mkdir(this.config.stateDirectory, { recursive: true, mode: 0o700 });
    try { this.state = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.state ??= { version: 1, revision: 0, scopeId: this.config.policy.scopeId, batch: { active: false, exhausted: false }, operations: {}, nextCheckAt: 0 };
    if (this.state.version !== 1 || this.state.scopeId !== this.config.policy.scopeId || !this.state.operations || !this.state.batch) throw new Error('Stock state does not match configured scope');
    for (const seed of this.config.seeds ?? []) if (!this.state.operations[seed.key]) {
      const article = this.config.catalog.find(item => item.articleKey === seed.articleKey);
      if (!article) throw new Error('Seed does not belong to the frozen catalog');
      this.state.operations[seed.key] = { ...seed, article, phase: 'working', seed: true, noticeHandled: true };
    }
    await this.save(); return this;
  }
  serialize(fn) { const result = this.queue.catch(() => {}).then(fn); this.queue = result; return result; }
  async save() { this.state.revision++; await atomicJson(this.path, this.state); }
  async pause(reason) { this.state.pausedReason = reason; await this.save(); }
  async reconcile(facts) {
    for (const operation of Object.values(this.state.operations)) {
      if (['claimed', 'dispatch_unknown'].includes(operation.phase)) {
        // The stable execution_submit request is replay-safe at the gateway ledger boundary.
        try { operation.job = await this.adapter.submit(operation); operation.phase = 'working'; await this.save(); }
        catch { operation.phase = 'dispatch_unknown'; await this.save(); continue; }
      }
      if (operation.phase === 'working') {
        const job = await this.adapter.get(operation);
        if (['submission_unknown', 'prepared'].includes(job.submissionStatus) || job.stale || job.executionStatus === 'unknown') {
          await this.pause(`任务受理或状态待核对：${operation.key}`); continue;
        }
        if (['failed', 'rejected', 'canceled', 'input_required', 'auth_required'].includes(job.executionStatus)) {
          operation.phase = 'failed'; await this.pause(`制作任务需要处理：${job.executionStatus}`); continue;
        }
        if (job.executionStatus !== 'completed') continue;
        try { operation.delivery = await this.adapter.verify(operation, job); }
        catch (error) {
          operation.phase = 'delivery_invalid'; operation.diagnostic = String(error.message || error).slice(0, 500);
          await this.pause(`制作交付未通过文件与版本核验：${operation.key}`); continue;
        }
        operation.phase = 'write_pending'; await this.save();
      }
      if (operation.phase === 'write_pending') {
        operation.asset = await this.adapter.ingest(operation, facts);
        operation.phase = 'pending_review'; await this.save();
      }
      if (['pending_review', 'ready', 'published'].includes(operation.phase)) {
        if (operation.phase !== 'published') {
          const status = this.adapter.assetStatus(operation, facts);
          if (status === 'changes_requested' || status === 'conflict') {
            await this.pause(`成品审核退回或当前版本发生变化：${operation.key}`); continue;
          }
          if (['pending_review', 'ready', 'published'].includes(status)) operation.phase = status;
        }
        if (!operation.noticeHandled) {
          await this.adapter.acceptAndAcknowledge(operation);
          operation.noticeHandled = true;
        }
        await this.save();
      }
    }
  }
  input(facts) {
    const operations = Object.values(this.state.operations);
    const pending = operations.filter(operation => operation.phase === 'pending_review').length;
    const ready = operations.filter(operation => operation.phase === 'ready').length;
    const inFlight = operations.filter(operation => ['claimed', 'dispatch_unknown', 'working', 'write_pending'].includes(operation.phase)).length;
    const next = this.config.catalog.find(article => !operations.some(operation => operation.article.articleKey === article.articleKey));
    const policy = { ...this.config.policy, paused: Boolean(this.state.pausedReason || this.config.policy.paused) };
    return { policy, snapshot: { scopeId: policy.scopeId, mode: 'production', sample: false,
      complete: facts.complete === true, stale: facts.stale === true, ready, pendingReview: pending, inFlight },
      batch: structuredClone(this.state.batch), nextArticle: next ? { ...next, ready: facts.complete === true && next.ready === true } : null,
      catalogExhausted: !next };
  }
  async observe({ flowRunId } = {}) {
    return this.serialize(async () => {
      const now = this.clock();
      if (now < this.state.nextCheckAt) return { due: false, reason: 'minimum_interval', nextCheckAt: new Date(this.state.nextCheckAt).toISOString() };
      this.state.nextCheckAt = now + this.config.policy.checkIntervalMs;
      this.state.lastCheckAt = new Date(now).toISOString(); await this.save();
      let facts;
      try {
        facts = await this.adapter.readFacts();
        if (facts.complete !== true || facts.stale === true) throw new Error('incomplete business snapshot');
        await this.reconcile(facts);
        facts = await this.adapter.cachedFacts();
        delete this.state.lastError;
      } catch (error) {
        this.state.lastError = 'business_facts_or_reconciliation_failed';
        this.state.diagnostic = String(error.message || error).slice(0, 500);
        facts = { complete: false, stale: true };
      }
      const input = this.input(facts), observationId = randomUUID();
      this.state.observation = { observationId, observedAt: now, flowRunId, factsDigest: facts.digest, input, applied: false };
      await this.save();
      return { due: true, observationId, input, pausedReason: this.state.pausedReason ?? null,
        sourceError: this.state.lastError ?? null, nextCheckAt: new Date(this.state.nextCheckAt).toISOString() };
    });
  }
  async apply({ observationId, advice } = {}) {
    return this.serialize(async () => {
      if (!observationId) return { applied: false, reason: 'not_due' };
      const observation = this.state.observation;
      if (!observation || observation.observationId !== observationId) throw new Error('Observation no longer current');
      if (observation.applied) return observation.receipt;
      if (this.clock() - observation.observedAt > 10 * 60 * 1000) throw new Error('Observation expired');
      const expected = evaluateStock(observation.input);
      if (digest(expected) !== digest(advice)) throw new Error('Advice differs from the frozen business observation');
      let receipt = { applied: true, action: expected.action, reason: expected.reason, executionPerformed: false };
      if (expected.shouldDispatch) {
        if (this.state.pausedReason || !this.config.policy.enabled || this.config.policy.paused) throw new Error('Policy is disabled or paused');
        if (this.state.lastDispatchAt && this.clock() - this.state.lastDispatchAt < this.config.policy.checkIntervalMs) throw new Error('Dispatch interval has not elapsed');
        const facts = await this.adapter.readFacts();
        if (!facts.complete || facts.stale || facts.digest !== observation.factsDigest) throw new Error('Business facts changed; wait for the next observation');
        if (Object.values(this.state.operations).some(operation => ['claimed', 'dispatch_unknown', 'working', 'write_pending'].includes(operation.phase))) throw new Error('A production slot is already occupied');
        const key = digest(expected.actionIdentity);
        let operation = this.state.operations[key];
        if (!operation) {
          const article = this.config.catalog.find(item => item.articleKey === observation.input.nextArticle.articleKey);
          const prepared = await this.adapter.prepare(article, key);
          operation = this.state.operations[key] = { key, article, phase: 'claimed', ...prepared };
          // The full request, source versions and occupied slot are durable before submission.
          if (expected.nextBatch) this.state.batch = structuredClone(expected.nextBatch);
          this.state.lastDispatchAt = this.clock(); await this.save();
        }
        try { operation.job = await this.adapter.submit(operation); operation.phase = 'working'; }
        catch { operation.phase = 'dispatch_unknown'; }
        receipt = { ...receipt, operationKey: key, executionPerformed: true, phase: operation.phase,
          ...(operation.job ? { jobId: operation.job.jobId, attemptId: operation.job.attemptId } : {}) };
      }
      if (expected.nextBatch) this.state.batch = structuredClone(expected.nextBatch);
      observation.applied = true; observation.receipt = receipt; await this.save(); return receipt;
    });
  }
  status() {
    return { roleId: 'wechat-stock-replenisher', mode: 'production', enabled: this.config.policy.enabled,
      scopeId: this.config.policy.scopeId, accountId: this.config.accountId ?? null, checkIntervalMs: this.config.policy.checkIntervalMs,
      nextCheckAt: this.state.nextCheckAt ? new Date(this.state.nextCheckAt).toISOString() : null,
      pausedReason: this.state.pausedReason ?? null, lastError: this.state.lastError ?? null,
      batch: this.state.batch, lastAction: this.state.observation?.receipt ?? null,
      operations: Object.values(this.state.operations).map(operation => ({ key: operation.key, articleKey: operation.article.articleKey,
        phase: operation.phase, jobId: operation.job?.jobId, assetId: operation.asset?.id })) };
  }
}
