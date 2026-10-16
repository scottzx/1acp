import { createAction, createPiece, PieceAuth, Property } from '@activepieces/pieces-framework';

type Connection = { gatewayUrl: string; automationToken: string };

function connection(value: unknown): Connection {
  const auth = value as { props?: Connection } & Partial<Connection>;
  const props = auth?.props ?? auth;
  if (!props || typeof props.gatewayUrl !== 'string' || typeof props.automationToken !== 'string' || !props.automationToken.trim()) throw new Error('请配置 1acp 连接。');
  let url: URL;
  try { url = new URL(props.gatewayUrl); } catch { throw new Error('1acp 地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('1acp 地址必须是不含凭据的 HTTP 或 HTTPS 地址。');
  return { gatewayUrl: url.href.replace(/\/$/, ''), automationToken: props.automationToken };
}

/** Connections are decrypted by Activepieces; credentials never enter CODE step inputs or outputs. */
async function request(auth: unknown, endpoint: string, body?: unknown): Promise<Record<string, unknown>> {
  const value = connection(auth);
  let response: Response;
  try {
    response = await fetch(value.gatewayUrl + endpoint, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${value.automationToken}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new Error('无法连接 1acp，或请求超时。'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`1acp 请求失败（HTTP ${response.status}）。`);
  }
  try { return await response.json() as Record<string, unknown>; }
  catch { throw new Error('1acp 返回了无效结果。'); }
}

const auth = PieceAuth.CustomAuth({
  displayName: '1acp 调度连接',
  description: '连接已配置允许调用任务的 1acp 服务。密钥由 Activepieces 加密保存。',
  required: true,
  props: {
    gatewayUrl: Property.ShortText({ displayName: '服务地址', required: true, defaultValue: 'http://127.0.0.1:36815' }),
    automationToken: PieceAuth.SecretText({ displayName: '访问密钥', required: true }),
  },
  validate: async ({ auth }) => {
    try { await request(auth, '/automation/runs?limit=1'); return { valid: true }; }
    catch { return { valid: false, error: '无法验证 1acp 连接，请检查服务地址与访问密钥。' }; }
  },
});

const noticeProps = {
  noticeId: Property.ShortText({ displayName: '通知编号', required: true }),
  originSessionId: Property.ShortText({ displayName: '原始会话编号', required: true }),
  processorId: Property.ShortText({ displayName: '本次处理编号', required: true }),
};

const dispatchRun = createAction({
  auth,
  name: 'dispatch_run',
  displayName: '派发智能体任务',
  description: '按计划编号与执行时间派发一次任务，相同批次重复调用会返回已有记录。',
  props: {
    scheduleId: Property.ShortText({ displayName: '计划编号', required: true }),
    scheduledFor: Property.ShortText({ displayName: '计划执行时间', description: '带时区的 ISO 时间；重试时应复用同一时间。', required: true }),
    prompt: Property.LongText({ displayName: '任务说明', required: true }),
    businessRef: Property.ShortText({ displayName: '业务关联编号', required: false }),
  },
  async run(context) {
    const { scheduleId, scheduledFor, prompt, businessRef } = context.propsValue;
    return request(context.auth, '/automation/runs', { scheduleId, scheduledFor, prompt, businessRef, flowRunId: context.run.id });
  },
});

const claimNotice = createAction({
  auth,
  name: 'claim_notice',
  displayName: '认领任务结果',
  description: '在保存结果前认领通知，重复通知和正在处理的通知会返回 claimed=false。',
  props: noticeProps,
  async run(context) {
    const receipt = context.propsValue;
    const result = await request(context.auth, `/automation/notices/${encodeURIComponent(receipt.noticeId)}/claim`, {
      originSessionId: receipt.originSessionId, processorId: receipt.processorId,
    });
    return { ...result, receipt };
  },
});

const acknowledgeNotice = createAction({
  auth,
  name: 'acknowledge_notice',
  displayName: '确认结果已处理',
  description: '仅在结果保存成功后确认通知，重复确认安全。',
  props: { ...noticeProps, processed: Property.Checkbox({ displayName: '结果已保存', required: false, defaultValue: true }) },
  async run(context) {
    const { noticeId, originSessionId, processorId, processed } = context.propsValue;
    if (processed === false) return { acknowledged: false, reason: 'not_processed' };
    return request(context.auth, `/automation/notices/${encodeURIComponent(noticeId)}/ack`, { originSessionId, processorId });
  },
});

export const acpAutomation = createPiece({
  displayName: '1acp 智能体任务',
  description: '派发智能体任务并安全处理异步执行结果。',
  logoUrl: 'https://cdn.activepieces.com/pieces/http.svg',
  minimumSupportedRelease: '0.92.1',
  authors: ['scottzx'],
  auth,
  actions: [dispatchRun, claimNotice, acknowledgeNotice],
  triggers: [],
});
