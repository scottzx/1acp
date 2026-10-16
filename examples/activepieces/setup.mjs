/**
 * Create two Activepieces flows through its already-connected native MCP.
 * Run on the DreamMate/Activepieces host. Tokens are read from a private env
 * file; the privileged automation token never enters a flow definition.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const configPath = process.argv[2];
if (!configPath) throw new Error('Usage: node setup.mjs /absolute/private/activepieces.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const env = Object.fromEntries(readFileSync(config.envFile, 'utf8').split('\n')
  .filter(line => /^[A-Z_]+=/.test(line)).map(line => {
    const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1).trim()];
  }));
if (!env.ACP_NOTIFICATION_TOKEN || !config.connectionExternalId) throw new Error('Missing notification environment or encrypted connection ID');
const receiptFile = resolve(config.receiptFile);
mkdirSync(dirname(receiptFile), { recursive: true, mode: 0o700 });
const receipt = existsSync(receiptFile) ? JSON.parse(readFileSync(receiptFile, 'utf8')) : {};
const save = () => writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
const redact = text => String(text).replaceAll(env.ACP_NOTIFICATION_TOKEN, '[redacted]');
async function mcp(name, params) {
  const response = await fetch((config.nodeUrl ?? 'http://127.0.0.1:36908') + '/services/mcp-activepieces/invoke', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'mcp-activepieces.' + name, params }), signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  if (!response.ok || result.isError) throw new Error(redact(JSON.stringify(result)));
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
  try { return JSON.parse(text); } catch { return { text }; }
}
function idOf(result) {
  const id = result.flowId ?? result.id ?? result.flow?.id ?? result.flow?.flowId;
  if (typeof id === 'string') return id;
  throw new Error('No flow ID returned; result keys: ' + Object.keys(result).join(','));
}
function code(fn) { return 'export const code = ' + fn.toString() + ';'; }

// Persist the occurrence and processor ID in a separate step before any
// network operation. Step retries reuse these outputs.
const prepareDispatch = code(async function(inputs) {
  const timestamp = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  return { scheduleId: inputs.scheduleId, scheduledFor: timestamp, prompt: inputs.prompt };
});

const prepareResult = code(async function(inputs) {
  const notice = inputs.notice;
  if (!notice || typeof notice.noticeId !== 'string' || typeof notice.originSessionId !== 'string') throw new Error('Invalid completion notice');
  return { noticeId: notice.noticeId, originSessionId: notice.originSessionId,
    processorId: 'activepieces:' + Date.now() + ':' + Math.random().toString(36).slice(2) };
});

// Activepieces persists this successful step output before the following ACK.
// Replace this step with an idempotent business write for a production recipe.
const saveReport = code(async function(inputs) {
  const claim = inputs.claim;
  if (!claim.claimed) return { processed: false, reason: claim.reason, runId: claim.runId };
  return { processed: true, receivedAt: new Date().toISOString(), runId: claim.runId,
    taskId: claim.notice.taskId, state: claim.notice.state, report: claim.notice.result, receipt: inputs.receipt };
});

const codeStep = (displayName, sourceCode, input) => ({
  type: 'CODE', displayName, sourceCode, input, continueOnFailure: false, retryOnFailure: false,
});

const pieceStep = (displayName, actionName, input) => ({
  type: 'PIECE', displayName, pieceName: '@1agents/piece-acp-automation', actionName, input,
  auth: config.connectionExternalId, continueOnFailure: false, retryOnFailure: false,
});

const names = {
  result: (config.flowNamePrefix ?? '1acp') + ' · 结果回传',
  dispatch: (config.flowNamePrefix ?? '1acp') + ' · 定时派发',
};
const flows = await mcp('ap_list_flows', { limit: 500 });
if (!receipt.resultFlowId && flows.flows?.some(flow => [names.result, names.dispatch].includes(flow.displayName ?? flow.name))) {
  throw new Error('Named flows already exist; restore the private receipt instead of creating duplicates');
}
if (!receipt.resultFlowId) {
  const built = await mcp('ap_build_flow', {
    flowName: names.result,
    trigger: { pieceName: '@activepieces/piece-webhook', triggerName: 'catch_webhook',
      input: { authType: 'header', authFields: { headerName: 'Authorization', headerValue: 'Bearer ' + env.ACP_NOTIFICATION_TOKEN } } },
    steps: [
      codeStep('准备通知处理编号', prepareResult, { notice: "{{trigger['output'].body}}" }),
      pieceStep('认领任务结果', 'claim_notice', { noticeId: "{{step_1['output'].noticeId}}", originSessionId: "{{step_1['output'].originSessionId}}", processorId: "{{step_1['output'].processorId}}" }),
      codeStep('保存智能体报告', saveReport, { claim: "{{step_2['output']}}", receipt: "{{step_1['output']}}" }),
      pieceStep('确认结果已处理', 'acknowledge_notice', { noticeId: "{{step_1['output'].noticeId}}", originSessionId: "{{step_1['output'].originSessionId}}", processorId: "{{step_1['output'].processorId}}", processed: "{{step_3['output'].processed}}" }),
    ],
  });
  receipt.resultFlowId = idOf(built);
  receipt.resultWebhookUrl = built.webhookUrl ?? new URL('/api/v1/webhooks/' + receipt.resultFlowId, config.activepiecesUrl).href;
  save();
}
if (!receipt.resultPublished) {
  await mcp('ap_lock_and_publish', { flowId: receipt.resultFlowId }); receipt.resultPublished = true; save();
}
if (!receipt.dispatchFlowId) {
  const built = await mcp('ap_build_flow', {
    flowName: names.dispatch,
    trigger: { pieceName: '@activepieces/piece-schedule', triggerName: 'cron_expression',
      input: { cronExpression: config.cronExpression ?? '0 9 * * *', timezone: 'Asia/Shanghai' } },
    steps: [
      codeStep('固定本次计划批次', prepareDispatch, { scheduleId: config.scheduleId, prompt: config.prompt }),
      pieceStep('派发智能体任务', 'dispatch_run', { scheduleId: "{{step_1['output'].scheduleId}}", scheduledFor: "{{step_1['output'].scheduledFor}}", prompt: "{{step_1['output'].prompt}}" }),
    ],
  });
  receipt.dispatchFlowId = idOf(built); save();
}
// Publishing the dispatch flow is separate so the gateway can first be
// configured with the newly-created result webhook URL.
if (process.argv.includes('--publish-dispatch') && !receipt.dispatchPublished) {
  await mcp('ap_lock_and_publish', { flowId: receipt.dispatchFlowId }); receipt.dispatchPublished = true; save();
}
console.log(JSON.stringify({ resultFlowId: receipt.resultFlowId, dispatchFlowId: receipt.dispatchFlowId,
  resultPublished: receipt.resultPublished, dispatchPublished: Boolean(receipt.dispatchPublished) }, null, 2));
