export const exampleObservation = {
  policy: { policyId: 'wechat-stock-replenisher', accountId: 'simulation-account', enabled: true,
    paused: false, lowWatermark: 10, targetStock: 15, maxConcurrent: 1, checkIntervalMs: 1800000 },
  snapshot: { accountId: 'simulation-account', mode: 'simulation', sample: true, complete: true,
    stale: false, ready: 9, pendingReview: 0, inFlight: 0 },
  batch: { active: false, exhausted: false },
  nextArticle: { articleKey: 'simulation-article-002', sourceSha256: 'a'.repeat(64), revision: 1, ready: true },
  catalogExhausted: false,
};

export function observation(patch = {}) {
  const original = structuredClone(exampleObservation);
  return { ...original, ...patch, policy: { ...original.policy, ...patch.policy },
    snapshot: { ...original.snapshot, ...patch.snapshot }, batch: { ...original.batch, ...patch.batch } };
}

const active = { active: true, exhausted: false, accountId: 'simulation-account', targetStock: 15 };
export const scenarios = [
  { name: '9篇时启动', expectedAction: 'dispatch_next', input: observation() },
  { name: '恰好10篇不启动', expectedAction: 'wait_stock', input: observation({ snapshot: { ready: 10 } }) },
  { name: '活动批次10篇继续', expectedAction: 'dispatch_next', input: observation({ batch: active, snapshot: { ready: 10 } }) },
  { name: '活动批次14篇继续', expectedAction: 'dispatch_next', input: observation({ batch: active, snapshot: { ready: 14 } }) },
  { name: '9篇加6篇待审停止新制作', expectedAction: 'wait_review', input: observation({ batch: active, snapshot: { pendingReview: 6 } }) },
  { name: '已有制作不重派', expectedAction: 'wait_task', input: observation({ batch: active, snapshot: { pendingReview: 5, inFlight: 1 } }) },
  { name: '15篇审核通过结束本轮', expectedAction: 'complete_batch', input: observation({ batch: active, snapshot: { ready: 15 } }) },
  { name: '读取失败等待', expectedAction: 'wait_facts', input: observation({ snapshot: { complete: false } }) },
  { name: '暂停后不派单', expectedAction: 'paused', input: observation({ policy: { paused: true } }) },
  { name: '前置资料未完成等待', expectedAction: 'wait_preparation', input: observation({ nextArticle: null }) },
  { name: '素材耗尽结束', expectedAction: 'exhausted', input: observation({ nextArticle: null, catalogExhausted: true }) },
  { name: '耗尽后不反复启动空批次', expectedAction: 'exhausted', input: observation({ batch: { exhausted: true } }) },
];
