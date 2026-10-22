/* Install as an enabled Project / Form Client Script in ERPNext / Frappe 16. */
(() => {
  const rootProject = 'PROJ-0007';
  const sectionClass = 'oneacp-project-viewer';
  const dailyReportPrefix = '1acp:github-daily:v1:';
  const refreshes = new WeakMap();

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character]));
  }

  function formLink(doctype, name, label) {
    const route = doctype === 'Project' ? 'project' : 'note';
    return `<a href="/desk/${route}/${encodeURIComponent(String(name))}">${escapeHtml(label)}</a>`;
  }

  function repositoryLink(repository) {
    const parts = String(repository ?? '').trim().split('/');
    if (parts.length !== 2
      || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(parts[0])
      || !/^[A-Za-z0-9._-]{1,100}$/.test(parts[1])
      || ['.', '..'].includes(parts[1])) return '';
    const url = `https://github.com/${parts.map(encodeURIComponent).join('/')}`;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(parts.join('/'))}</a>`;
  }

  // This whitelisted method uses frappe.get_list, including the current user's
  // document permissions. The viewer performs no writes and never uses get_all.
  function getList(doctype, options) {
    return frappe.xcall('frappe.client.get_list', { doctype, ...options }, 'GET')
      .then((rows) => Array.isArray(rows) ? rows : []);
  }

  function isCurrent(frm, state) {
    return refreshes.get(frm) === state
      && frm.doc?.name === state.name
      && !frm.is_new()
      && document.documentElement.contains(state.body[0]);
  }

  function setHtml(frm, state, selector, html) {
    if (isCurrent(frm, state)) state.body.find(selector).html(html);
  }

  async function showChildren(frm, state, hasRepositoryField) {
    try {
      const children = await getList('Project', {
        fields: ['name', 'project_name', ...(hasRepositoryField ? ['custom_github_repository'] : [])],
        filters: { custom_parent_project: state.name },
        order_by: 'project_name asc',
        limit_page_length: 100,
      });
      const html = children.length ? `
        <div class="table-responsive"><table class="table table-bordered">
          <thead><tr><th>子项目</th><th>GitHub 仓库</th></tr></thead>
          <tbody>${children.map((project) => `<tr>
            <td>${formLink('Project', project.name, project.project_name || project.name)}</td>
            <td>${repositoryLink(project.custom_github_repository) || '<span class="text-muted">未关联仓库</span>'}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        <p class="text-muted small">进入子项目后，可查看代码日记和开发日报。${children.length === 100 ? '当前显示前 100 个可查看的子项目。' : ''}</p>
      ` : '<p class="text-muted">暂无可查看的子项目。</p>';
      setHtml(frm, state, '[data-oneacp-children]', html);
    } catch {
      setHtml(frm, state, '[data-oneacp-children]', '<p class="text-muted">暂时无法读取子项目，请检查访问权限或稍后刷新。</p>');
    }
  }

  async function showParent(frm, state, parentName) {
    if (!parentName) return;
    try {
      const parents = await getList('Project', {
        fields: ['name', 'project_name'], filters: { name: parentName }, limit_page_length: 1,
      });
      if (parents[0]) {
        setHtml(frm, state, '[data-oneacp-parent]', `母项目：${formLink('Project', parents[0].name, parents[0].project_name || parents[0].name)}`);
      }
    } catch {
      // An inaccessible parent does not prevent viewing this project's reports.
    }
  }

  async function showDiary(frm, state, projectTitle) {
    try {
      const diaries = await getList('Note', {
        fields: ['name', 'title'],
        filters: {
          custom_project: state.name,
          title: `代码日记 · ${projectTitle}`,
          custom_parent_note: ['is', 'not set'],
          custom_daily_report_key: ['is', 'not set'],
        },
        order_by: 'creation asc',
        limit_page_length: 1,
      });
      const html = diaries[0]
        ? formLink('Note', diaries[0].name, '打开代码日记')
        : '<span class="text-muted">暂无可查看的代码日记。</span>';
      setHtml(frm, state, '[data-oneacp-diary]', html);
    } catch {
      setHtml(frm, state, '[data-oneacp-diary]', '<span class="text-muted">暂时无法读取代码日记，请检查访问权限或稍后刷新。</span>');
    }
  }

  async function showReports(frm, state) {
    try {
      const reports = await getList('Note', {
        fields: ['name', 'title'],
        filters: {
          custom_project: state.name,
          custom_daily_report_key: ['like', `${dailyReportPrefix}%`],
        },
        order_by: 'creation desc',
        limit_page_length: 10,
      });
      const html = reports.length
        ? `<ul>${reports.map((report) => `<li>${formLink('Note', report.name, report.title || report.name)}</li>`).join('')}</ul>`
        : '<p class="text-muted">暂无可查看的开发日报。</p>';
      setHtml(frm, state, '[data-oneacp-reports]', html);
    } catch {
      setHtml(frm, state, '[data-oneacp-reports]', '<p class="text-muted">暂时无法读取开发日报，请检查访问权限或稍后刷新。</p>');
    }
  }

  frappe.ui.form.on('Project', {
    refresh(frm) {
      // Invalidate pending reads even when this refresh switches to an unrelated
      // project. Frappe also removes custom dashboard sections on its refresh.
      refreshes.delete(frm);
      frm.dashboard?.parent?.find(`.${sectionClass}`).remove();
      const fields = frm.meta?.fields || [];
      if (frm.is_new() || !fields.some((field) => field.fieldname === 'custom_parent_project')) return;
      const hasRepositoryField = fields.some((field) => field.fieldname === 'custom_github_repository');
      const repository = hasRepositoryField ? frm.doc.custom_github_repository : '';
      const isRoot = frm.doc.name === rootProject;
      if (!isRoot && frm.doc.custom_parent_project !== rootProject && !String(repository || '').trim()) return;

      const body = frm.dashboard.add_section(isRoot
        ? '<div data-oneacp-children><p class="text-muted">正在读取子项目…</p></div>'
        : `<p data-oneacp-parent></p>
          ${repositoryLink(repository) ? `<p>GitHub 仓库：${repositoryLink(repository)}</p>` : ''}
          <p data-oneacp-diary class="mb-4 text-muted">正在读取代码日记…</p>
          <h6>最近 10 篇开发日报</h6>
          <div data-oneacp-reports><p class="text-muted">正在读取开发日报…</p></div>`,
      isRoot ? '1Agents 子项目' : '代码日记与开发日报', `custom ${sectionClass}`);
      const state = { name: frm.doc.name, body };
      refreshes.set(frm, state);
      frm.dashboard.show();

      if (isRoot) {
        void showChildren(frm, state, hasRepositoryField);
      } else {
        void showParent(frm, state, frm.doc.custom_parent_project);
        void showDiary(frm, state, frm.doc.project_name || frm.doc.name);
        void showReports(frm, state);
      }
    },
  });
})();
