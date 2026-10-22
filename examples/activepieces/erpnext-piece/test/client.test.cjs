const assert = require('node:assert/strict');
const { test } = require('node:test');
const { dailyReportIdentity, upsertDailyReport } = require('../dist/client.js');

const auth = { props: { siteUrl: 'http://erp.test', apiKey: 'test-key', apiSecret: 'test-secret' } };
const input = { repository: 'scottzx/1acp', reportDate: '2026-10-16', project: 'PROJ-0007', reportMarkdown: '# 昨日开发日报\n\n最终回答。\n\n|项目|结果|\n|---|---|\n|提交|3|\n' };
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function store({ collision = false, failure, shareFailure, transform = (value) => value } = {}) {
  const notes = new Map();
  const calls = [];
  const shares = [];
  let creates = 0;
  const fetcher = async (url, options) => {
    const target = new URL(url);
    const method = options.method;
    calls.push({ method, url, ...(options.body ? { body: JSON.parse(options.body) } : {}) });
    assert.equal(options.headers.Authorization, 'token test-key:test-secret');
    assert.equal(options.redirect, 'error');
    if (failure) return reply({ exc_type: 'RuntimeError', exception: 'sensitive-server-detail test-secret' }, failure);
    if (target.pathname === '/api/method/frappe.share.add' && method === 'POST') {
      const share = JSON.parse(options.body);
      shares.push(share);
      if (shareFailure) return reply({ exc_type: 'PermissionError', exception: 'sensitive-share-detail test-secret' }, shareFailure);
      return reply({ message: { ...share, doctype: 'DocShare', name: 'saved-share', share_doctype: share.doctype, share_name: share.name } });
    }
    if (target.pathname === '/api/resource/Note' && method === 'GET') {
      const [[field, op, key]] = JSON.parse(target.searchParams.get('filters'));
      assert.equal(field, 'custom_daily_report_key');
      assert.equal(op, '=');
      return reply({ data: [...notes.values()].filter((note) => note[field] === key).map(({ name }) => ({ name })) });
    }
    if (target.pathname === '/api/resource/Note' && method === 'POST') {
      creates++;
      const note = { name: 'random-frappe-name', ...JSON.parse(options.body) };
      notes.set(note.name, transform(note));
      if (collision) { collision = false; return reply({ exc_type: 'UniqueValidationError' }, 417); }
      return reply({ data: note });
    }
    const name = decodeURIComponent(target.pathname.split('/').pop());
    const note = notes.get(name);
    if (method === 'GET') return note ? reply({ data: note }) : reply({}, 404);
    if (method === 'PUT' && note) {
      const updated = transform({ ...note, ...JSON.parse(options.body) });
      notes.set(name, updated);
      return reply({ data: updated });
    }
    throw new Error(`Unexpected mock request ${method} ${target.pathname}`);
  };
  return { notes, calls, shares, fetcher, get creates() { return creates; } };
}

test('same repository/date updates one Note and confirms persisted final content', async () => {
  const mock = store();
  const first = await upsertDailyReport(auth, input, mock.fetcher);
  const final = await upsertDailyReport(auth, { ...input, reportMarkdown: '# 最终日报\n\n已补充验证。' }, mock.fetcher);
  assert.equal(first.created, true);
  assert.equal(final.created, false);
  assert.equal(first.name, final.name);
  assert.equal(mock.creates, 1);
  assert.equal(mock.notes.size, 1);
  assert.match(mock.notes.get(final.name).content, /<h1>最终日报<\/h1>/);
  assert.match(mock.notes.get(final.name).content, /已补充验证/);
  assert.deepEqual(Object.keys(final).sort(), ['created', 'hash', 'name', 'processed', 'url']);
  assert.equal(final.processed, true);
  assert.doesNotMatch(JSON.stringify(final), /test-secret|test-key/);
  assert.equal(mock.shares.length, 0);
  const withReader = await upsertDailyReport(auth, { ...input, readerUser: 'reader@example.test' }, mock.fetcher);
  assert.equal(withReader.name, first.name);
  assert.equal(withReader.processed, true);
  assert.equal(mock.creates, 1);
  assert.deepEqual(mock.shares, [{ doctype: 'Note', name: first.name, user: 'reader@example.test', read: 1, write: 0, share: 0, submit: 0, everyone: 0, notify: 0 }]);
  assert.equal(mock.notes.get(first.name).public, 0);
  assert.doesNotMatch(JSON.stringify(withReader), /reader@example/);
});

test('unique-field race reads and updates the winning Note', async () => {
  const mock = store({ collision: true });
  const result = await upsertDailyReport(auth, input, mock.fetcher);
  assert.equal(result.created, false);
  assert.equal(mock.creates, 1);
  assert.equal(mock.notes.size, 1);
  assert.ok(mock.calls.some(({ method }) => method === 'PUT'));
});

test('a same-project code-journal parent is verified, saved and preserved when omitted', async () => {
  const mock = store();
  const parentNote = 'code-journal';
  mock.notes.set(parentNote, { name: parentNote, custom_project: input.project, title: '代码日记' });
  const first = await upsertDailyReport(auth, { ...input, parentNote }, mock.fetcher);
  assert.equal(mock.notes.get(first.name).custom_parent_note, parentNote);
  assert.equal(mock.calls[0].url, `http://erp.test/api/resource/Note/${parentNote}`);
  const second = await upsertDailyReport(auth, { ...input, reportMarkdown: '# 更新后的最终日报' }, mock.fetcher);
  assert.equal(second.created, false);
  assert.equal(second.name, first.name);
  assert.equal(mock.notes.get(first.name).custom_parent_note, parentNote);
  assert.ok(mock.calls.filter(({ method }) => method === 'PUT').every(({ body }) => !Object.hasOwn(body, 'custom_parent_note')));
  const third = await upsertDailyReport(auth, { ...input, parentNote: '   ' }, mock.fetcher);
  assert.equal(third.name, first.name);
  assert.equal(mock.notes.get(first.name).custom_parent_note, parentNote);
});

test('missing, cross-project and self parents fail without changing any Note', async () => {
  const absent = store();
  await assert.rejects(upsertDailyReport(auth, { ...input, parentNote: 'absent' }, absent.fetcher), /HTTP 404/);
  assert.equal(absent.creates, 0);

  const wrongProject = store();
  wrongProject.notes.set('journal', { name: 'journal', custom_project: 'OTHER' });
  await assert.rejects(upsertDailyReport(auth, { ...input, parentNote: 'journal' }, wrongProject.fetcher), /父笔记不存在于目标项目/);
  assert.equal(wrongProject.creates, 0);
  assert.equal(wrongProject.calls.filter(({ method }) => method === 'PUT').length, 0);

  const self = store();
  const existing = await upsertDailyReport(auth, input, self.fetcher);
  const previousCalls = self.calls.length;
  await assert.rejects(upsertDailyReport(auth, { ...input, parentNote: existing.name }, self.fetcher), /自身设为父笔记/);
  assert.equal(self.creates, 1);
  assert.ok(self.calls.slice(previousCalls).every(({ method }) => method === 'GET'));
  assert.equal(self.notes.get(existing.name).custom_parent_note, undefined);
});

test('a missing persisted parent association prevents completion and sharing', async () => {
  const mock = store({ transform: ({ custom_parent_note, ...note }) => note });
  mock.notes.set('journal', { name: 'journal', custom_project: input.project });
  await assert.rejects(upsertDailyReport(auth, { ...input, parentNote: 'journal', readerUser: 'reader@example.test' }, mock.fetcher), /父笔记关联校验失败/);
  assert.equal(mock.creates, 1);
  assert.equal(mock.shares.length, 0);
});

test('an existing report cannot be moved to a different Project by upsert', async () => {
  const mock = store();
  const existing = await upsertDailyReport(auth, input, mock.fetcher);
  const previousCalls = mock.calls.length;
  await assert.rejects(upsertDailyReport(auth, { ...input, project: 'CHILD-PROJECT' }, mock.fetcher), /关联项目不匹配/);
  assert.ok(mock.calls.slice(previousCalls).every(({ method }) => method === 'GET'));
  assert.equal(mock.notes.get(existing.name).custom_project, input.project);
});

test('server failure stays failed without exposing response or credentials', async () => {
  const mock = store({ failure: 500 });
  await assert.rejects(upsertDailyReport(auth, input, mock.fetcher), (error) => {
    assert.match(error.message, /HTTP 500/);
    assert.doesNotMatch(error.message, /sensitive|test-secret/);
    return true;
  });
  assert.equal(mock.creates, 0);
  const shareDenied = store({ shareFailure: 403 });
  await assert.rejects(upsertDailyReport(auth, { ...input, readerUser: 'reader@example.test' }, shareDenied.fetcher), (error) => {
    assert.match(error.message, /HTTP 403/);
    assert.doesNotMatch(error.message, /sensitive|test-secret|reader@example/);
    return true;
  });
  assert.equal(shareDenied.notes.size, 1);
  assert.equal(shareDenied.shares.length, 1);
});

test('Markdown raw HTML, images and dangerous links do not become executable content', async () => {
  const mock = store();
  const reportMarkdown = '# 最终\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![image](https://tracking.test/image.png)';
  const result = await upsertDailyReport(auth, { ...input, reportMarkdown }, mock.fetcher);
  const html = mock.notes.get(result.name).content;
  assert.doesNotMatch(html, /<script|<img|href="javascript:/i);
  assert.match(html, /&lt;script&gt;/);
});

test('Frappe v16 sanitizer quote normalization preserves verified final content', async () => {
  const mock = store({ transform: (note) => ({ ...note, content: note.content.replace(/&quot;/g, '"') }) });
  const reportMarkdown = '# 最终\n\n[代码库](https://github.com/scottzx/1acp)\n\n```json\n{"status":"done"}\n```';
  const result = await upsertDailyReport(auth, { ...input, reportMarkdown }, mock.fetcher);
  assert.equal(result.processed, true);
  assert.match(mock.notes.get(result.name).content, /rel="noopener noreferrer"/);
});

test('wrong project and lost content fail before acknowledgement', async () => {
  const wrongProject = store({ transform: (note) => ({ ...note, custom_project: 'OTHER' }) });
  await assert.rejects(upsertDailyReport(auth, input, wrongProject.fetcher), /关联项目不匹配/);
  assert.equal(wrongProject.calls.filter(({ method }) => method === 'PUT').length, 0);
  const lostContent = store({ transform: (note) => ({ ...note, content: '<p>lost</p>' }) });
  await assert.rejects(upsertDailyReport(auth, input, lostContent.fetcher), /内容校验失败/);
});

test('date and repository identities are deterministic and invalid dates rejected', () => {
  assert.deepEqual(dailyReportIdentity('ScottZX/1ACP', input.reportDate), dailyReportIdentity(input.repository, input.reportDate));
  assert.notEqual(dailyReportIdentity(input.repository, '2026-10-17').key, dailyReportIdentity(input.repository, input.reportDate).key);
  assert.throws(() => dailyReportIdentity(input.repository, '2026-02-30'), /有效/);
});

test('an unclaimed notification skips saving without a valid connection or network', async () => {
  const { erpnextDailyReport } = require('../dist/index.js');
  const action = erpnextDailyReport.actions().upsert_daily_report;
  assert.equal(action.props.reportMarkdown.required, false);
  assert.deepEqual(await action.run({ propsValue: { processed: false }, auth: undefined }), { processed: false });
  await assert.rejects(action.run({ propsValue: { ...input, reportMarkdown: '', processed: true }, auth }), /最终日报不能为空/);
});
