import { createAction, createPiece, PieceAuth, Property } from '@activepieces/pieces-framework';

type Connection = { bridgeUrl: string; token: string };
async function request(auth: unknown, endpoint: string, input?: unknown): Promise<Record<string, unknown>> {
  const value = auth as { props?: Connection } & Partial<Connection>;
  const connection = value?.props ?? value;
  if (typeof connection.bridgeUrl !== 'string' || typeof connection.token !== 'string' || connection.token.length < 32) throw new Error('请配置补库专用加密连接');
  const url = new URL(connection.bridgeUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('补库服务地址无效');
  try {
    const response = await fetch(url.href.replace(/\/$/, '') + endpoint, {
      method: input === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('failed'); }
    return await response.json() as Record<string, unknown>;
  } catch { throw new Error('补库操作尚未确认；保留原动作并检查服务状态，不要新建重复任务'); }
}
const auth = PieceAuth.CustomAuth({ displayName: '公众号补库专用连接', required: true,
  description: '只允许读取补库快照、执行其冻结动作；凭据由AP加密保存。',
  props: { bridgeUrl: Property.ShortText({ displayName: '补库服务地址', required: true }), token: PieceAuth.SecretText({ displayName: '专用密钥', required: true }) },
  validate: async ({ auth }) => { try { await request(auth, '/status'); return { valid: true }; } catch { return { valid: false, error: '补库专用连接不可用' }; } },
});
const observe = createAction({ name: 'observe_stock', displayName: '读取真实库存并核对已有结果', auth,
  description: '按至少30分钟的持久间隔刷新真实工作台，核对在途任务与原成品写回；不会在本步骤派新制作。', props: {},
  async run(context) { return request(context.auth, '/observe', { flowRunId: context.run.id }); },
});
const apply = createAction({ name: 'apply_stock_advice', displayName: '执行已校验的下一动作', auth,
  description: '校验AP固定规则结果与最新事实，原子领取并按稳定请求号调用已登记编辑角色。',
  props: { observationId: Property.ShortText({ displayName: '观察编号', required: false }),
    advice: Property.Json({ displayName: '固定规则输出', required: true }) },
  async run(context) {
    if (!context.propsValue.observationId) return { applied: false, reason: 'not_due' };
    return request(context.auth, '/apply', context.propsValue);
  },
});
export const wechatStock = createPiece({ displayName: '公众号候补内容补库', description: 'AP感应式补库的受限业务接点。',
  logoUrl: 'https://cdn.activepieces.com/pieces/http.svg', minimumSupportedRelease: '0.92.1', authors: ['scottzx'], auth, actions: [observe, apply], triggers: [] });
