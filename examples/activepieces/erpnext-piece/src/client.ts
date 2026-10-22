import { createHash } from 'node:crypto';
import MarkdownIt from 'markdown-it';

export type Connection = { siteUrl: string; apiKey: string; apiSecret: string };
export type DailyReport = { repository: string; reportDate: string; project: string; reportMarkdown: string; parentNote?: string; readerUser?: string };
type Json = Record<string, unknown>;
type Fetch = typeof fetch;

const identityField = 'custom_daily_report_key';
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
// Reports should not cause clients to load arbitrary remote images on opening a Note.
markdown.disable('image');
const renderLink = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderLink ? renderLink(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options);
};

export function connection(value: unknown): Connection {
  const auth = value as { props?: Connection } & Partial<Connection>;
  const props = auth?.props ?? auth;
  if (!props || typeof props.siteUrl !== 'string' || typeof props.apiKey !== 'string' || typeof props.apiSecret !== 'string'
    || !props.apiKey.trim() || !props.apiSecret.trim() || /[\s:]/.test(props.apiKey + props.apiSecret)) {
    throw new Error('请配置 ERPNext 连接。');
  }
  let url: URL;
  try { url = new URL(props.siteUrl); } catch { throw new Error('ERPNext 地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('ERPNext 地址必须是不含凭据的 HTTP 或 HTTPS 地址。');
  }
  return { siteUrl: url.href.replace(/\/$/, ''), apiKey: props.apiKey, apiSecret: props.apiSecret };
}

class ApiError extends Error {
  constructor(readonly status: number, readonly duplicate: boolean) {
    super(`ERPNext 请求失败（HTTP ${status}）。`);
  }
}

async function request(auth: Connection, endpoint: string, method: 'GET' | 'POST' | 'PUT', body: unknown, fetcher: Fetch): Promise<Json> {
  let response: Response;
  try {
    response = await fetcher(auth.siteUrl + endpoint, {
      method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json', Authorization: `token ${auth.apiKey}:${auth.apiSecret}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new Error('无法连接 ERPNext，或请求超时。'); }
  let value: unknown;
  try { value = await response.json(); }
  catch {
    if (!response.ok) throw new ApiError(response.status, false);
    throw new Error('ERPNext 返回了无效结果。');
  }
  const data = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
  if (!response.ok) {
    // Frappe v16 uses 417 for a unique-field collision, 409 for duplicate document names.
    // Read only the known exception discriminator; never expose server messages or tracebacks.
    throw new ApiError(response.status, response.status === 409
      || (response.status === 417 && data?.exc_type === 'UniqueValidationError'));
  }
  if (!data) throw new Error('ERPNext 返回了无效结果。');
  return data;
}

export function dailyReportIdentity(repository: string, reportDate: string): { repository: string; key: string; title: string } {
  const repo = repository.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo) || repo.length > 141) throw new Error('仓库必须使用 owner/repository 格式。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate) || !Number.isFinite(Date.parse(reportDate))
    || new Date(reportDate).toISOString().slice(0, 10) !== reportDate) throw new Error('日报日期必须是有效的 YYYY-MM-DD 日期。');
  const digest = createHash('sha256').update(repo).digest('hex').slice(0, 32);
  const title = `Git 开发日报 · ${repo} · ${reportDate}`;
  return { repository: repo, key: `1acp:github-daily:v1:${reportDate}:${digest}`, title: title.length <= 140 ? title : `${title.slice(0, 120)} · ${digest.slice(0, 16)}` };
}

export async function validateConnection(value: unknown, fetcher: Fetch = fetch): Promise<void> {
  const auth = connection(value);
  const result = await request(auth, '/api/method/frappe.auth.get_logged_user', 'GET', undefined, fetcher);
  if (typeof result.message !== 'string' || !result.message || result.message === 'Guest') throw new Error('ERPNext 连接未通过身份验证。');
}

function document(result: Json): Json {
  if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) throw new Error('ERPNext 未返回有效的笔记。');
  return result.data as Json;
}

function verifyIdentity(note: Json, key: string, title: string, project: string): string {
  if (typeof note.name !== 'string' || !note.name || note[identityField] !== key || note.title !== title || note.custom_project !== project) {
    throw new Error('ERPNext 日报的唯一标识、标题或关联项目不匹配，已停止写入。');
  }
  return note.name;
}

function canonicalHtml(value: string): string {
  // Frappe's nh3 sanitizer keeps quoted attributes but decodes quote entities in
  // text nodes. Normalize those harmless differences without decoding < or >.
  return value.trim().replace(/(^|>)([^<]*)(?=<|$)/g, (_all, prefix: string, text: string) => prefix + text
    .replace(/&quot;|&#34;|&#x22;/gi, '"').replace(/&#39;|&#x27;|&apos;/gi, "'"))
    .replace(/>\s+</g, '><');
}

export async function upsertDailyReport(value: unknown, input: DailyReport, fetcher: Fetch = fetch): Promise<{ name: string; url: string; created: boolean; hash: string; processed: true }> {
  const auth = connection(value);
  const { key, title } = dailyReportIdentity(input.repository, input.reportDate);
  if (typeof input.project !== 'string' || !input.project.trim() || input.project.length > 140) throw new Error('请指定有效的 ERPNext 项目。');
  if (typeof input.reportMarkdown !== 'string' || !input.reportMarkdown.trim() || Buffer.byteLength(input.reportMarkdown, 'utf8') > 1_000_000) {
    throw new Error('最终日报不能为空，且不得超过 1 MB。');
  }
  if (input.parentNote !== undefined && typeof input.parentNote !== 'string') throw new Error('请指定有效的 ERPNext 父笔记编号。');
  const parentNote = input.parentNote?.trim() || undefined;
  if (parentNote && parentNote.length > 140) throw new Error('请指定有效的 ERPNext 父笔记编号。');
  const readerUser = input.readerUser?.trim();
  if (readerUser && (readerUser.length > 140 || ['guest', 'all', 'everyone', '*'].includes(readerUser.toLowerCase()))) {
    throw new Error('请指定已经获准访问项目的 ERPNext 查看用户。');
  }
  const content = markdown.render(input.reportMarkdown);
  const hash = createHash('sha256').update(input.reportMarkdown).digest('hex');
  if (parentNote) {
    const parent = document(await request(auth, `/api/resource/Note/${encodeURIComponent(parentNote)}`, 'GET', undefined, fetcher));
    if (parent.name !== parentNote || parent.custom_project !== input.project) {
      throw new Error('ERPNext 父笔记不存在于目标项目，已停止写入。');
    }
    if (parent[identityField] === key) throw new Error('ERPNext 日报不能将自身设为父笔记，已停止写入。');
  }
  const query = new URLSearchParams({ filters: JSON.stringify([[identityField, '=', key]]), fields: JSON.stringify(['name']), limit_page_length: '2' });
  const find = async (): Promise<Json | undefined> => {
    const list = await request(auth, `/api/resource/Note?${query}`, 'GET', undefined, fetcher);
    if (!Array.isArray(list.data) || list.data.length > 1) throw new Error('ERPNext 日报唯一标识出现重复或查询结果无效。');
    const row = list.data[0] as Json | undefined;
    if (!row) return undefined;
    if (typeof row.name !== 'string' || !row.name) throw new Error('ERPNext 日报查询未返回笔记编号。');
    const note = document(await request(auth, `/api/resource/Note/${encodeURIComponent(row.name)}`, 'GET', undefined, fetcher));
    verifyIdentity(note, key, title, input.project);
    if (parentNote === note.name) throw new Error('ERPNext 日报不能将自身设为父笔记，已停止写入。');
    return note;
  };
  let existing = await find();
  let created = false;
  // An omitted parent leaves an existing report's placement unchanged.
  const fields = { title, [identityField]: key, custom_project: input.project, content, public: 0,
    ...(parentNote ? { custom_parent_note: parentNote } : {}) };
  let name: string;
  if (!existing) {
    try {
      const saved = document(await request(auth, '/api/resource/Note', 'POST', { doctype: 'Note', ...fields }, fetcher));
      name = verifyIdentity(saved, key, title, input.project);
      created = true;
    } catch (error) {
      if (!(error instanceof ApiError) || !error.duplicate) throw error;
      existing = await find();
      if (!existing) throw error;
      name = verifyIdentity(existing, key, title, input.project);
    }
  } else name = verifyIdentity(existing, key, title, input.project);
  if (!created) await request(auth, `/api/resource/Note/${encodeURIComponent(name)}`, 'PUT', fields, fetcher);
  // A successful transport response alone is insufficient to acknowledge the A2A notice.
  const persisted = document(await request(auth, `/api/resource/Note/${encodeURIComponent(name)}`, 'GET', undefined, fetcher));
  verifyIdentity(persisted, key, title, input.project);
  if (parentNote && persisted.custom_parent_note !== parentNote) {
    throw new Error('ERPNext 日报写入后的父笔记关联校验失败，尚不能确认任务完成。');
  }
  if (typeof persisted.content !== 'string' || canonicalHtml(persisted.content) !== canonicalHtml(content) || Number(persisted.public) !== 0) {
    throw new Error('ERPNext 日报写入后的内容校验失败，尚不能确认任务完成。');
  }
  if (readerUser) {
    const result = await request(auth, '/api/method/frappe.share.add', 'POST', {
      doctype: 'Note', name, user: readerUser, read: 1, write: 0, share: 0, submit: 0, everyone: 0, notify: 0,
    }, fetcher);
    const shared = result.message as Json | undefined;
    // The real v16 endpoint returns the saved DocShare. Verify it without
    // requesting broad DocShare list permissions or returning the reader identity.
    if (!shared || typeof shared !== 'object' || Array.isArray(shared) || shared.doctype !== 'DocShare'
      || typeof shared.name !== 'string' || !shared.name || shared.share_doctype !== 'Note' || shared.share_name !== name
      || shared.user !== readerUser || Number(shared.read) !== 1 || Number(shared.write) !== 0
      || Number(shared.share) !== 0 || Number(shared.submit) !== 0 || Number(shared.everyone) !== 0) {
      throw new Error('ERPNext 日报查看授权校验失败，尚不能确认任务完成。');
    }
  }
  return { name, url: `${auth.siteUrl}/app/note/${encodeURIComponent(name)}`, created, hash, processed: true };
}
