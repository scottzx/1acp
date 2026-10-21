import type { PptDeliveryArtifact, PptDeliveryRun, PptDeliveryValidation } from './ppt-delivery.js';
import type { A2AResultMetadata } from '../a2a/result-metadata.js';

export const deliveryStageNames = {
  summary: '项目总结与脚本', make: 'PPT制作', validate: '机器校验', review: '独立验收',
} as const;

/** Persisted facts projected for readers; producing a projection never schedules work or a notification. */
export function deliveryProgress(run: PptDeliveryRun) {
  const latest = (purpose: string) => [...run.children].reverse().find(item => item.purpose === purpose);
  const summary = latest('project_script'), maker = latest('ppt_production'), reviewer = latest('independent_review');
  const status = (child: typeof summary) => child?.child.executionStatus ?? 'not_started';
  const stages = [
    { stage: 'summary', name: deliveryStageNames.summary, status: status(summary) === 'completed' && !run.scriptDigest ? 'awaiting_validation' : status(summary), child: summary?.child },
    { stage: 'make', name: deliveryStageNames.make, status: status(maker), child: maker?.child },
    { stage: 'validate', name: deliveryStageNames.validate, status: run.validation ? 'completed' : run.stage === 'validate' ? run.executionStatus : 'not_started', child: undefined },
    { stage: 'review', name: deliveryStageNames.review, status: run.review?.verdict === 'passed' ? 'completed'
      : run.review?.verdict === 'changes_requested' ? 'changes_requested' : status(reviewer) === 'completed' ? 'awaiting_validation' : status(reviewer), child: reviewer?.child },
  ].map(({ child, ...stage }) => ({ ...stage, ...(child ? { jobId: child.jobId, attemptId: child.attemptId, sessionId: child.sessionId } : {}) }));
  const versions = new Map<string, { revision: number; validation: PptDeliveryValidation }>();
  for (const entry of run.artifactHistory ?? []) versions.set(`${entry.revision}:${entry.validation.artifactDigest}`, entry);
  if (run.validation) versions.set(`${run.revision}:${run.validation.artifactDigest}`, { revision: run.revision, validation: run.validation });
  const availableResults: { revision: string; artifactDigest: string; artifacts: PptDeliveryArtifact[];
    validation: 'machine_passed' | 'producer_host_verified'; independentReview: string; deliveryReady: boolean }[] = [...versions.values()].map(({ revision, validation }) => ({
    revision: `revision-${revision}`, artifactDigest: validation.artifactDigest, artifacts: validation.artifacts,
    validation: 'machine_passed' as const,
    independentReview: revision === run.revision && run.review?.artifactDigest === validation.artifactDigest ? run.review.verdict : 'not_completed',
    deliveryReady: run.executionStatus === 'completed' && revision === run.revision && run.review?.verdict === 'passed'
      && run.review.artifactDigest === validation.artifactDigest,
  }));
  // A completed producer's host-authored receipt can expose a draft before the parent's machine check.
  const metadata = maker?.child.resultMetadata as Partial<A2AResultMetadata> | undefined;
  if (maker && metadata?.producer === '1agents/a2a-host' && metadata.outcome === 'completed' && metadata.validation?.status === 'passed'
      && metadata.taskId === maker.child.backendRunRef?.taskId && !availableResults.some(item => item.revision === `revision-${maker.revision}`)) {
    const artifacts = (Array.isArray(metadata.artifacts) ? metadata.artifacts : []).filter(a => {
      try { const url = new URL(a.url ?? ''); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        && typeof a.mediaType === 'string' && typeof a.path === 'string' && Number.isSafeInteger(a.size) && a.size > 0 && /^[a-f0-9]{64}$/.test(a.sha256); }
      catch { return false; }
    }) as PptDeliveryArtifact[];
    if (artifacts.length) availableResults.push({ revision: `revision-${maker.revision}`, artifactDigest: '', artifacts,
      validation: 'producer_host_verified', independentReview: 'not_completed', deliveryReady: false });
  }
  return { stage: run.stage, phase: run.phase, revision: `revision-${run.revision}`, executionStatus: run.executionStatus,
    stages, completedStages: stages.filter(stage => stage.status === 'completed').map(stage => stage.name),
    remainingStages: stages.filter(stage => stage.status !== 'completed').map(stage => stage.name),
    availableResults, cancellationRequestedAt: run.cancellationRequestedAt, updatedAt: run.updatedAt,
    stageCompletionWakeups: false as const };
}

export function deliveryException(run: PptDeliveryRun, reason: string) {
  const progress = deliveryProgress(run), candidate = progress.availableResults.at(-1);
  const summary = `${reason}\n\n已完成：${progress.completedStages.join('、') || '暂无'}。\n未完成：${progress.remainingStages.join('、') || '无'}。`
    + (candidate ? `\n已有产物：${candidate.revision}；${candidate.validation === 'machine_passed' ? '机器校验通过' : '仅制作端文件校验通过'}，独立验收状态：${candidate.independentReview}。以下为已有制作稿，尚非最终交付。` : '');
  return { progress, summary, artifacts: candidate?.artifacts ?? [] };
}
