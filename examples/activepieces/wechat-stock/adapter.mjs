import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath, lstat } from 'node:fs/promises';
import { basename, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from './bridge.mjs';

const requiredFiles = ['source.md', 'metadata.json', 'series.json', 'article.html', 'article.wechat.html', 'cover.png', 'cover.svg',
  'cover.html', 'footer.html', 'series-nav.html', 'verification.json', 'visual-qa.json', 'qa-mobile.png', 'qa-footer.png', 'README.md'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function frozenFile(path, bytes) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  try { await writeFile(path, value, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST' || sha(await readFile(path)) !== sha(value)) throw error; }
}
const within = (root, path) => { const rel = relative(root, path); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel); };
export async function verifyDelivery(operation, view, artifactRoot) {
  const metadata = view.resultMetadata;
  const attemptId = view.attemptId ?? view.currentAttemptId;
  const resultRevision = view.resultRevision ?? view.result?.resultRevision, resultDigest = view.resultDigest ?? view.result?.resultDigest;
  if (!metadata || metadata.producer !== '1agents/a2a-host' || metadata.outcome !== 'completed'
      || metadata.taskId !== view.taskId || metadata.roleId !== 'wechat-series-editor' || !metadata.roleSkills?.lockPath
      || !view.jobId || !attemptId || !resultRevision || !/^[a-f0-9]{64}$/.test(resultDigest)
      || (operation.job && (operation.job.jobId !== view.jobId || operation.job.attemptId !== attemptId))
      || metadata.validation?.status !== 'passed' || !Array.isArray(metadata.artifacts)) throw new Error('Missing verified host identity, skill lock or artifact receipt');
  const root = await realpath(operation.outputDirectory), files = new Map();
  if (sha(await readFile(operation.article.sourcePath)) !== operation.article.sourceSha256) throw new Error('Original source changed before delivery');
  if (operation.frozenSourcePath && sha(await readFile(operation.frozenSourcePath)) !== operation.article.sourceSha256) throw new Error('Frozen input changed before delivery');
  for (const item of metadata.artifacts) {
    const actual = await realpath(item.path);
    if (!within(root, actual) || (await lstat(item.path)).isSymbolicLink()) throw new Error('Artifact escapes the admitted output directory');
    const bytes = await readFile(actual);
    if (bytes.length !== item.size || sha(bytes) !== item.sha256) throw new Error('Artifact bytes differ from host receipt');
    const name = basename(actual);
    if (requiredFiles.includes(name)) {
      if (actual !== join(root, name) || files.has(name)) throw new Error('Ambiguous required artifact');
      files.set(name, { bytes, sha256: item.sha256, size: item.size, mediaType: item.mediaType });
    }
  }
  if (requiredFiles.some(name => !files.has(name))) throw new Error('Required article package file is absent');
  const parse = name => JSON.parse(files.get(name).bytes.toString('utf8'));
  const verification = parse('verification.json'), visual = parse('visual-qa.json'), article = parse('metadata.json');
  // Older editor deliveries named the WeChat HTML hash "article_sha256" without an article_file field.
  const reviewedFile = visual.article_file ?? ['article.html', 'article.wechat.html'].find(name => visual.article_sha256 === files.get(name).sha256);
  const evidenceNames = ['cover.png', 'qa-mobile.png', 'qa-footer.png'];
  // Accept the existing host-frozen report shape only when it explicitly records
  // actual view_image review and binds every required screenshot to its bytes.
  const legacyTool = typeof visual.reviewer === 'string' && /\bview_image\b/.test(visual.reviewer)
    && /实际读图/.test(visual.reviewer)
    && evidenceNames.every(name => visual.evidence_sha256?.[name] === files.get(name).sha256);
  const inspectionTool = typeof visual.inspection_tool === 'string' && visual.inspection_tool.trim()
    ? visual.inspection_tool : legacyTool ? 'view_image' : null;
  if (sha(files.get('source.md').bytes) !== operation.article.sourceSha256
      || verification.source_sha256 !== operation.article.sourceSha256 || verification.snapshot_sha256 !== operation.article.sourceSha256
      || verification.source_file_unchanged !== true || verification.snapshot_byte_identical !== true || verification.visible_text_equal !== true
      || verification.cover_exact_16_9 !== true || JSON.stringify(verification.cover_size) !== '[1920,1080]'
      || verification.mobile_no_horizontal_overflow !== true || Object.keys(verification.remaining_placeholders ?? { missing: true }).length
      || visual.status !== 'passed' || !inspectionTool || !['article.html', 'article.wechat.html'].includes(reviewedFile)
      || visual.article_sha256 !== files.get(reviewedFile).sha256
      || !evidenceNames.every(name => visual.evidence?.includes(name))) throw new Error('Package verification or visual report failed');
  const title = article.title ?? article.publish_title, summary = article.summary;
  if (typeof title !== 'string' || !title.trim() || typeof summary !== 'string' || !summary.trim() || [...summary].length > 100) throw new Error('Invalid publishing title or summary');
  const receipts = Object.fromEntries([...files].map(([name, value]) => [name, { sha256: value.sha256, size: value.size, mediaType: value.mediaType }]));
  const destination = join(artifactRoot, operation.key); await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const [name, value] of files) {
    try { await writeFile(join(destination, name), value.bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST' || sha(await readFile(join(destination, name))) !== value.sha256) throw error; }
  }
  return { title, summary, receipts, packageDigest: digest(receipts), artifactDirectory: destination, reviewedFile,
    visualReview: { inspectionTool, toolSource: visual.inspection_tool ? 'inspection_tool' : 'legacy-reviewer-and-evidence-hashes' },
    resultRevision, resultDigest, sourceId: view.sourceId, jobId: view.jobId, attemptId, taskId: view.taskId, remote: view.remote };
}

export async function createWorkbenchAdapter(config) {
  const load = file => import(pathToFileURL(join(config.workbenchRoot, 'src', file)).href);
  const [{ SopWorkbench, assetApproved }, { readState }, { frozenReportSource, stockNotePrefix }] = await Promise.all([load('sop.js'), load('store.js'), load('frozen-report.js')]);
  const workbench = new SopWorkbench(config.workbenchHome);
  async function gateway(method, params) {
    const response = await fetch(config.gatewayUrl + '/invoke', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90_000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
    const value = await response.json(); if (!response.ok || value.error) throw new Error(String(value.error ?? 'Gateway call failed')); return value;
  }
  let cached;
  async function facts() {
    const view = await workbench.view(), state = view.state;
    if (state.mode !== 'feishu' || !state.ready) throw new Error('A complete real Feishu workbench is required');
    if (config.accountId && !state.data.accounts.some(row => row.id === config.accountId && !row.sample && row.platform === '微信公众号' && !['暂停', '归档'].includes(row.status))) throw new Error('Configured WeChat account is unavailable');
    cached = { complete: true, stale: false, data: state.data,
      digest: digest(Object.fromEntries(['assets', 'publications', 'accounts'].map(kind => [kind,
        [...state.data[kind]].sort((a, b) => a.id.localeCompare(b.id))]))) };
    return cached;
  }
  const adapter = {
    async readFacts() { await workbench.sync(); return facts(); },
    async cachedFacts() { return facts(); },
    async prepare(article, key) {
      const bytes = await readFile(article.sourcePath);
      if (sha(bytes) !== article.sourceSha256) throw new Error('Frozen report source changed; explicit revision required');
      const jobDirectory = join(config.jobRoot, key), inputDirectory = join(jobDirectory, 'input'), outputDirectory = join(jobDirectory, 'output');
      await mkdir(inputDirectory, { recursive: true, mode: 0o700 }); await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
      await frozenFile(join(inputDirectory, 'source.md'), bytes);
      const series = JSON.parse(await readFile(config.seriesPath, 'utf8'));
      await frozenFile(join(inputDirectory, 'series.json'), JSON.stringify(series, null, 2) + '\n');
      const contract = { schemaVersion: 1, jobId: `wechat-stock:${key}`, roleId: 'wechat-series-editor', article,
        approvalRef: config.approvalRef, sourcePolicy: 'zero-rewrite', sourcePath: article.sourcePath, frozenSource: join(inputDirectory, 'source.md'),
        sourceSha256: article.sourceSha256, seriesPath: join(inputDirectory, 'series.json'), outputDirectory,
        navigation: { previous: article.previous ?? null, next: article.next ?? null },
        requiredFiles, summaryMaxCharacters: 100, coverSize: [1920, 1080], preserveOriginal: true };
      const contractPath = join(jobDirectory, 'contract.json'); await frozenFile(contractPath, JSON.stringify(contract, null, 2) + '\n');
      const prompt = `按合同制作公众号系列第${String(article.issue).padStart(3, '0')}期完整发布包。合同：${contractPath}。\n` +
        `先读宿主注入的本任务完整技能及配套脚本，记录真实cwd。原文已定稿且用户授权直接封装，原文件及冻结副本SHA256均为${article.sourceSha256}，两者零改写。` +
        `原文源标题、元信息、导航、正文和参考资料全部保留，新增标题、百字内摘要和系列策展说明放独立区域。渲染--source用报告根目录内原文件，不误用冻结副本作为相对链接根。` +
        `使用合同series与前后篇真实报告链接，未发布篇目标明原报告，不虚构公众号URL、联系方式或发布日期。封面1920×1080，墨绿/米白/老金三册书脊，保留SVG/HTML。` +
        `仅写${outputDirectory}，不得修改报告原文、冻结输入、技能缓存或宿主。按技能生成${requiredFiles.join('、')}与手机截图，读取verification通过后，使用真正可用的读图工具查看cover.png、qa-mobile.png、qa-footer.png，保存visual-qa.json，article_file明确为article.wechat.html，article_sha256绑定该最终文件SHA256。` +
        `visual-qa.json必须包含status、inspection_tool（实际使用的读图工具名称）、reviewer、evidence（截图文件名数组）、evidence_sha256（对应截图SHA256）、article_file与article_sha256；不得省略inspection_tool或用文字备注替代实际读图。` +
        `输出artifact-manifest.json，严格{\"artifacts\":[{\"path\":\"最终文件绝对路径\",\"mediaType\":\"真实MIME\"}]}；覆盖所有必交文件与截图，只列本任务实际最终文件，不填size/hash或虚构HTTP URL。` +
        `最后复核源文件/冻结副本未变，README给出标题摘要、锁版本与校验结论。网关负责通知，不替上游ack，不写飞书，不登录上传或群发公众号。`;
      return { outputDirectory, frozenSourcePath: join(inputDirectory, 'source.md'), request: { originSessionId: `wechat-stock:${key}`, targetId: 'wechat-series-editor', clientRequestId: `wechat-stock:${key}`,
        title: `公众号补库 ${String(article.issue).padStart(3, '0')}：${article.title}`,
        input: { prompt, preflight: { jobDirectory: outputDirectory, requiredFiles: [article.sourcePath, contractPath, join(inputDirectory, 'source.md')] },
          // This is the stable business contract ID, explicitly caller-declared by the existing result contract schema.
          resultContract: { jobId: contract.jobId, artifactManifestPath: join(outputDirectory, 'artifact-manifest.json') } } } };
    },
    async submit(operation) { return gateway('execution_submit', operation.request); },
    async get(operation) { return gateway('execution_get', { originSessionId: operation.request.originSessionId, jobId: operation.job.jobId }); },
    async verify(operation, view) { return verifyDelivery(operation, view, config.artifactRoot); },
    async ingest(operation, observed) {
      const delivery = operation.delivery;
      const note = stockNotePrefix + JSON.stringify({ version: 1, kind: 'frozen-report-package', poolId: config.policy.scopeId,
        articleKey: operation.article.articleKey, operationKey: operation.key, sourceSha256: operation.article.sourceSha256,
        packageDigest: delivery.packageDigest, sourceApproval: 'direct-original', approvalRef: config.approvalRef });
      const current = await facts();
      const matches = current.data.assets.filter(row => frozenReportSource(row)?.operationKey === operation.key);
      if (matches.length > 1) throw new Error('Multiple assets share the production key');
      let asset = matches[0];
      if (asset && frozenReportSource(asset).packageDigest !== delivery.packageDigest) throw new Error('Existing asset has a different package version');
      if (!asset) {
        const old = await readState(config.workbenchHome), previous = old.sop?.operations?.[`stock:${operation.key}:create`];
        if (previous && previous.status !== 'done' && !previous.recordId) throw new Error('Previous cloud asset creation remains unknown; inspect the original operation');
        asset = await workbench.save({ kind: 'assets', requestId: `stock:${operation.key}:create`, row: {
          title: operation.article.title, topicIds: [], format: '长文章', publishTitle: delivery.title,
          body: delivery.summary, draftUrl: `${config.publicBaseUrl}/artifacts/${operation.key}/article.html`,
          fileUrl: `${config.publicBaseUrl}/artifacts/${operation.key}/article.wechat.html`, note, sample: false } });
      }
      if (asset.reviewStatus === '未提交') asset = await workbench.review({ kind: 'assets', id: asset.id, stage: 'asset', decision: 'submit',
        etag: asset.etag, requestId: `stock:${operation.key}:submit` });
      if (!['待审核', '通过'].includes(asset.reviewStatus)) throw new Error('Asset is not awaiting or accepted by human review');
      const refreshed = await facts(); observed.data = refreshed.data; observed.digest = refreshed.digest;
      return Object.fromEntries(['id', 'version', 'versionGroup', 'format', 'publishTitle', 'body', 'draftUrl', 'fileUrl'].map(key => [key, asset[key]]));
    },
    assetStatus(operation, observed) {
      const data = observed.data, asset = data.assets.find(row => row.id === operation.asset.id);
      if (!asset || asset.sample || frozenReportSource(asset)?.packageDigest !== operation.delivery.packageDigest
          || ['version', 'format', 'publishTitle', 'body', 'draftUrl', 'fileUrl'].some(key => asset[key] !== operation.asset[key])
          || data.assets.some(row => row.versionGroup === asset.versionGroup && row.version > asset.version)) return 'conflict';
      if (data.publications.some(row => !row.sample && row.assetIds?.includes(asset.id)
          && row.accountIds?.length === 1 && row.url && row.date
          && (!config.accountId || row.accountIds.includes(config.accountId)) && ['已发布', '已下架'].includes(row.status))) return 'published';
      if (asset.reviewStatus === '需修改') return 'changes_requested';
      return assetApproved(asset, data) ? 'ready' : 'pending_review';
    },
    async acceptAndAcknowledge(operation) {
      if (operation.seed) return;
      const identity = { originSessionId: operation.request.originSessionId, jobId: operation.job.jobId };
      const view = await gateway('execution_get', identity);
      if ((view.resultRevision ?? view.result?.resultRevision) !== operation.delivery.resultRevision
          || (view.resultDigest ?? view.result?.resultDigest) !== operation.delivery.resultDigest) throw new Error('Result changed before technical acceptance');
      await gateway('execution_review', { ...identity, attemptId: operation.delivery.attemptId,
        resultRevision: operation.delivery.resultRevision, resultDigest: operation.delivery.resultDigest,
        reviewStatus: 'accepted', note: '机器文件与制作报告验收通过；已登记成品待人工审核，不代表成品人工通过。' });
      const inbox = await gateway('remote_agent_inbox', { originSessionId: identity.originSessionId });
      for (const notice of inbox.notices ?? []) if (notice.taskId === operation.delivery.taskId) {
        await gateway('remote_agent_ack', { originSessionId: identity.originSessionId, noticeId: notice.noticeId });
      }
    },
    gateway,
  };
  return adapter;
}
