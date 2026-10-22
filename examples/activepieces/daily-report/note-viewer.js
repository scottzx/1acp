/* Install as an enabled Note / Form Client Script in ERPNext. */
(() => {
  const dailyReportPrefix = '1acp:github-daily:v1:';
  const diaryTitles = ['代码日记 · 1acp', '代码日记 · session-reader'];
  const sectionClass = 'oneacp-note-viewer';
  const refreshes = new WeakMap();

  function isDailyReport(frm) {
    return typeof frm.doc?.custom_daily_report_key === 'string'
      && frm.doc.custom_daily_report_key.startsWith(dailyReportPrefix);
  }

  function isCodeDiary(frm) {
    return diaryTitles.includes(frm.doc?.title)
      && !!frm.doc.custom_project
      && !frm.doc.custom_parent_note
      && !frm.doc.custom_daily_report_key;
  }

  function isManagedNote(frm) {
    return isDailyReport(frm) || isCodeDiary(frm);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character]));
  }

  function noteLink(name, label) {
    return `<a href="/desk/note/${encodeURIComponent(String(name))}">${escapeHtml(label)}</a>`;
  }

  // frappe.client.get_list applies the current user's server-side permissions.
  // These viewers only read records and create links; they never modify Notes.
  function getNotes(options) {
    return frappe.xcall('frappe.client.get_list', { doctype: 'Note', ...options }, 'GET')
      .then((rows) => Array.isArray(rows) ? rows : []);
  }

  function showManagedContent(frm) {
    if (!isManagedNote(frm)) return;
    const section = frm.fields_dict.content?.section;
    if (!section?.df?.fieldname) return;

    // Note's native read mode hides every field except content, including its
    // enclosing migration Section Break. Restore only that enclosing section.
    frm.toggle_display(section.df.fieldname, true);
    section.collapse(false);
    // This inherited migration heading is unrelated to the report itself.
    section.head?.hide();
  }

  function isCurrent(frm, state) {
    return refreshes.get(frm) === state
      && frm.doc?.name === state.name
      && frm.doc.custom_project === state.project
      && isManagedNote(frm)
      && document.documentElement.contains(state.body[0]);
  }

  async function showChildReports(frm, state) {
    try {
      const reports = await getNotes({
        fields: ['name', 'title'],
        filters: {
          custom_project: state.project,
          custom_parent_note: state.name,
          custom_daily_report_key: ['like', `${dailyReportPrefix}%`],
        },
        order_by: 'creation desc',
        limit_page_length: 20,
      });
      if (!isCurrent(frm, state)) return;
      state.body.html(reports.length
        ? `<ul>${reports.map((report) => `<li>${noteLink(report.name, report.title || report.name)}</li>`).join('')}</ul>`
        : '<p class="text-muted">暂无可查看的开发日报。</p>');
    } catch {
      if (isCurrent(frm, state)) {
        state.body.html('<p class="text-muted">暂时无法读取开发日报，请检查访问权限或稍后刷新。</p>');
      }
    }
  }

  async function showParentDiary(frm, state, parentName) {
    try {
      const diaries = await getNotes({
        fields: ['name', 'title'],
        filters: {
          name: parentName,
          custom_project: state.project,
          title: ['in', diaryTitles],
          custom_parent_note: ['is', 'not set'],
          custom_daily_report_key: ['is', 'not set'],
        },
        limit_page_length: 1,
      });
      if (!isCurrent(frm, state)) return;
      state.body.html(diaries[0]
        ? noteLink(diaries[0].name, `返回${diaries[0].title}`)
        : '<p class="text-muted">暂无可查看的代码日记入口。</p>');
    } catch {
      if (isCurrent(frm, state)) {
        state.body.html('<p class="text-muted">暂时无法读取代码日记入口，请稍后刷新。</p>');
      }
    }
  }

  frappe.ui.form.on('Note', {
    refresh(frm) {
      refreshes.delete(frm);
      frm.dashboard?.parent?.find(`.${sectionClass}`).remove();
      if (!isManagedNote(frm)) return;

      // The native Edit / Read mode button calls this handler directly. Keep
      // its existing behavior, then repair visibility for our reports only.
      const nativeSetEditable = frm.events.set_editable;
      if (typeof nativeSetEditable === 'function' && !nativeSetEditable.__oneacpNoteViewer) {
        const setEditable = function (...args) {
          const result = nativeSetEditable.apply(this, args);
          showManagedContent(args[0] || frm);
          return result;
        };
        setEditable.__oneacpNoteViewer = true;
        frm.events.set_editable = setEditable;
      }

      showManagedContent(frm);
      if (frm.is_new() || !frm.dashboard?.add_section) return;

      const isDiary = isCodeDiary(frm);
      if (!isDiary && (!frm.doc.custom_parent_note || !frm.doc.custom_project)) return;
      const body = frm.dashboard.add_section(
        '<p class="text-muted">正在读取…</p>',
        isDiary ? '最近 20 篇开发日报' : '代码日记',
        `custom ${sectionClass}`,
      );
      const state = { name: frm.doc.name, project: frm.doc.custom_project, body };
      refreshes.set(frm, state);
      frm.dashboard.show();
      if (isDiary) {
        void showChildReports(frm, state);
      } else {
        void showParentDiary(frm, state, frm.doc.custom_parent_note);
      }
    },
  });
})();
