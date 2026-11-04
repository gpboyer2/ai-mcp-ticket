/* ==========================================================================
   app.js —— 单页三栏编排（契约 6.1 / 6.2）
   核心：全程不跳转。左中右三栏联动，URL 只用 history.pushState 跟随变化，
   浏览器前进/后退由 popstate 还原三栏状态。
     /                  -> 只有左栏，中栏提示「从左边选一个工作区」
     /{ws}/list         -> 左栏选中 ws，中栏看板
     /{ws}/t/{seq}      -> 左栏选中 ws，中栏看板，右栏打开该工单
   ========================================================================== */
(function () {
  'use strict';
  const T = window.TT;
  const S = T.S;

  /* ---------------- URL <-> 状态 ---------------- */
  // 解析路径；slug 里可能有中文和 -，要 decodeURIComponent
  function parsePath(pathname) {
    let path = pathname || '/';
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const parts = path.split('/').filter(Boolean).map(function (p) {
      try { return decodeURIComponent(p); } catch (e) { return p; }
    });
    if (parts.length === 0) return { ws: null, seq: null };
    if (parts.length === 2 && parts[1] === 'list') return { ws: parts[0], seq: null };
    if (parts.length === 3 && parts[1] === 't') return { ws: parts[0], seq: parseInt(parts[2], 10) || null };
    if (parts.length === 1) return { ws: parts[0], seq: null }; // 兼容 /{ws}
    return { ws: null, seq: null };
  }

  function buildPath(ws, seq) {
    if (!ws) return '/';
    return seq == null
      ? '/' + encodeURIComponent(ws) + '/list'
      : '/' + encodeURIComponent(ws) + '/t/' + seq;
  }

  // 只改地址栏，不触发页面加载
  function pushUrl(ws, seq, replace) {
    const path = buildPath(ws, seq);
    if (path === window.location.pathname) return;
    const state = { ws: ws, seq: seq };
    if (replace) history.replaceState(state, '', path);
    else history.pushState(state, '', path);
  }

  /* ---------------- 三栏骨架 ---------------- */
  function shellHtml() {
    return '<div class="shell">' +
      '<div class="app-bar">' +
        '<button class="icon-btn mobile-only" id="bar-hamburger" title="工作区目录" aria-label="工作区目录">' +
          window.icon('menu', 18) + '</button>' +
        '<a class="brand" href="/" id="brand">' + window.icon('ticket', 18) + '<span>Agents 工单</span></a>' +
        '<span class="spacer"></span>' +
        '<button class="btn sm" id="sync-btn" title="从 DeepSeek Harness 重新同步工作区">' +
          window.icon('refresh-cw', 15) + '<span>同步</span></button>' +
        '<button class="btn sm icon-only" id="theme-btn" title="切换深浅色" aria-label="切换深浅色"></button>' +
        '<button class="btn sm" id="ai-btn" title="AI 视角：当前状态的纯文本 URL">' +
          window.icon('bot', 15) + '<span>AI 视角</span></button>' +
      '</div>' +
      '<div class="main">' +
        '<aside class="sidebar" id="sidebar"></aside>' +
        '<section class="board-pane" id="board-pane"></section>' +
        '<aside class="detail-pane hidden" id="detail-pane"></aside>' +
        '<div class="scrim" id="scrim"></div>' +
      '</div>' +
      '</div>';
  }

  function mountShell() {
    document.getElementById('app').innerHTML = shellHtml();

    window.Sidebar.mount(document.getElementById('sidebar'));
    window.Board.mount(document.getElementById('board-pane'));
    window.Detail.mount(document.getElementById('detail-pane'));

    // common.js 里的 applyTheme 在 DOM 就绪前跑过（当时按钮还不存在），这里补一次
    T.applyTheme(T.currentTheme());

    document.getElementById('theme-btn').addEventListener('click', function () {
      T.toggleTheme();
    });
    document.getElementById('ai-btn').addEventListener('click', T.openAiDrawer);
    document.getElementById('sync-btn').addEventListener('click', syncWorkspaces);
    document.getElementById('brand').addEventListener('click', function (e) {
      e.preventDefault();
      selectWorkspace(null);
    });

    // 窄屏抽屉 / 浮层
    document.getElementById('bar-hamburger').addEventListener('click', toggleMobileSidebar);
    document.getElementById('scrim').addEventListener('click', function () {
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('scrim').classList.remove('on');
      if (window.innerWidth <= 1100 && Detail.isOpen()) closeDetail();
    });

    // 三栏联动事件
    T.on('workspace:select', selectWorkspace);
    T.on('sidebar:toggle-mobile', toggleMobileSidebar);
    T.on('ticket:open', function (t) { openTicket(t.seq); });
    T.on('ticket:open-seq', openTicket);
    T.on('detail:close', closeDetail);
    T.on('detail:closed', function () {
      pushUrl(S.ws, null);
      Board.renderColumns();
    });
    T.on('detail:rendered', function () { Board.renderColumns(); });
    T.on('board:filter', function () { loadTickets(); });
    // #61：reload 完成后要回调（新建工单后滚动定位靠它）
    T.on('board:reload', function (done) { loadTickets(done); });
    T.on('board:changed', function () { refreshWorkspaceCounts(); });

    // Esc 关右栏
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && Detail.isOpen() && !document.querySelector('.overlay, .drawer')) {
        closeDetail();
      }
    });
  }

  function toggleMobileSidebar() {
    const sb = document.getElementById('sidebar');
    const scrim = document.getElementById('scrim');
    const willOpen = !sb.classList.contains('open');
    sb.classList.toggle('open', willOpen);
    scrim.classList.toggle('on', willOpen);
  }

  /* ---------------- 数据 ---------------- */
  async function loadWorkspaces() {
    try {
      const list = await T.API.workspaces(true);
      S.workspaces = Array.isArray(list) ? list : (list && list.workspaces) || [];
      Sidebar.refresh(S.workspaces);
    } catch (err) {
      T.toast('加载工作区失败：' + err.message, 'error');
    }
  }

  async function syncWorkspaces() {
    const btn = document.getElementById('sync-btn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = window.icon('refresh-cw', 15, 'spin') + '<span>同步中…</span>';
    }
    try {
      const r = await T.API.syncWorkspaces();
      T.toast('同步完成：新增 ' + (r.added || 0) + '，更新 ' + (r.updated || 0) + '，归档 ' + (r.archived || 0), 'ok');
      await loadWorkspaces();
    } catch (err) {
      T.toast('同步失败：' + err.message, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = window.icon('refresh-cw', 15) + '<span>同步</span>';
      }
    }
  }

  /**
   * 拉工单并重绘看板
   * @param {Function} [done] 重绘完成后回调（#61 新建后要用它来滚动定位）
   */
  async function loadTickets(done) {
    if (!S.ws) {
      S.tickets = [];
      if (typeof done === 'function') done();
      return;
    }
    try {
      const data = await T.API.tickets(S.ws, {
        limit: 500,
        q: S.q || undefined,
        status: S.statusFilter || undefined
      });
      S.tickets = (data && data.tickets) || [];
      S.workspace = (data && data.workspace) || S.workspace;
      S.counts = T.normalizeCounts(data && data.counts, S.tickets);
      Board.render();
      if (typeof done === 'function') done();
    } catch (err) {
      // M3：不能静默显示成「没有工单」——必须让用户知道是加载失败了
      T.toast('加载工单失败：' + err.message, 'error');
      Board.showLoadError(err.message, function () { loadTickets(); });
    }
  }

  // 拖拽/增删改后只更新左栏计数，不整页刷新
  async function refreshWorkspaceCounts() {
    try {
      const list = await T.API.workspaces(true);
      S.workspaces = Array.isArray(list) ? list : [];
      Sidebar.refresh(S.workspaces);
    } catch (e) {
      // M3：左栏计数刷新失败要留痕（不弹 toast 打扰，但 console 有记录且可重试）
      console.warn('[sidebar] 刷新工作区计数失败：', e && e.message);
    }
  }

  /* ---------------- 三栏联动动作 ---------------- */
  async function selectWorkspace(slug) {
    // 同一个工作区再点一次：只收起移动端抽屉
    if (slug === S.ws) {
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('scrim').classList.remove('on');
      return;
    }
    S.ws = slug || null;
    S.workspace = null;
    S.tickets = [];
    S.counts = null;
    S.q = '';
    S.statusFilter = '';
    S.detailSeq = null;
    S.detailTicket = null;

    Detail.close(); // 右栏清空

    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('scrim').classList.remove('on');

    if (!S.ws) {
      pushUrl(null, null);
      renderEmptyBoard();
      Sidebar.refresh();
      return;
    }

    pushUrl(S.ws, null);
    Sidebar.refresh();
    if (!document.getElementById('board')) Board.mount(document.getElementById('board-pane'));
    Board.render();
    await loadTickets();
  }

  function renderEmptyBoard() {
    const pane = document.getElementById('board-pane');
    if (!pane) return;
    pane.innerHTML = '<div class="pane-head">' +
        '<button class="icon-btn mobile-only" id="hamburger2" title="工作区目录" aria-label="工作区目录">' +
          window.icon('menu', 18) + '</button>' +
        '<h1 class="pane-title">Agents 工单</h1>' +
      '</div>' +
      '<div class="pane-empty">' + window.icon('arrow-left', 18) + '<span>从左边选一个工作区</span></div>';
    const h = document.getElementById('hamburger2');
    if (h) h.addEventListener('click', toggleMobileSidebar);
    document.title = 'Agents 工单';
  }

  async function openTicket(seq) {
    if (!S.ws) return;
    seq = Number(seq);
    if (!seq) return;
    S.detailSeq = seq;
    pushUrl(S.ws, seq);
    Board.renderColumns(); // 高亮当前卡
    await Detail.load(S.ws, seq);
    if (window.innerWidth <= 1100) document.getElementById('scrim').classList.add('on');
  }

  function closeDetail() {
    S.detailSeq = null;
    Detail.close();
    if (window.innerWidth <= 1100) document.getElementById('scrim').classList.remove('on');
  }

  /* ---------------- 启动 + 前进后退 ---------------- */
  // 把 URL 还原成三栏状态（不重新加载页面）
  async function applyRoute(route) {
    S.ws = route.ws || null;
    S.workspace = null;
    S.tickets = [];
    S.counts = null;
    S.q = '';
    S.statusFilter = '';
    S.detailSeq = route.seq || null;

    Sidebar.refresh();

    if (!route.ws) {
      Detail.close();
      renderEmptyBoard();
      return;
    }

    if (!document.getElementById('board')) Board.mount(document.getElementById('board-pane'));
    Board.render();
    await loadTickets();

    if (route.seq) {
      Board.renderColumns();
      await Detail.load(route.ws, route.seq);
      if (window.innerWidth <= 1100) document.getElementById('scrim').classList.add('on');
    } else {
      Detail.close();
    }
  }

  async function boot() {
    mountShell();
    // #49：状态下拉从界面移除后，仍支持用 URL 上的 ?status= 直达某个筛选视图
    const qs0 = new URLSearchParams(window.location.search);
    if (qs0.get('status')) S.statusFilter = qs0.get('status');
    const initial = parsePath(window.location.pathname);
    history.replaceState({ ws: initial.ws, seq: initial.seq }, '', window.location.pathname);

    await loadWorkspaces();

    if (!initial.ws) renderEmptyBoard();
    else await applyRoute(initial);

    window.addEventListener('popstate', function (e) {
      const st = e.state || parsePath(window.location.pathname);
      applyRoute({ ws: st.ws || null, seq: st.seq || null });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
