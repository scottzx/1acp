import { evaluateStock } from './policy.mjs';

/** One bounded cycle; the background service owns repetition, never the caller. */
export async function continuousCycle(bridge) {
  if (!bridge.config.policy.enabled || bridge.config.policy.paused || bridge.state.pausedReason) return { action: 'paused' };
  const active = Object.values(bridge.state.operations).filter(o => ['claimed', 'dispatch_unknown', 'working', 'write_pending'].includes(o.phase));
  if (active.length >= 3 && active.every(o => o.phase === 'working')) {
    let changed = false;
    for (const operation of active) {
      const job = await bridge.adapter.get(operation);
      if (job.stale || job.executionStatus !== 'working') changed = true;
    }
    if (!changed) return { action: 'wait_task' };
  }
  const observation = await bridge.observe();
  if (!observation.due) return { action: 'wait_interval' };
  return bridge.apply({ observationId: observation.observationId, advice: evaluateStock(observation.input) });
}

export function continuousRunner(bridge) {
  let stopped = false, timer, pending;
  async function run() {
    if (stopped) return { action: 'stopped' };
    if (pending) return pending;
    pending = (async () => {
      let receipt;
      try {
        receipt = await continuousCycle(bridge);
        bridge.state.lastContinuousReceipt = receipt;
        delete bridge.state.continuousError;
        if (receipt.action === 'complete_catalog') bridge.state.continuousFinished = true;
        await bridge.save();
        return receipt;
      } catch {
        bridge.state.continuousError = 'cycle_requires_reconciliation'; await bridge.save();
        return { action: 'wait_reconciliation' };
      } finally {
        pending = undefined;
        if (!stopped && !bridge.state.continuousFinished) timer = setTimeout(() => { void run(); }, bridge.config.policy.checkIntervalMs);
      }
    })();
    return pending;
  }
  return {
    async start() {
      if (!bridge.state.continuousStarted) { bridge.state.continuousStarted = true; await bridge.save(); }
      if (timer) clearTimeout(timer);
      return run();
    },
    restore() { if (bridge.state.continuousStarted && !bridge.state.continuousFinished) timer = setTimeout(() => { void run(); }, 0); },
    async stop() { stopped = true; clearTimeout(timer); if (pending) await pending; },
  };
}
