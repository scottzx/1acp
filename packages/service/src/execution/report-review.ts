/** A temporary author, a deterministic file check, and a final human gate. No model reviewer. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createHumanReview, markHumanReviewApplied, type HumanReviewRequest } from './human-review.js';
import type { LedgerAttempt } from './ledger.js';

const absolute = z.string().min(1).refine(path.isAbsolute, 'Expected an absolute path');
export const reportReviewPolicySchema = z.object({
  workspaceRoot: absolute, allowedProjectRoots: z.array(absolute).min(1),
  allowedRemotes: z.array(z.string().min(1)).min(1),
}).strict();
export const reportReviewInputSchema = z.object({
  fileName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}\.md$/).default('architecture-report.md'),
}).strict();
export type ReportReviewPolicy = z.infer<typeof reportReviewPolicySchema>;
export interface ReportReviewRun {
  sourceId: string; jobId: string; attemptId: string; originSessionId: string; title: string;
  targetId: string; remote: string; cwd: string; authorInput: Record<string, unknown>;
  directory: string; reportPath: string; revision: number; reviewerId: string;
  stage: 'research' | 'file_check' | 'human_review' | 'finished'; phase: string;
  executionStatus: 'working' | 'input_required' | 'completed' | 'failed' | 'canceled';
  child?: { jobId: string; attemptId: string }; humanReviews: HumanReviewRequest[];
  digest?: string; snapshotPath?: string; fileCheck?: { passed: boolean; path: string; checkedAt: string; size?: number; sha256?: string; error?: string };
  resultSummary?: string; createdAt: string; updatedAt: string;
}
export interface ReportReviewAdapter {
  persist(run: ReportReviewRun): void;
  submit(run: ReportReviewRun, prompt: string, previous?: ReportReviewRun['child']): Promise<ReportReviewRun['child']>;
  child(attemptId: string): LedgerAttempt;
  update(run: ReportReviewRun): void;
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const terminal = new Set(['completed', 'failed', 'canceled', 'rejected']);
export const reportRevision = (run: ReportReviewRun) => `report-v${run.revision}`;
function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
export async function createReportReviewRun(input: Pick<ReportReviewRun, 'sourceId' | 'jobId' | 'attemptId' | 'originSessionId' | 'title' | 'targetId' | 'remote' | 'cwd' | 'authorInput' | 'reviewerId'>,
  policy: ReportReviewPolicy, report: z.input<typeof reportReviewInputSchema>): Promise<ReportReviewRun> {
  if (!policy.allowedRemotes.includes(input.remote)) throw new Error('Report checks require an explicitly configured shared-filesystem remote');
  const cwd = await realpath(input.cwd), roots = await Promise.all(policy.allowedProjectRoots.map(root => realpath(root)));
  if (!roots.some(root => within(root, cwd))) throw new Error('Report project is outside allowedProjectRoots');
  const { fileName } = reportReviewInputSchema.parse(report);
  await mkdir(policy.workspaceRoot, { recursive: true });
  const workspace = await realpath(policy.workspaceRoot);
  const directory = path.join(workspace, input.jobId, input.attemptId);
  await mkdir(directory, { recursive: true });
  if (!within(workspace, await realpath(directory))) throw new Error('Report output escaped its workspace');
  const version = path.join(directory, 'report-v1'); await mkdir(version);
  const at = new Date().toISOString();
  return { ...input, cwd, directory, reportPath: path.join(version, fileName), revision: 1,
    stage: 'research', phase: 'author_pending', executionStatus: 'working', humanReviews: [], createdAt: at, updatedAt: at };
}
/** Read bounded regular bytes without following symlinks or accepting linked aliases. */
export async function readReportFile(file: string): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size === 0 || stat.size > 256 * 1024) throw new Error('Expected a nonempty regular Markdown report of at most 256 KiB');
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw new Error('Report changed during file check');
    const result = bytes.subarray(0, bytesRead);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(result);
    if (!text.trim()) throw new Error('Report is empty');
    return result;
  } finally { await handle.close(); }
}
export async function reportBindingDigest(run: ReportReviewRun): Promise<string> {
  if (!run.snapshotPath) throw new Error('Report snapshot is unavailable');
  const bytes = await readReportFile(run.reportPath), snapshot = await readReportFile(run.snapshotPath);
  if (hash(bytes) !== hash(snapshot)) throw new Error('Report bytes differ from the reviewed snapshot');
  return hash(snapshot);
}
function authorPrompt(run: ReportReviewRun, feedback?: string): string {
  return `${String(run.authorInput.prompt)}\n\n任务源目录（只读）：${run.cwd}。当前执行工作区为 ${run.directory}，先记录真实 pwd。\n仅将任务要求的 Markdown 产物写入 ${run.reportPath}。语言与内容按任务说明执行。不得修改源目录、安装依赖、启动服务或创建其他任务。\n${feedback ? `这是同一任务的修订，保留旧版；用户意见：${feedback}\n` : ''}写入完成后立即结束。协调器检查文件，用户做最终确认。`;
}

export async function advanceReportReview(run: ReportReviewRun, adapter: ReportReviewAdapter): Promise<void> {
  const save = () => { run.updatedAt = new Date().toISOString(); adapter.persist(run); adapter.update(run); };
  if (terminal.has(run.executionStatus)) { adapter.update(run); return; }
  const review = run.humanReviews.at(-1), decision = review?.resume;
  if (decision?.status === 'pending') {
    if (decision.action === 'approve') {
      if (await reportBindingDigest(run) !== review!.digest) throw new Error('Approved report version changed');
      run.executionStatus = 'completed'; run.stage = 'finished'; run.phase = 'human_approved';
      run.resultSummary = `人工已通过 ${reportRevision(run)}。报告：${run.reportPath}`;
    } else if (decision.action === 'cancel') {
      run.executionStatus = 'canceled'; run.phase = 'human_canceled'; run.resultSummary = '用户已放弃报告任务，保留产物与审核历史。';
    } else {
      run.revision++;
      const version = path.join(run.directory, reportRevision(run)); await mkdir(version, { recursive: true });
      run.reportPath = path.join(version, path.basename(run.reportPath));
      delete run.digest; delete run.snapshotPath; delete run.fileCheck;
      run.executionStatus = 'working'; run.stage = 'research'; run.phase = 'revision_pending';
    }
    run.humanReviews[run.humanReviews.length - 1] = markHumanReviewApplied(review!, decision.decisionId);
    save();
  }
  if (run.executionStatus !== 'working') return;
  if (run.phase === 'author_pending' || run.phase === 'revision_pending') {
    const feedback = run.phase === 'revision_pending' ? review?.history.at(-1)?.note : undefined;
    // The stable submission key allows recovery after an accepted-but-unrecorded child receipt.
    run.child = await adapter.submit(run, authorPrompt(run, feedback), feedback ? run.child : undefined);
    run.phase = 'author_running'; save();
  }
  if (!run.child) throw new Error('Report child has no durable receipt');
  const child = adapter.child(run.child.attemptId);
  if (child.submissionStatus === 'submission_unknown' || child.submissionStatus === 'dispatching') {
    run.executionStatus = 'input_required'; run.phase = 'child_admission_unknown'; run.resultSummary = '临时任务受理未知，停止重派，等待核对。'; save(); return;
  }
  if (!terminal.has(child.executionStatus)) return;
  if (child.executionStatus !== 'completed') {
    run.executionStatus = 'failed'; run.phase = 'author_failed'; run.resultSummary = '临时分析任务未完成，请查看子任务。'; save(); return;
  }
  run.stage = 'file_check'; run.phase = 'checking_report'; save();
  try {
    if (await realpath(path.dirname(run.reportPath)) !== path.dirname(run.reportPath)) throw new Error('Report directory is not the assigned directory');
    const bytes = await readReportFile(run.reportPath), sha256 = hash(bytes);
    const snapshotPath = path.join(run.directory, `${reportRevision(run)}.review-snapshot.md`);
    try { await writeFile(snapshotPath, bytes, { flag: 'wx', mode: 0o400 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || hash(await readReportFile(snapshotPath)) !== sha256) throw error; }
    run.fileCheck = { passed: true, path: run.reportPath, checkedAt: new Date().toISOString(), size: bytes.length, sha256 };
    run.digest = sha256; run.snapshotPath = snapshotPath;
    run.humanReviews.push(createHumanReview({ jobId: run.jobId, attemptId: run.attemptId, stage: 'report',
      authorJobId: run.child.jobId, authorAttemptId: run.child.attemptId,
      authorSessionId: String(child.backendRunRef?.sessionId ?? run.child.attemptId), reviewerId: run.reviewerId,
      revision: reportRevision(run), digest: sha256, title: run.title,
      preview: { kind: 'markdown', title: run.title, markdown: bytes.toString('utf8'), reportPath: run.reportPath, slides: [] } }));
    run.stage = 'human_review'; run.phase = 'awaiting_human'; run.executionStatus = 'input_required';
    run.resultSummary = `报告文件检查通过，等待你确认 ${reportRevision(run)}。人工通过后任务才算完成。`;
  } catch (error) {
    run.fileCheck = { passed: false, path: run.reportPath, checkedAt: new Date().toISOString(), error: error instanceof Error ? error.message : 'Report check failed' };
    run.executionStatus = 'failed'; run.phase = 'file_check_failed'; run.resultSummary = '指定报告文件检查未通过，未进入人工审核。';
  }
  save();
}
