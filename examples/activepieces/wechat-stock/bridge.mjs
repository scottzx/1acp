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
    const minimum = config.policy.mode === 'catalog_batch' && config.policy.continuous === true ? 5000 : minimumIntervalMs;
    if (!Number.isSafeInteger(config.policy.checkIntervalMs) || config.policy.checkIntervalMs < minimum) throw new Error(`checkIntervalMs must be at least ${minimum}`);
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
    let deliveries = 0;
    for (const operation of Object.values(this.state.operations)) {
      if (operation.phase === 'working' && operation.recovery?.pending) {
        await this.resumeInterrupted(operation);
        if (operation.recovery.pending || operation.phase === 'failed') continue;
      }
      if (['claimed', 'dispatch_unknown'].includes(operation.phase)) {
        // The stable execution_submit request is replay-safe at the gateway ledger boundary.
        try { operation.job = await this.adapter.submit(operation); operation.phase = 'working'; await this.save(); }
        catch { operation.phase = 'dispatch_unknown'; await this.save(); continue; }
      }
      if (operation.phase === 'working') {
        const job = await this.adapter.get(operation);
        if (['submission_unknown', 'prepared'].includes(job.submissionStatus) || job.stale || job.executionStatus === 'unknown') {
          operation.syncPending = true; await this.save(); continue;
        }
        delete operation.syncPending;
        if (['failed', 'rejected', 'canceled', 'input_required', 'auth_required'].includes(job.executionStatus)) {
          operation.phase = 'failed'; await this.pause(`制作任务需要处理：${job.executionStatus}`); continue;
        }
        if (job.executionStatus !== 'completed') continue;
        if (this.config.policy.continuous && deliveries >= 1) continue;
        try { operation.delivery = await this.adapter.verify(operation, job); }
        catch (error) {
          operation.phase = 'delivery_invalid'; operation.diagnostic = String(error.message || error).slice(0, 500);
          await this.pause(`制作交付未通过文件与版本核验：${operation.key}`); continue;
        }
        operation.phase = 'write_pending'; await this.save();
      }
      if (operation.phase === 'write_pending') {
        if (this.config.policy.continuous && deliveries >= 1) continue;
        operation.asset = await this.adapter.ingest(operation, facts);
        deliveries++;
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
    // A transient transport outage must not become a permanent business pause.
    // Keep every original slot while unknown; clear only this legacy sync pause
    // after the complete reconciliation has observed all original tasks fresh.
    if (this.state.pausedReason?.startsWith('任务受理或状态待核对：')
        && !Object.values(this.state.operations).some(o => o.syncPending)) {
      delete this.state.pausedReason; this.state.syncRecoveredAt = new Date(this.clock()).toISOString(); await this.save();
    }
  }
  /** Explicit maintenance only: freeze all original checkpoints before any continuation. */
  async prepareInterruptedRecovery(keys) {
    return this.serialize(async () => {
      if (this.config.policy.mode !== 'catalog_batch' || this.config.policy.maxConcurrent !== 3
          || this.state.pausedReason !== '制作任务需要处理：failed'
          || !Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length) throw new Error('Original failed batch required');
      const failed = Object.values(this.state.operations).filter(o => o.phase === 'failed');
      if (failed.length !== keys.length || failed.some(o => !keys.includes(o.key))
          || Object.values(this.state.operations).some(o => ['claimed', 'dispatch_unknown', 'working', 'write_pending'].includes(o.phase))
          || keys.length > 3) throw new Error('Recover all failed originals without exceeding capacity');
      const prepared = [];
      for (const key of keys) {
        const operation = this.state.operations[key], view = await this.adapter.get(operation);
        if (view.stale || view.executionStatus !== 'failed' || view.submissionStatus !== 'accepted'
            || view.jobId !== operation.job.jobId || view.attemptId !== operation.job.attemptId
            || view.inFlightAttemptIds?.length || view.unresolvedAttemptIds?.length
            || !/interrupted by an A2A service restart/i.test(view.resultSummary ?? '')) throw new Error('Original interruption is not confirmed');
        prepared.push([operation, await this.adapter.prepareRecovery(operation, view)]);
      }
      for (const [operation, recovery] of prepared) {
        if (operation.recovery && !operation.recovery.pending) (operation.recoveryHistory ??= []).push(operation.recovery);
        operation.recovery = recovery;
      }
      await this.save();
      return prepared.map(([operation]) => ({ key: operation.key, jobId: operation.job.jobId, checkpointPath: operation.recovery.checkpointPath }));
    });
  }
  async resumeInterrupted(operation) {
    try {
      const view = await this.adapter.continue(operation.recovery.request);
      const attemptId = view.attemptId ?? view.currentAttemptId;
      if (view.jobId !== operation.recovery.previousJob.jobId || !attemptId
          || attemptId === operation.recovery.previousJob.attemptId) throw new Error('Continuation identity is unresolved');
      if (view.submissionStatus === 'accepted' && view.contextId !== operation.recovery.previousJob.contextId) throw new Error('Continuation context changed');
      operation.job = view; operation.recovery.pending = false;
      operation.recovery.resumedAt = new Date(this.clock()).toISOString();
      operation.phase = 'working';
      if (view.submissionStatus !== 'accepted' || view.stale) operation.syncPending = true;
      else delete operation.syncPending;
      if (['failed', 'rejected', 'canceled'].includes(view.executionStatus)) {
        operation.phase = 'failed'; this.state.pausedReason = `制作任务需要处理：${view.executionStatus}`;
      }
    } catch {
      // The identical persisted request is replayed at the ledger boundary; never submit a replacement job.
      operation.syncPending = true;
    }
    await this.save();
  }
  async submitInterruptedRecovery(keys) {
    return this.serialize(async () => {
      const operations = keys.map(key => this.state.operations[key]);
      if (new Set(keys).size !== keys.length || !keys.length || keys.length > 3
          || operations.some(o => !o?.recovery || o.recovery.previousJob.jobId !== o.job.jobId)
          || ![undefined, '制作任务需要处理：failed'].includes(this.state.pausedReason)) throw new Error('Prepared original recovery required');
      if (operations.some(o => !o.recovery.pending && o.phase === 'failed')) throw new Error('Resumed attempt failed; explicit new recovery required');
      if (Object.values(this.state.operations).filter(o => !keys.includes(o.key)
          && ['claimed', 'dispatch_unknown', 'working', 'write_pending'].includes(o.phase)).length) throw new Error('Other production slots are occupied');
      if (this.state.pausedReason && Object.values(this.state.operations).some(o => o.phase === 'failed' && !keys.includes(o.key))) throw new Error('Unprepared failure remains');
      // Occupy every slot durably before the first send, including unknown admissions.
      for (const operation of operations) if (operation.recovery.pending) operation.phase = 'working';
      delete this.state.pausedReason; delete this.state.continuousFinished;
      this.state.continuousStarted = true; await this.save();
      for (const operation of operations) if (operation.recovery.pending) await this.resumeInterrupted(operation);
      return { action: 'resume_originals', operations: operations.map(o => ({ key: o.key, jobId: o.job.jobId,
        previousAttemptId: o.recovery.previousJob.attemptId, attemptId: o.job.attemptId, taskId: o.job.taskId,
        phase: o.phase, admissionPending: o.recovery.pending || o.syncPending === true })) };
    });
  }
  input(facts) {
    const operations = Object.values(this.state.operations);
    const pending = operations.filter(operation => operation.phase === 'pending_review').length;
    const ready = operations.filter(operation => operation.phase === 'ready').length;
    const inFlight = operations.filter(operation => ['claimed', 'dispatch_unknown', 'working', 'write_pending'].includes(operation.phase)).length;
    const next = this.config.catalog.find(article => !operations.some(operation => operation.article.articleKey === article.articleKey));
    const policy = { ...this.config.policy, paused: Boolean(this.state.pausedReason || this.config.policy.paused) };
    return { policy, snapshot: { scopeId: policy.scopeId, mode: 'production', sample: false,
      complete: facts.complete === true && !operations.some(o => o.syncPending), stale: facts.stale === true, ready, pendingReview: pending, inFlight },
      batch: structuredClone(this.state.batch), nextArticle: next ? { ...next, ready: facts.complete === true && next.ready === true } : null,
      ...(policy.mode === 'catalog_batch' ? { nextArticles: this.config.catalog.filter(article => !operations.some(o => o.article.articleKey === article.articleKey)).slice(0, 3) } : {}),
      catalogExhausted: !next };
  }
  async observe({ flowRunId } = {}) {
    return this.serialize(async () => {
      const now = this.clock();
      if (!this.config.policy.continuous && now < this.state.nextCheckAt) return { due: false, reason: 'minimum_interval', nextCheckAt: new Date(this.state.nextCheckAt).toISOString() };
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
      if (expected.action === 'dispatch_batch') {
        if (this.config.policy.mode !== 'catalog_batch' || this.config.policy.maxConcurrent !== 3
            || this.state.pausedReason || !this.config.policy.enabled || this.config.policy.paused) throw new Error('Batch policy is disabled or paused');
        const facts = await this.adapter.readFacts();
        if (!facts.complete || facts.stale || facts.digest !== observation.factsDigest) throw new Error('Business facts changed; wait for the next observation');
        const occupied = Object.values(this.state.operations).filter(o => ['claimed', 'dispatch_unknown', 'working', 'write_pending'].includes(o.phase)).length;
        if (expected.articles.length > 3 - occupied) throw new Error('Batch capacity changed');
        const claims = [];
        for (const item of expected.articles) {
          const article = this.config.catalog.find(a => a.articleKey === item.articleKey), key = digest(item.actionIdentity);
          if (!article || Object.values(this.state.operations).some(o => o.article.articleKey === article.articleKey)) throw new Error('Article already claimed');
          claims.push({ key, article, phase: 'claimed', ...await this.adapter.prepare(article, key) });
        }
        for (const operation of claims) this.state.operations[operation.key] = operation;
        this.state.batch = structuredClone(expected.nextBatch); this.state.lastDispatchAt = this.clock(); await this.save();
        // All slots are durable before any submit; unknown acceptance retains its slot.
        for (const operation of claims) {
          try { operation.job = await this.adapter.submit(operation); operation.phase = 'working'; }
          catch { operation.phase = 'dispatch_unknown'; }
          await this.save();
        }
        receipt = { ...receipt, executionPerformed: true, operations: claims.map(o => ({ key: o.key, articleKey: o.article.articleKey, phase: o.phase, jobId: o.job?.jobId, attemptId: o.job?.attemptId })) };
        observation.applied = true; observation.receipt = receipt; await this.save(); return receipt;
      }
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
  /** Explicit local repair of the same completed delivery; never submits a job. */
  async recoverDelivery(key) {
    return this.serialize(async () => {
      const operation = this.state.operations[key];
      const reason = `制作交付未通过文件与版本核验：${key}`;
      if (!operation || !['delivery_invalid', 'write_pending', 'pending_review', 'ready'].includes(operation.phase)
          || this.state.pausedReason !== reason) throw new Error('Recovery does not match the original delivery pause');
      const facts = await this.adapter.readFacts();
      if (!facts.complete || facts.stale) throw new Error('Fresh business facts required for recovery');
      if (operation.phase === 'delivery_invalid') {
        const view = await this.adapter.get(operation);
        if (view.stale || view.executionStatus !== 'completed') throw new Error('Original delivery is not current and completed');
        operation.delivery = await this.adapter.verify(operation, view);
        operation.phase = 'write_pending'; await this.save();
      }
      if (operation.phase === 'write_pending') {
        operation.asset = await this.adapter.ingest(operation, facts);
        operation.phase = 'pending_review'; await this.save();
      }
      const status = this.adapter.assetStatus(operation, facts);
      if (!['pending_review', 'ready'].includes(status)) throw new Error('Recovered asset has a business conflict');
      operation.phase = status;
      if (!operation.noticeHandled) {
        await this.adapter.acceptAndAcknowledge(operation); operation.noticeHandled = true;
      }
      operation.recovery = { recoveredAt: new Date(this.clock()).toISOString(), jobId: operation.job.jobId,
        attemptId: operation.job.attemptId, resultRevision: operation.delivery.resultRevision };
      delete this.state.pausedReason;
      await this.save(); return this.status();
    });
  }
  status() {
    return { roleId: 'wechat-stock-replenisher', mode: 'production', enabled: this.config.policy.enabled,
      executionMode: this.config.policy.mode ?? 'stock', maxConcurrent: this.config.policy.maxConcurrent,
      continuous: this.config.policy.continuous === true, continuousStarted: this.state.continuousStarted === true,
      scopeId: this.config.policy.scopeId, accountId: this.config.accountId ?? null, checkIntervalMs: this.config.policy.checkIntervalMs,
      nextCheckAt: this.state.nextCheckAt ? new Date(this.state.nextCheckAt).toISOString() : null,
      pausedReason: this.state.pausedReason ?? null, lastError: this.state.lastError ?? null,
      syncPending: Object.values(this.state.operations).filter(o => o.syncPending).map(o => o.key),
      batch: this.state.batch, lastAction: this.state.observation?.receipt ?? null,
      operations: Object.values(this.state.operations).map(operation => ({ key: operation.key, articleKey: operation.article.articleKey,
        phase: operation.phase, jobId: operation.job?.jobId, assetId: operation.asset?.id })) };
  }
}
