/** Run on the WSL deployment host after the historical test completes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const privateDirectory = path.dirname(config.receiptFile);
const receipt = JSON.parse(fs.readFileSync(config.receiptFile, 'utf8'));
const gateway = JSON.parse(fs.readFileSync(path.join(privateDirectory, 'gateway.json'), 'utf8'));
const stateFile = path.join(gateway.stateDirectory, 'automation.json');
let ledger = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const scheduledFor = new Date(config.scheduledFor).toISOString();
const savedRun = ledger.runs.find(run => run.scheduleId === config.scheduleId && run.scheduledFor === scheduledFor);
assert(savedRun, 'Scheduled occurrence missing');
const response = await fetch(`http://127.0.0.1:36815/automation/runs/${savedRun.runId}`, {
  headers: { Authorization: `Bearer ${gateway.automation.token}` }, signal: AbortSignal.timeout(20_000),
});
assert(response.ok, 'Could not refresh automation run');
const refreshed = await response.json();
const run = refreshed.run ?? refreshed;
assert.equal(run.status, 'completed');
assert.equal(run.state, 'TASK_STATE_COMPLETED');
ledger = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const processing = ledger.notices.find(notice => notice.runId === run.runId);
assert(processing?.businessCompletedAt && processing?.gatewayAcknowledgedAt, 'Business acknowledgement missing');
const report = run.result ?? processing.notice.result;
assert(report.includes(config.reportDate));
assert(!report.includes('ONEACP_DAILY_PROGRESS_ONLY'));
const facts = JSON.parse(run.prompt.split('\n\n').at(-1));

async function mcp(name, params) {
  const response = await fetch('http://127.0.0.1:36908/services/mcp-activepieces/invoke', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: `mcp-activepieces.${name}`, params }), signal: AbortSignal.timeout(45_000),
  });
  const result = await response.json();
  assert(response.ok && !result.isError, `Activepieces ${name} failed`);
  if (result.structuredContent) return result.structuredContent;
  return JSON.parse(result.content.filter(item => item.type === 'text').map(item => item.text).join('\n'));
}
const dispatch = await mcp('ap_get_run', { flowRunId: run.flowRunId });
assert.equal(dispatch.status, 'SUCCEEDED');
const flows = await mcp('ap_list_flows', { name: config.flowPrefix ?? `${config.projectLabel ?? config.repo} 日报测试`, limit: 50 });
const dispatchFlow = flows.flows.find(flow => (flow.id ?? flow.flowId) === receipt.dispatchFlowId);
assert.equal(dispatchFlow?.status, 'DISABLED', 'The historical test must not become a recurring schedule');
const candidates = await mcp('ap_list_runs', { flowId: receipt.resultFlowId, environment: 'PRODUCTION', limit: 10 });
let resultRun;
for (const candidate of candidates.runs) {
  if (candidate.status !== 'SUCCEEDED') continue;
  const full = await mcp('ap_get_run', { flowRunId: candidate.id });
  const ack = full.steps.find(step => step.name === 'step_5')?.output;
  if (ack?.runId === run.runId && ack?.noticeId === processing.noticeId) { resultRun = full; break; }
}
assert(resultRun, 'Matching successful result flow missing');
const output = name => resultRun.steps.find(step => step.name === name)?.output;
const erpResult = output('step_4');
assert.equal(erpResult?.processed, true);
assert.equal(output('step_5')?.acknowledged, true);
assert.equal(erpResult.hash, createHash('sha256').update(report).digest('hex'));

const credentials = JSON.parse(fs.readFileSync(path.join(privateDirectory, 'erpnext-report-connection.json'), 'utf8'));
async function erp(endpoint) {
  const response = await fetch(credentials.baseUrl + endpoint, {
    headers: { Authorization: `token ${credentials.apiKey}:${credentials.apiSecret}` },
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  assert(response.ok, 'ERPNext readback failed');
  return (await response.json()).data;
}
const note = await erp(`/api/resource/Note/${encodeURIComponent(erpResult.name)}`);
assert.equal(note.custom_project, config.erpProject);
if (config.erpParentNote) {
  assert.equal(note.custom_parent_note, config.erpParentNote);
  const diary = await erp(`/api/resource/Note/${encodeURIComponent(config.erpParentNote)}`);
  assert.equal(diary.custom_project, config.erpProject);
}
const project = await erp(`/api/resource/Project/${encodeURIComponent(config.erpProject)}`);
if (config.erpParentProject) assert.equal(project.custom_parent_project, config.erpParentProject);
assert.equal(project.custom_github_repository?.toLowerCase(), config.repository.toLowerCase());
assert.equal(Number(note.public), 0);
const query = new URLSearchParams({ filters: JSON.stringify([['custom_daily_report_key', '=', note.custom_daily_report_key]]),
  fields: JSON.stringify(['name']), limit_page_length: '2' });
const notes = await erp(`/api/resource/Note?${query}`);
assert.equal(notes.length, 1);
assert.equal(notes[0].name, note.name);

const sessionId = run.sessionId;
assert(sessionId, 'Execution session missing');
const slug = run.cwd.replaceAll('/', '-');
const journal = path.join('/home/scott/.dsh/sessions', `-${slug}--`, sessionId, 'session.v4.jsonl.zstd');
const bytes = fs.readFileSync(journal);
let offset = 0, source = '';
while (offset < bytes.length) {
  const frame = zlib.zstdDecompressSync(bytes.subarray(offset), { info: true });
  offset += frame.engine.bytesWritten; source += frame.buffer.toString();
}
const events = source.split('\n').filter(Boolean).map(JSON.parse);
const assistant = events.findLast(event => event.type === 'assistant/message');
const end = events.findLast(event => event.type === 'turn/end');
assert.equal(end.data.reason.kind, 'completed');
const blocks = assistant.data.message.content;
const text = blocks.filter(block => block.type === 'text');
assert(text.some(block => block.acpStream?.messagePhase === 'commentary' && block.text.includes('ONEACP_DAILY_PROGRESS_ONLY')));
assert.equal(text.filter(block => block.acpStream?.messagePhase === 'final_answer').map(block => block.text).join(''), report);
assert.equal(text.findLast(block => block.acpResult)?.acpResult.finalAnswer, report);
const tools = blocks.filter(block => block.acpTool?.tool.status === 'completed').map(block => block.acpTool.tool);
assert(tools.some(tool => /pwd/.test(JSON.stringify([tool.title, tool.rawInput]))));
assert(tools.some(tool => /README\.md/.test(JSON.stringify([tool.title, tool.rawInput]))));
const taskDirectory = '/home/scott/.local/state/1agents/dsh-a2a';
const task = fs.readdirSync(taskDirectory).filter(file => file.startsWith('task-'))
  .map(file => JSON.parse(fs.readFileSync(path.join(taskDirectory, file))).value).find(task => task.id === run.taskId);
assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
assert(Date.parse(task.status.timestamp) >= end.time);
assert(Date.parse(processing.businessCompletedAt) >= end.time);
assert(Date.parse(processing.gatewayAcknowledgedAt) >= Date.parse(processing.businessCompletedAt));
// The ERP action reads back persisted content before returning processed=true,
// and ACK is the next successful flow step. A later UI read may update Note's
// seen-by metadata, so its mutable modified timestamp is not a save receipt.

const proof = {
  repository: config.repository, reportDate: config.reportDate, manualBackfill: true, timeZone: 'Asia/Shanghai', verifiedAt: new Date().toISOString(),
  dispatchFlowId: receipt.dispatchFlowId, dispatchRunId: run.flowRunId, dispatchEnvironment: 'TESTING', dispatchStatus: dispatchFlow.status,
  resultFlowId: receipt.resultFlowId, resultRunId: resultRun.id ?? resultRun.runId, resultEnvironment: 'PRODUCTION',
  execution: { runId: run.runId, taskId: run.taskId, contextId: run.contextId, sessionId, journal,
    turnEndedAt: new Date(end.time).toISOString(), a2aCompletedAt: task.status.timestamp },
  notification: { noticeId: processing.noticeId, businessCompletedAt: processing.businessCompletedAt,
    gatewayAcknowledgedAt: processing.gatewayAcknowledgedAt },
  facts: { actualCollectedAt: facts.actualCollectedAt, commits: facts.commits.length,
    mergedPullRequests: facts.mergedPullRequests.length, metrics: facts.metrics,
    sessionCount: facts.sessionFacts.collection.usedSessionCount, trendingCapturedAt: facts.trending.capturedAt },
  erp: { name: note.name, title: note.title, project: note.custom_project, parentProject: project.custom_parent_project, parentNote: note.custom_parent_note, public: note.public,
    modifiedAt: note.modified, hash: erpResult.hash, noteCount: notes.length, updatedExistingNote: !erpResult.created },
  checks: { dispatchSucceeded: true, resultFlowSucceeded: true, finalAnswerMatchesReport: true,
    progressPreservedInLog: true, progressExcludedFromReport: true, erpSavedBeforeAck: true,
    turnEndedBeforeCompletion: true, sameRepositoryDateHasOneNote: true, projectHierarchyMatches: true, diaryAssociationMatches: true },
};
fs.writeFileSync(path.join(run.cwd, 'reports', `${config.reportDate}.md`), report);
fs.writeFileSync(config.proofFile ?? path.join(privateDirectory, 'daily-report-proof.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(proof, null, 2));
