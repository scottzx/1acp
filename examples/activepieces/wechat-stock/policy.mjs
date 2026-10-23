/** Pure advice over a normalized business snapshot. No I/O, claims, writes or dispatches. */
export function evaluateStock(input) {
  const base = { schemaVersion: 1, executionPerformed: false, shouldDispatch: false };
  const answer = (action, reason, extra = {}) => ({ ...base, action, reason, ...extra });
  if (!input || typeof input !== 'object' || !input.policy || !input.batch) {
    return answer('invalid_input', 'missing_policy_or_batch');
  }
  const { policy, snapshot, batch } = input;
  const scopeId = policy.scopeId ?? policy.accountId;
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const identity = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
  if (!identity(policy.policyId) || !identity(scopeId)
      || typeof policy.enabled !== 'boolean' || typeof policy.paused !== 'boolean'
      || typeof batch.active !== 'boolean' || typeof batch.exhausted !== 'boolean'
      || (policy.mode === 'catalog_batch' ? policy.maxConcurrent !== 3 : (!integer(policy.lowWatermark) || policy.lowWatermark < 1
      || !integer(policy.targetStock) || policy.targetStock <= policy.lowWatermark
      || policy.maxConcurrent !== 1)) || !integer(policy.checkIntervalMs)
      || policy.checkIntervalMs < (policy.mode === 'catalog_batch' && policy.continuous === true ? 5000 : 30 * 60 * 1000)) {
    return answer('invalid_input', 'invalid_policy_or_batch');
  }
  if (!policy.enabled) return answer('disabled', 'policy_disabled');
  if (policy.paused) return answer('paused', 'policy_paused');
  if (!snapshot || snapshot.complete !== true || snapshot.stale !== false
      || (snapshot.scopeId ?? snapshot.accountId) !== scopeId
      || !['simulation', 'production'].includes(snapshot.mode)
      || typeof snapshot.sample !== 'boolean'
      || (snapshot.mode === 'production' && snapshot.sample)) {
    return answer('wait_facts', 'snapshot_not_usable');
  }
  const { ready, pendingReview, inFlight } = snapshot;
  const occupied = ready + pendingReview + inFlight;
  if (![ready, pendingReview, inFlight, occupied].every(integer)) {
    return answer('wait_facts', 'invalid_inventory_counts');
  }
  if (snapshot.blockedReason) return answer('paused', 'business_exception');
  if (policy.mode === 'catalog_batch') {
    const counts = { ready, pendingReview, inFlight, occupied };
    const slots = Math.max(0, policy.maxConcurrent - inFlight);
    const remaining = input.nextArticles;
    if (!Array.isArray(remaining)) return answer('wait_preparation', 'missing_catalog_candidates');
    const nextBatch = { active: true, exhausted: false, mode: 'catalog_batch', scopeId };
    if (!remaining.length && input.catalogExhausted === true && !inFlight) return answer('complete_catalog', 'all_articles_produced', { counts, nextBatch: { ...nextBatch, active: false, exhausted: true } });
    if (!slots || !remaining.length) return answer('wait_task', 'batch_slots_occupied', { counts, nextBatch });
    const articles = remaining.slice(0, slots);
    if (articles.some(a => a.ready !== true || !identity(a.articleKey) || !/^[a-f0-9]{64}$/.test(a.sourceSha256) || !Number.isSafeInteger(a.revision) || a.revision < 1)
        || new Set(articles.map(a => a.articleKey)).size !== articles.length) return answer('wait_preparation', 'article_or_approval_not_ready');
    return answer('dispatch_batch', 'catalog_remaining', { counts, nextBatch, shouldDispatch: true,
      articles: articles.map(a => ({ articleKey: a.articleKey, actionIdentity: [policy.policyId, scopeId, a.articleKey, a.sourceSha256, a.revision] })) });
  }
  if (batch.active && (batch.targetStock !== policy.targetStock || (batch.scopeId ?? batch.accountId) !== scopeId)) {
    return answer('paused', 'batch_configuration_changed');
  }
  const counts = { ready, pendingReview, inFlight, occupied };
  if (!batch.active && ready >= policy.lowWatermark) return answer('wait_stock', 'above_start_threshold', { counts });
  if (!batch.active && batch.exhausted) return answer('exhausted', 'catalog_already_exhausted', { counts });
  const nextBatch = { active: true, exhausted: false, targetStock: policy.targetStock, scopeId };
  const context = { counts, nextBatch, startsBatch: !batch.active, productionGap: Math.max(0, policy.targetStock - occupied) };
  if (ready >= policy.targetStock) {
    return answer('complete_batch', 'ready_stock_reached_target', { ...context, nextBatch: { ...nextBatch, active: false } });
  }
  if (inFlight > 0) return answer('wait_task', 'existing_action_in_flight', context);
  if (occupied >= policy.targetStock) return answer('wait_review', 'all_stock_positions_reserved', context);
  const article = input.nextArticle;
  if (!article) {
    if (input.catalogExhausted !== true) return answer('wait_preparation', 'next_article_not_prepared', context);
    if (pendingReview > 0) return answer('wait_review', 'catalog_exhausted_reviews_pending', context);
    return answer('exhausted', 'catalog_exhausted', { ...context, nextBatch: { ...nextBatch, active: false, exhausted: true } });
  }
  if (article.ready !== true || !identity(article.articleKey)
      || typeof article.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(article.sourceSha256)
      || !Number.isSafeInteger(article.revision) || article.revision < 1) {
    return answer('wait_preparation', 'article_or_approval_not_ready', context);
  }
  return answer('dispatch_next', 'production_gap', {
    ...context, shouldDispatch: true, targetId: 'wechat-series-editor',
    // The trusted bridge must canonicalize/hash this identity for its durable request key.
    // Poll times, AP run IDs and observation timestamps deliberately do not participate.
    actionIdentity: [policy.policyId, scopeId, article.articleKey, article.sourceSha256, article.revision],
  });
}
