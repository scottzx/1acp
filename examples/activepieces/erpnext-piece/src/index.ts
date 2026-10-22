import { createAction, createPiece, PieceAuth, Property } from '@activepieces/pieces-framework';
import { upsertDailyReport, validateConnection } from './client';

const auth = PieceAuth.CustomAuth({
  displayName: 'ERPNext 日报连接',
  description: '使用专用报表用户的 API 密钥；连接信息由 Activepieces 加密保存。',
  required: true,
  props: {
    siteUrl: Property.ShortText({ displayName: 'ERPNext 地址', required: true }),
    apiKey: PieceAuth.SecretText({ displayName: 'API Key', required: true }),
    apiSecret: PieceAuth.SecretText({ displayName: 'API Secret', required: true }),
  },
  validate: async ({ auth }) => {
    try { await validateConnection(auth); return { valid: true }; }
    catch { return { valid: false, error: '无法验证 ERPNext 连接，请检查地址、密钥及专用用户权限。' }; }
  },
});

const upsertReport = createAction({
  auth,
  name: 'upsert_daily_report',
  displayName: '保存项目 Git 日报',
  description: '将最终 Markdown 日报保存到 ERPNext 项目笔记，同一仓库同一天重复执行更新原笔记。',
  props: {
    repository: Property.ShortText({ displayName: 'GitHub 仓库', description: 'owner/repository', required: true }),
    reportDate: Property.ShortText({ displayName: '统计日期', description: '北京时间的 YYYY-MM-DD 日期', required: true }),
    project: Property.ShortText({ displayName: 'ERPNext 项目编号', required: true, defaultValue: 'PROJ-0007' }),
    parentNote: Property.ShortText({ displayName: '代码日记父笔记编号', description: '可选：必须属于目标项目；留空时保留已有日报的父笔记关联。', required: false }),
    readerUser: Property.ShortText({ displayName: '日报查看用户', description: '可选：管理员事先确认此用户已获准访问该项目；仅授予这份笔记的查看权。', required: false }),
    reportMarkdown: Property.LongText({ displayName: '最终日报', description: '仅传入智能体完成后的最终 Markdown 回答；跳过重复通知时可为空。', required: false }),
    processed: Property.Checkbox({ displayName: '本次结果需要保存', description: '重复或未认领通知设为 false，将直接跳过保存。', required: false, defaultValue: true }),
  },
  async run(context) {
    if (context.propsValue.processed === false) return { processed: false };
    return upsertDailyReport(context.auth, { ...context.propsValue, reportMarkdown: context.propsValue.reportMarkdown ?? '' });
  },
});

export const erpnextDailyReport = createPiece({
  displayName: 'ERPNext 项目日报',
  description: '将智能体的最终日报安全保存到 ERPNext 关联项目的笔记。',
  logoUrl: 'https://cdn.activepieces.com/pieces/http.svg',
  minimumSupportedRelease: '0.92.1',
  authors: ['scottzx'],
  auth,
  actions: [upsertReport],
  triggers: [],
});
