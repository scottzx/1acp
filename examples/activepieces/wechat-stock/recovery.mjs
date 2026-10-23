import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, mkdir, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function freeze(path, bytes) {
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST' || sha(await readFile(path)) !== sha(bytes)) throw error; }
}

/** Read and preserve checkpoint bytes; no rendering, model call or rewrite of original outputs. */
export async function prepareRecovery(operation, view) {
  if (sha(await readFile(operation.article.sourcePath)) !== operation.article.sourceSha256
      || sha(await readFile(operation.frozenSourcePath)) !== operation.article.sourceSha256) throw new Error('Original or frozen source changed');
  const jobDirectory = dirname(operation.outputDirectory), contractPath = join(jobDirectory, 'contract.json');
  const contractBytes = await readFile(contractPath), contract = JSON.parse(contractBytes);
  if (contract.outputDirectory !== operation.outputDirectory || contract.sourceSha256 !== operation.article.sourceSha256
      || !view.contextId || !view.sessionId) throw new Error('Original contract/context required');
  const directory = join(jobDirectory, 'recovery', view.attemptId), backup = join(directory, 'files');
  await mkdir(backup, { recursive: true, mode: 0o700 });
  const files = [];
  for (const name of (await readdir(operation.outputDirectory)).sort()) {
    const file = join(operation.outputDirectory, name), info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error('Checkpoint contains a symbolic link');
    if (!info.isFile()) continue; // Per-task tool caches are retained in place, not copied as deliverables.
    const bytes = await readFile(file); await freeze(join(backup, name), bytes);
    files.push({ name, size: bytes.length, sha256: sha(bytes) });
  }
  const checkpointPath = join(directory, 'checkpoint.json');
  const checkpoint = { version: 1, jobId: view.jobId, attemptId: view.attemptId, taskId: view.taskId,
    contextId: view.contextId, sessionId: view.sessionId, outputDirectory: operation.outputDirectory,
    contractPath, contractSha256: sha(contractBytes), sourceSha256: operation.article.sourceSha256,
    files, missing: [...contract.requiredFiles, 'artifact-manifest.json'].filter(name => !files.some(f => f.name === name)) };
  await freeze(checkpointPath, Buffer.from(JSON.stringify(checkpoint, null, 2) + '\n'));
  const prompt = `恢复原任务 ${view.jobId}，这是宿主重启后的断点续跑，禁止从头制作。原会话、技能锁、合同、源文件及输出目录全部沿用。\n` +
    `先读取只读断点清单 ${checkpointPath}（包含已有文件大小、SHA256与缺项；备份在同目录files/）。` +
    `逐项复用已有产物，不得清空目录，不得因续跑而重生成已有正文、封面、截图或改写已通过的报告；只补缺失或确实不合格的文件。` +
    `已有验收报告与截图摘要仍匹配时直接沿用，不重复截图或读图；缺少有效视觉验收时才按原合同实际读图补报告。` +
    `README记录复用文件与必要补项。若全部必交文件已有效，仅补最终交付及宿主产物回执。` +
    `注意第二/三/四章互相独立，不处理已完成的导论、第一章或其他篇目，不写飞书，不改宿主或技能。\n` +
    `原任务约束继续有效，下面的制作步骤仅用于缺失或不合格部分：\n${operation.request.input.prompt}\n` +
    `再次强调：已有合格文件直接复用，禁止整包重做。最终使用同一个 artifact-manifest.json 交付。`;
  return { pending: true, checkpointPath, preservedFiles: files.length,
    previousJob: { jobId: view.jobId, attemptId: view.attemptId, taskId: view.taskId, contextId: view.contextId, sessionId: view.sessionId },
    request: { originSessionId: operation.request.originSessionId, jobId: view.jobId,
      clientRequestId: `wechat-recover:${operation.key}:${view.attemptId}`,
      input: { ...operation.request.input, prompt,
        preflight: { ...operation.request.input.preflight,
          requiredFiles: [...operation.request.input.preflight.requiredFiles, checkpointPath] } } } };
}
