/** Human-readable projections of the execution ledger. Reading never dispatches or acknowledges work. */
import type { JobRef, LedgerAttempt, LedgerEvent, LedgerJob, LedgerState } from './ledger.js';
import type { PptDeliveryRun } from './ppt-delivery.js';
import { deliveryProgress } from './delivery-progress.js';
import type { HumanReviewRequest, HumanReviewStatus } from './human-review.js';

export interface AcpTaskSummary {
  sourceId: string; jobId: string; title: string; originSessionId: string; parentJobRef?: JobRef;
  parentAttemptId?: string; purpose?: string; targetId: string; currentAttemptId: string;
  executionStatus: string; displayStatus: string; phase: string; createdAt: string | null; updatedAt: string;
  stale: boolean; reviewStatus?: HumanReviewStatus; pendingReviewId?: string; progressSummary: string;
  inFlightAttemptIds: string[]; unresolvedAttemptIds: string[];
}
export interface WorkbenchStage { stage: string; name: string; status: string; planned: boolean; jobId?: string; attemptId?: string }
export interface WorkbenchProgress { stage: string; phase: string; stages: WorkbenchStage[]; completedStages: string[];
  remainingStages: string[]; executionElapsedMs?: number; humanWaitingMs?: number; updatedAt: string;
  availableResults?: ReturnType<typeof deliveryProgress>['availableResults'] }
export interface WorkbenchDependency { from: string; to: string; kind: 'parent' | 'depends_on' | 'replaces'; label: string; parentAttemptId?: string }
export type WorkbenchReview = HumanReviewRequest & { canReview: boolean; resumeStatus?: 'pending' | 'applied'; resumeError?: string };
export type WorkbenchAttempt = Omit<LedgerAttempt, 'input' | 'targetSnapshot' | 'backendRunRef'> & { backendRunRef?: Record<string, string> };
export interface AcpTaskDetail extends AcpTaskSummary {
  attempts: WorkbenchAttempt[]; children: AcpTaskSummary[]; ancestors: AcpTaskSummary[];
  progress: WorkbenchProgress; reviews: WorkbenchReview[]; events: LedgerEvent[]; dependencies: WorkbenchDependency[];
  artifacts: { revision: string; digest?: string; artifacts: unknown[] }[];
}
export interface WorkbenchSource { ledger: LedgerState; runs: readonly PptDeliveryRun[]; reviews: readonly HumanReviewRequest[];
  actorId: string; allowedOrigins?: readonly string[]; now?: number }
export interface WorkbenchSnapshot { sourceId: string; tasks: AcpTaskSummary[]; details: Record<string, AcpTaskDetail> }
export interface WorkbenchListQuery { filter?: 'all' | 'pending' | 'working' | 'failed'; limit?: number; offset?: number }
const stageNames: Record<string, string> = { summary: '文稿生成', human_review: '人工审核', make: '设计制作', validate: '机器校验', review: '独立验收', finished: '交付完成' };
const purposeNames: Record<string, string> = { project_script: '文稿生成', ppt_production: '设计制作', independent_review: '独立验收' };
const terminal = new Set(['completed', 'failed', 'canceled', 'rejected']);
const stateDescriptions: Record<string, string> = { not_started: '等待开始执行。', submitted: '任务已提交，等待执行角色开始。', working: '执行角色正在处理任务。',
  input_required: '任务等待补充输入。', auth_required: '任务等待完成认证。', completed: '执行已完成，可查看产物和执行记录。',
  failed: '执行失败，请查看异常原因。', canceled: '任务已取消，已有产物与历史保留。', rejected: '执行请求未被接受。', unknown: '执行状态尚未确认，请核实执行宿主。' };
function runDescription(run: PptDeliveryRun): string {
  if (terminal.has(run.executionStatus)) return stateDescriptions[run.executionStatus]!;
  if (run.stage === 'make' && !run.currentChild && !run.pending) return '文字稿已确认，等待启动设计制作。';
  return ({ summary: '文稿作者正在生成或修订文字稿。', make: '制作角色正在根据确认的文字稿设计 PPT。', validate: '正在检查制作产物的文件与结构。',
    review: '独立验收角色正在核对事实和页面效果。', finished: '交付已完成，可查看最终产物。' })[run.stage];
}
function byNewest<T extends { updatedAt: string }>(items: T[]): T[] { return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
function latestReview(reviews: readonly HumanReviewRequest[], job: LedgerJob): HumanReviewRequest | undefined {
  return byNewest(reviews.filter(r => r.jobId === job.jobId && r.attemptId === job.currentAttemptId).map(r => structuredClone(r)).reverse())[0];
}
function safeArtifact(input: unknown): unknown | undefined {
  if (typeof input === 'string') { try { const url = new URL(input); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? input : undefined; } catch { return undefined; } }
  if (!input || typeof input !== 'object') return undefined;
  const value = input as Record<string, unknown>;
  if (typeof value.url !== 'string' || !safeArtifact(value.url)) return undefined;
  const result: Record<string, unknown> = { url: value.url };
  for (const key of ['name', 'path', 'mediaType', 'size', 'sha256']) if (['string', 'number'].includes(typeof value[key])) result[key] = value[key];
  return result;
}
function attemptView(attempt: LedgerAttempt): WorkbenchAttempt {
  const { input: _input, targetSnapshot: _snapshot, backendRunRef, ...view } = structuredClone(attempt);
  const refs: Record<string, string> = {};
  for (const key of ['provider', 'remote', 'taskId', 'contextId', 'sessionId', 'flowRunId', 'runId']) if (typeof backendRunRef?.[key] === 'string') refs[key] = backendRunRef[key];
  if (view.result) { view.result.artifactLinks = view.result.artifactLinks.map(safeArtifact).filter(item => item !== undefined); delete view.result.structuredResultRef; }
  return { ...view, ...(Object.keys(refs).length ? { backendRunRef: refs } : {}) };
}
function eventView(event: LedgerEvent): LedgerEvent {
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/token|password|secret|authorization|apiKey|input|prompt/i.test(key)).map(([key, item]) => [key, clean(item)]));
    return value;
  };
  return { ...structuredClone(event), ...(event.data === undefined ? {} : { data: clean(event.data) }) };
}
function progress(job: LedgerJob, run: PptDeliveryRun | undefined, reviews: readonly HumanReviewRequest[], attempt: LedgerAttempt | undefined, now: number): WorkbenchProgress {
  if (!run) {
    const name = purposeNames[job.purpose ?? ''] ?? '任务执行', status = attempt?.executionStatus ?? job.executionStatus;
    return { stage: job.purpose ?? 'execution', phase: attempt?.phase ?? '', stages: [{ stage: job.purpose ?? 'execution', name, status, planned: false, jobId: job.jobId, attemptId: job.currentAttemptId }],
      completedStages: status === 'completed' ? [name] : [], remainingStages: status === 'completed' ? [] : [name], updatedAt: job.updatedAt };
  }
  const review = latestReview(reviews, job), latest = (purpose: string) => [...run.children].reverse().find(child => child.purpose === purpose);
  const script = latest('project_script'), maker = latest('ppt_production'), reviewer = latest('independent_review');
  const stage = (key: string, child: typeof script, status?: string): WorkbenchStage => ({ stage: key, name: stageNames[key]!, status: status ?? child?.child.executionStatus ?? 'not_started',
    planned: !child, ...(child ? { jobId: child.child.jobId, attemptId: child.child.attemptId } : {}) });
  const stages: WorkbenchStage[] = [stage('summary', script)];
  const human = run as PptDeliveryRun & { humanWaitStartedAt?: string; humanWaitingMs?: number };
  const requireReview = (run.policy as PptDeliveryRun['policy'] & { requireHumanReview?: boolean }).requireHumanReview;
  if (review || requireReview) stages.push({ stage: 'human_review', name: stageNames.human_review!, status: review?.status ?? 'not_started', planned: !review, jobId: job.jobId, attemptId: job.currentAttemptId });
  stages.push(stage('make', maker), { stage: 'validate', name: stageNames.validate!, status: run.validation ? 'completed' : run.stage === 'validate' ? run.executionStatus : 'not_started', planned: !run.validation && run.stage !== 'validate' },
    stage('review', reviewer, run.review?.verdict === 'passed' ? 'completed' : run.review?.verdict === 'changes_requested' ? 'changes_requested' : reviewer?.child.executionStatus));
  const complete = (s: WorkbenchStage) => ['completed', 'approved'].includes(s.status);
  return { stage: review?.status === 'pending' && !terminal.has(job.executionStatus) && !terminal.has(run.executionStatus) ? 'human_review' : run.stage, phase: run.phase, stages,
    completedStages: stages.filter(complete).map(s => s.name), remainingStages: stages.filter(s => !complete(s)).map(s => s.name),
    executionElapsedMs: run.metrics.elapsedMs, humanWaitingMs: (human.humanWaitingMs ?? 0) + (human.humanWaitStartedAt && Number.isFinite(Date.parse(human.humanWaitStartedAt)) ? Math.max(0, now - Date.parse(human.humanWaitStartedAt)) : 0),
    availableResults: deliveryProgress(run).availableResults, updatedAt: run.updatedAt };
}
function summary(job: LedgerJob, run: PptDeliveryRun | undefined, reviews: readonly HumanReviewRequest[], ledger: LedgerState, actorId: string): AcpTaskSummary {
  const attempt = ledger.attempts[job.currentAttemptId], review = latestReview(reviews, job), pending = review?.status === 'pending' && !terminal.has(job.executionStatus) && (!run || !terminal.has(run.executionStatus));
  const awaitingResume = review?.resume?.status === 'pending' && !terminal.has(job.executionStatus);
  const resumeError = awaitingResume ? run?.diagnostics?.findLast(item => item.startsWith('Human continuation deferred:')) : undefined;
  const displayStatus = pending ? 'awaiting_human' : awaitingResume && !resumeError ? 'resuming' : review?.status === 'changes_requested' && !terminal.has(job.executionStatus) ? 'changes_requested' : job.executionStatus;
  const phase = pending ? 'human_review' : awaitingResume ? 'human_resume' : run?.phase ?? attempt?.phase ?? job.purpose ?? '';
  const progressSummary = pending ? `${review.title}已形成，等待确认 ${review.revision}；通过后开始设计制作。`
    : awaitingResume ? resumeError ? `决定已保存，继续执行受阻：${resumeError.slice('Human continuation deferred:'.length).trim()}` : '本版决定已保存，等待系统继续处理。'
    : review?.status === 'changes_requested' && !terminal.has(job.executionStatus) ? run?.summaryRevisionPending ? '修改意见已保存，正在提交原作者。' : '修改意见已提交原作者，等待新版本。'
    : attempt?.diagnostic || (run ? runDescription(run) : attempt?.result?.resultSummary || stateDescriptions[job.executionStatus] || '等待同步执行进展。');
  return { sourceId: job.sourceId, jobId: job.jobId, title: job.title ?? `${purposeNames[job.purpose ?? ''] ?? '执行任务'} ${job.jobId.slice(0, 8)}`,
    originSessionId: job.originSessionId, ...(job.parentJobRef ? { parentJobRef: job.parentJobRef } : {}), ...(job.parentAttemptId ? { parentAttemptId: job.parentAttemptId } : {}),
    ...(job.purpose ? { purpose: job.purpose } : {}), targetId: job.targetId, currentAttemptId: job.currentAttemptId, executionStatus: job.executionStatus, displayStatus, phase,
    createdAt: job.createdAt, updatedAt: review && review.updatedAt > job.updatedAt ? review.updatedAt : job.updatedAt, stale: attempt?.stale ?? true,
    inFlightAttemptIds: [...job.inFlightAttemptIds], unresolvedAttemptIds: [...job.unresolvedAttemptIds],
    ...(review ? { reviewStatus: review.status } : {}), ...(pending && review.reviewerId === actorId ? { pendingReviewId: review.reviewId } : {}), progressSummary };
}

export function workbenchSnapshot(source: WorkbenchSource): WorkbenchSnapshot {
  const { ledger, actorId } = source, allowed = source.allowedOrigins ? new Set(source.allowedOrigins) : undefined;
  const jobs = Object.values(ledger.jobs).filter(job => !allowed || allowed.has(job.originSessionId));
  const visible = new Set(jobs.map(job => job.jobId)), runFor = (job: LedgerJob) => source.runs.find(run => run.jobId === job.jobId && run.attemptId === job.currentAttemptId);
  const summaries = new Map(jobs.map(job => [job.jobId, summary(job, runFor(job), source.reviews, ledger, actorId)]));
  const details: Record<string, AcpTaskDetail> = {};
  for (const job of jobs) {
    const run = runFor(job), ownReviews = source.reviews.filter(r => r.jobId === job.jobId || r.authorJobId === job.jobId && visible.has(r.jobId));
    const ancestors: AcpTaskSummary[] = [], visited = new Set([job.jobId]); let parent = job.parentJobRef;
    while (parent?.sourceId === ledger.sourceId && visible.has(parent.jobId) && !visited.has(parent.jobId)) {
      visited.add(parent.jobId); ancestors.unshift(summaries.get(parent.jobId)!); parent = ledger.jobs[parent.jobId]?.parentJobRef;
    }
    const children = jobs.filter(child => child.parentJobRef?.sourceId === ledger.sourceId && child.parentJobRef.jobId === job.jobId).map(child => summaries.get(child.jobId)!);
    const dependencies: WorkbenchDependency[] = children.map(child => ({ from: job.jobId, to: child.jobId, kind: 'parent', label: '子任务', parentAttemptId: child.parentAttemptId }));
    if (job.parentJobRef?.sourceId === ledger.sourceId && visible.has(job.parentJobRef.jobId)) dependencies.unshift({ from: job.parentJobRef.jobId, to: job.jobId, kind: 'parent', label: '子任务', parentAttemptId: job.parentAttemptId });
    for (const related of jobs.filter(item => item.jobId === job.jobId || item.parentJobRef?.jobId === job.jobId)) {
      if (related.replacesJobRef?.sourceId === ledger.sourceId && visible.has(related.replacesJobRef.jobId)) dependencies.push({ from: related.replacesJobRef.jobId, to: related.jobId, kind: 'replaces', label: '接替执行' });
    }
    // Only this explicit domain workflow supplies ordering. Parent refs alone never imply dependencies.
    if (run) {
      const last = (purpose: string) => [...run.children].reverse().find(item => item.purpose === purpose)?.child.jobId;
      const chain = [last('project_script'), last('ppt_production'), last('independent_review')].filter((id): id is string => Boolean(id && visible.has(id)));
      for (let index = 1; index < chain.length; index++) dependencies.push({ from: chain[index - 1]!, to: chain[index]!, kind: 'depends_on', label: '阶段依赖' });
    }
    const artifacts: AcpTaskDetail['artifacts'] = [];
    for (const item of [...(run?.artifactHistory ?? []), ...(run?.validation ? [{ revision: run.revision, validation: run.validation }] : [])]) {
      if (!artifacts.some(a => a.revision === `revision-${item.revision}` && a.digest === item.validation.artifactDigest)) artifacts.push({ revision: `revision-${item.revision}`, digest: item.validation.artifactDigest, artifacts: item.validation.artifacts.map(safeArtifact).filter(a => a !== undefined) });
    }
    const attempts = Object.values(ledger.attempts).filter(attempt => attempt.jobId === job.jobId).map(attemptView);
    if (!run) for (const attempt of attempts) if (attempt.result?.artifactLinks.length) artifacts.push({ revision: attempt.result.resultRevision ?? attempt.attemptId, digest: attempt.result.resultDigest, artifacts: attempt.result.artifactLinks });
    const humanEvents: LedgerEvent[] = ownReviews.flatMap(review => review.history.map((decision, index) => ({ eventId: decision.decisionId, sourceId: ledger.sourceId, sequence: -(index + 1), jobId: review.jobId,
      attemptId: review.attemptId, jobVersion: 0, type: `human_review.${decision.action}`, observedAt: decision.at,
      data: { reviewId: review.reviewId, revision: review.revision, actor: decision.actor, ...(decision.note ? { note: decision.note } : {}) } })));
    details[job.jobId] = { ...summaries.get(job.jobId)!, attempts, children, ancestors, progress: progress(job, run, source.reviews, ledger.attempts[job.currentAttemptId], source.now ?? Date.now()),
      reviews: ownReviews.map(review => {
        const ownerRun = source.runs.find(item => item.jobId === review.jobId && item.attemptId === review.attemptId);
        const resumeError = review.resume?.status === 'pending' ? ownerRun?.diagnostics?.findLast(item => item.startsWith('Human continuation deferred:')) : undefined;
        return { ...structuredClone(review), canReview: review.status === 'pending' && review.reviewerId === actorId && ledger.jobs[review.jobId]?.currentAttemptId === review.attemptId && !terminal.has(ledger.jobs[review.jobId]!.executionStatus)
          && !ownerRun?.cancellationRequestedAt && (!ownerRun || !terminal.has(ownerRun.executionStatus))
          && latestReview(source.reviews, ledger.jobs[review.jobId]!)?.reviewId === review.reviewId,
          ...(review.resume ? { resumeStatus: review.resume.status } : {}), ...(resumeError ? { resumeError: resumeError.slice('Human continuation deferred:'.length).trim() } : {}) };
      }),
      events: [...ledger.events.filter(event => event.jobId === job.jobId).map(eventView), ...humanEvents].sort((a, b) => a.observedAt.localeCompare(b.observedAt)), dependencies, artifacts };
  }
  return structuredClone({ sourceId: ledger.sourceId, tasks: byNewest([...summaries.values()]), details });
}

export function listWorkbenchTasks(snapshot: WorkbenchSnapshot, query: WorkbenchListQuery = {}) {
  const filter = query.filter ?? 'all', offset = Math.max(0, Math.trunc(query.offset ?? 0)), limit = Math.min(200, Math.max(1, Math.trunc(query.limit ?? 50)));
  const rootIds = new Set(snapshot.tasks.filter(task => !task.parentJobRef || !Object.hasOwn(snapshot.details, task.parentJobRef.jobId)).map(task => task.jobId));
  const isWorking = (task: AcpTaskSummary) => task.displayStatus === 'resuming' || !task.pendingReviewId && ['working', 'submitted', 'not_started'].includes(task.executionStatus);
  const isFailed = (task: AcpTaskSummary) => task.unresolvedAttemptIds.length > 0 || ['failed', 'rejected', 'unknown', 'auth_required', 'input_required'].includes(task.executionStatus) && !['awaiting_human', 'resuming'].includes(task.displayStatus);
  const roots = snapshot.tasks.filter(task => rootIds.has(task.jobId));
  const counts = { all: roots.length, pending: roots.filter(task => Boolean(task.pendingReviewId)).length, working: roots.filter(isWorking).length, failed: roots.filter(isFailed).length };
  const matches = snapshot.tasks.filter(task => filter === 'all' ? true : filter === 'pending' ? Boolean(task.pendingReviewId) : filter === 'working' ? isWorking(task) : isFailed(task));
  return { items: structuredClone(matches.slice(offset, offset + limit)), total: matches.length, counts, offset, limit };
}

export function getWorkbenchTask(snapshot: WorkbenchSnapshot, jobId: string): AcpTaskDetail {
  const detail = Object.hasOwn(snapshot.details, jobId) ? snapshot.details[jobId] : undefined;
  if (!detail) throw new Error('Task not found in authorized scope');
  return structuredClone(detail);
}
