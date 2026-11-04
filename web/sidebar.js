/* ==========================================================================
   sidebar.js —— 左栏：工作区目录（契约 6.1）
   点工作区 -> 中栏原地换看板、右栏清空，全程不跳转（由 app.js 统一处理）
   可折叠成图标条，状态记在 localStorage
   ========================================================================== */
(function () {
  'use strict';
  const T = window.TT;
  const S = T.S;

  let listEl = null;
  let rootEl = null;

  // 计数一律走 T.statusCounts（五个状态固定占位、为 0 也显示 0）
  function countsHtml(c) {
    return T.statusCounts(c);
  }

  function render() {
    if (!listEl) return;
    const list = (S.workspaces || []).filter(function (w) { return !Number(w.archived); });
    if (!list.length) {
      listEl.innerHTML = '<div style="padding:10px;font-size:12px;color:var(--muted);text-align:center">' +
        '还没有同步到工作区</div>';
      return;
    }
    listEl.innerHTML = list.map(function (w) {
      const active = w.slug === S.ws ? ' active' : '';
      const initial = String(w.title || w.slug).slice(0, 1).toUpperCase();
      return '<button class="ws-item' + active + '" data-slug="' + T.esc(w.slug) + '" title="' +
          T.esc((w.title || w.slug) + '\n' + (w.path || '')) + '">' +
        '<span class="ws-name">' + T.esc(w.title || w.slug) + '</span>' +
        '<span class="ws-mini">' + countsHtml(w.ticket_counts) + '</span>' +
        '<span class="ws-initial" style="display:none">' + T.esc(initial) + '</span>' +
        '</button>';
    }).join('');
    // 折叠态只显示前两个字
    rootEl.classList.toggle('collapsed', !!S.sidebarCollapsed);
    syncCollapsedLabels();
  }

  function syncCollapsedLabels() {
    if (!rootEl) return;
    const collapsed = rootEl.classList.contains('collapsed');
    rootEl.querySelectorAll('.ws-initial').forEach(function (el) {
      el.style.display = collapsed ? 'inline' : 'none';
    });
  }

  function mount(container) {
    rootEl = container;
    rootEl.className = 'sidebar' + (S.sidebarCollapsed ? ' collapsed' : '');
    rootEl.innerHTML =
      '<div class="sidebar-head"><span class="lbl">工作区</span>' +
        '<button class="icon-btn" id="sidebar-toggle" title="折叠/展开工作区栏" aria-label="折叠/展开工作区栏">' +
          window.icon(S.sidebarCollapsed ? 'chevron-right' : 'chevron-left', 16) + '</button></div>' +
      '<div class="sidebar-list"></div>';
    listEl = rootEl.querySelector('.sidebar-list');

    rootEl.querySelector('#sidebar-toggle').addEventListener('click', function () {
      S.sidebarCollapsed = !S.sidebarCollapsed;
      localStorage.setItem('ai-mcp-ticket-sidebar', S.sidebarCollapsed ? '1' : '0');
      rootEl.classList.toggle('collapsed', S.sidebarCollapsed);
      rootEl.querySelector('#sidebar-toggle').innerHTML =
        window.icon(S.sidebarCollapsed ? 'chevron-right' : 'chevron-left', 16);
      syncCollapsedLabels();
    });

    listEl.addEventListener('click', function (e) {
      const btn = e.target.closest('.ws-item');
      if (!btn) return;
      const slug = btn.getAttribute('data-slug');
      if (slug === S.ws) return;
      T.emit('workspace:select', slug);
    });

    render();
  }

  function refresh(list) {
    if (list) S.workspaces = list;
    render();
  }

  window.Sidebar = { mount: mount, refresh: refresh };
})();
