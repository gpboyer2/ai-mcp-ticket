/* ==========================================================================
   common.js —— 全局公共能力（v2 单页三栏版）
   1) 主题（深浅色，localStorage 记忆，默认跟随系统）
   2) REST API（写请求一律带 X-Actor-Role: user）
   3) 通用 UI：toast、弹窗、右键菜单、AI 视角抽屉
   4) 「标题+正文合并成一个输入框」的拆解/拼回（契约 6.3）
   5) 全局状态 store 与页面间广播
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------- 常量 ---------------- */
  // icon 用 Lucide：open=circle、in_progress=circle-dashed、reopened=rotate-ccw、
  // done=circle-check、cancelled=circle-x
  const STATUS = [
    { key: 'open', label: '打开', color: 'var(--st-open)', icon: 'circle' },
    { key: 'in_progress', label: '处理中', color: 'var(--st-in_progress)', icon: 'circle-dashed' },
    { key: 'reopened', label: '重新打开', color: 'var(--st-reopened)', icon: 'rotate-ccw' },
    { key: 'done', label: '已完成', color: 'var(--st-done)', icon: 'circle-check' },
    { key: 'cancelled', label: '已取消', color: 'var(--st-cancelled)', icon: 'circle-x' }
  ];
  const STATUS_LABEL = {}, STATUS_COLOR = {}, STATUS_ICON = {};
  STATUS.forEach(function (s) {
    STATUS_LABEL[s.key] = s.label;
    STATUS_COLOR[s.key] = s.color;
    STATUS_ICON[s.key] = s.icon;
  });

  const PRIORITY = [
    { value: 0, label: '低', icon: 'arrow-down' },
    { value: 1, label: '普通', icon: 'minus' },
    { value: 2, label: '高', icon: 'arrow-up' },
    { value: 3, label: '紧急', icon: 'triangle-alert' }
  ];
  const PRIORITY_LABEL = {}, PRIORITY_ICON = {};
  PRIORITY.forEach(function (p) { PRIORITY_LABEL[p.value] = p.label; PRIORITY_ICON[p.value] = p.icon; });

  const STEP = 1024;
  const TITLE_MAX = 200;

  /* ---------------- 主题 ---------------- */
  const THEME_KEY = 'ai-mcp-ticket-theme';
  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function currentTheme() { return localStorage.getItem(THEME_KEY) || systemTheme(); }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const btn = document.getElementById('theme-btn');
    if (btn) {
      // 深色主题下显示太阳（点了变浅色），浅色下显示月亮
      const dark = theme === 'dark';
      btn.innerHTML = window.icon(dark ? 'sun' : 'moon', 16);
      btn.title = dark ? '切换到浅色' : '切换到深色';
      btn.setAttribute('aria-label', btn.title);
    }
  }
  function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  }
  applyTheme(currentTheme());
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (!localStorage.getItem(THEME_KEY)) applyTheme(systemTheme());
    });
  }

  /* ---------------- API ---------------- */
  const WRITE_HEADERS = { 'X-Actor-Id': 'user', 'X-Actor-Role': 'user', 'Content-Type': 'application/json' };

  async function api(path, options) {
    const opts = options || {};
    const method = (opts.method || 'GET').toUpperCase();
    const headers = method === 'GET'
      ? { Accept: 'application/json' }
      : Object.assign({ Accept: 'application/json' }, WRITE_HEADERS);
    const init = { method: method, headers: headers };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      throw new Error('网络请求失败：' + e.message);
    }
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
    if (!res.ok) {
      const err = new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
      err.code = data && data.error && data.error.code;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const API = {
    workspaces: function (includeArchived) {
      return api('/api/workspaces' + (includeArchived ? '?include_archived=1' : ''));
    },
    syncWorkspaces: function () { return api('/api/workspaces/sync', { method: 'POST', body: {} }); },
    // 看板要显示「最后一条评论」，按契约 3.2 用 with_comments=1 让后端一并返回
    tickets: function (ws, query) {
      const q = query || {};
      const qs = new URLSearchParams();
      if (q.status) qs.set('status', q.status);
      if (q.q) qs.set('q', q.q);
      if (q.sort) qs.set('sort', q.sort);
      if (q.order) qs.set('order', q.order);
      qs.set('limit', String(q.limit || 500));
      if (q.withComments !== false) qs.set('with_comments', '1');
      return api('/api/workspaces/' + encodeURIComponent(ws) + '/tickets?' + qs.toString());
    },
    createTicket: function (ws, body) {
      return api('/api/workspaces/' + encodeURIComponent(ws) + '/tickets', { method: 'POST', body: body });
    },
    // :id 也接受 ref 形式（slug#seq）
    getTicket: function (idOrRef) { return api('/api/tickets/' + encodeURIComponent(idOrRef)); },
    patchTicket: function (id, body) {
      return api('/api/tickets/' + encodeURIComponent(id), { method: 'PATCH', body: body });
    },
    deleteTicket: function (id) {
      return api('/api/tickets/' + encodeURIComponent(id), { method: 'DELETE' });
    },
    addComment: function (ticketId, body) {
      return api('/api/tickets/' + encodeURIComponent(ticketId) + '/comments', { method: 'POST', body: { body: body } });
    },
    patchComment: function (id, body) {
      return api('/api/comments/' + encodeURIComponent(id), { method: 'PATCH', body: { body: body } });
    },
    deleteComment: function (id) {
      return api('/api/comments/' + encodeURIComponent(id), { method: 'DELETE' });
    }
  };

  /* ---------------- 小工具 ---------------- */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const p = function (n) { return n < 10 ? '0' + n : String(n); };
    const sameYear = d.getFullYear() === new Date().getFullYear();
    const date = (sameYear ? '' : d.getFullYear() + '-') + p(d.getMonth() + 1) + '-' + p(d.getDate());
    return date + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function timeTag(iso) {
    return '<span title="' + esc(iso || '') + '">' + esc(fmtTime(iso)) + '</span>';
  }
  function priorityPill(p) {
    const v = Number(p == null ? 1 : p);
    const name = PRIORITY_ICON[v] || 'minus';
    return '<span class="pill pr-' + v + '" title="优先级：' + esc(PRIORITY_LABEL[v] || v) + '">' +
      window.icon(name, 11) + '<span>' + esc(PRIORITY_LABEL[v] || ('P' + v)) + '</span></span>';
  }
  function statusBadge(s) {
    const key = STATUS_LABEL[s] ? s : 'open';
    return '<span class="status-badge" style="color:' + STATUS_COLOR[key] + '">' +
      window.icon(STATUS_ICON[key], 14) + '<span>' + esc(STATUS_LABEL[key]) + '</span></span>';
  }
  function statusDot(s) {
    const key = STATUS_LABEL[s] ? s : 'open';
    return '<span class="dot" style="color:' + STATUS_COLOR[key] + '">' +
      window.icon(STATUS_ICON[key], 13) + '</span>';
  }
  function depsList(blockedBy) {
    return String(blockedBy || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function actorText(role, id, model) {
    if (role === 'ai') return (id || 'AI') + (model ? '（' + model + '）' : '');
    return '用户本人';
  }
  function truncate(s, n) {
    const str = String(s || '').replace(/\s+/g, ' ').trim();
    return str.length > n ? str.slice(0, n) + '…' : str;
  }
  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }
  function lastComment(t) {
    if (t.last_comment) return t.last_comment;
    const cs = t.comments;
    return cs && cs.length ? cs[cs.length - 1] : null;
  }

  /* ---------------- 标题/正文合并输入框（契约 6.3） ---------------- */
  // 提交：第一行（去掉行首 #、-、*、空白）作 title，其余行作 body
  function splitMerged(text) {
    const raw = String(text || '').replace(/\r\n/g, '\n');
    const lines = raw.split('\n');
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim()) { idx = i; break; }
    }
    if (idx === -1) return { title: '', body: '' };

    const titleLine = lines[idx].trim().replace(/^[#\-*\u3000\s]+/, '').trim();
    let bodyLines = lines.slice(idx + 1);
    let title = titleLine;
    if (title.length > TITLE_MAX) {
      // 标题超长：截断，溢出的部分并回正文开头，不丢用户内容
      bodyLines = [titleLine.slice(TITLE_MAX)].concat(bodyLines);
      title = titleLine.slice(0, TITLE_MAX);
    }
    return { title: title, body: bodyLines.join('\n').replace(/^\n+/, '').replace(/\s+$/, '') };
  }

  // 编辑：把 title 与 body 拼回一个框
  function joinMerged(t) {
    const title = String((t && t.title) || '');
    const body = String((t && t.body) || '');
    return body ? title + '\n\n' + body : title;
  }

  /* ---------------- toast ---------------- */
  function toastRoot() {
    let root = document.getElementById('toast-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'toast-root';
      document.body.appendChild(root);
    }
    return root;
  }
  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    toastRoot().appendChild(el);
    setTimeout(function () { el.remove(); }, kind === 'error' ? 3600 : 2200);
  }

  /* ---------------- 弹窗 ----------------
     #46（用户 ai-剧本#46）：点弹窗外、按 ESC 都**不关闭**，必须显式点「取消」/「×」/「保存」。
     理由：用户写长正文时手滑点到外面就丢内容，代价太大。
     注意：下拉（deps-picker）的 Esc 关闭是另一回事，那是下拉不是弹窗，保留。
     ------------------------------------------------------------------ */
  function openModal(cfg) {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true">' +
        '<div class="modal-head"><h2>' + esc(cfg.title || '') + '</h2>' +
          '<button class="icon-btn" data-act="close" title="关闭" aria-label="关闭">' +
            window.icon('x', 16) + '</button></div>' +
        '<div class="modal-body">' + (cfg.bodyHtml || '') + '</div>' +
        '<div class="modal-foot">' +
          '<button class="btn" data-act="close">取消</button>' +
          '<button class="btn primary" data-act="ok">' + esc(cfg.okText || '确定') + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    const modal = overlay.querySelector('.modal');

    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      if (cfg.onClose) cfg.onClose();
    }

    // 只认显式按钮：× 或「取消」
    overlay.addEventListener('click', function (e) {
      const act = e.target.closest && e.target.closest('[data-act="close"]');
      if (act) close();
      // 点遮罩空白处：什么都不做（#46）
    });

    // ESC：默认不关弹窗（#46 用户补充要求）。
    // 唯一例外：如果弹窗里有展开的依赖下拉，先让下拉自己处理 Esc，这里仍不关弹窗。
    function onKey(e) {
      if (e.key !== 'Escape') return;
      const openList = modal.querySelector('.deps-list:not([hidden])');
      if (!openList) {
        // 阻止冒泡，避免被其他全局 Esc 处理器当成「关闭当前面板」
        e.stopPropagation();
      }
    }
    document.addEventListener('keydown', onKey, true);
    overlay._onKey = onKey;
    const okBtn = overlay.querySelector('[data-act="ok"]');
    okBtn.addEventListener('click', async function () {
      if (!cfg.onOk) return close();
      okBtn.disabled = true;
      try {
        const ret = await cfg.onOk(modal, close);
        if (ret !== false) close();
      } catch (err) {
        toast(err.message || '操作失败', 'error');
      } finally {
        okBtn.disabled = false;
      }
    });
    if (cfg.onMount) cfg.onMount(modal, close);
    const first = modal.querySelector('textarea, input, select');
    if (first) setTimeout(function () { first.focus(); }, 30);
    return { root: overlay, close: close };
  }

  function confirmDialog(title, message, okText) {
    return new Promise(function (resolve) {
      let done = false;
      openModal({
        title: title,
        bodyHtml: '<p style="margin:0;font-size:13px;line-height:1.7">' + esc(message) + '</p>',
        okText: okText || '确定',
        onOk: function () { done = true; resolve(true); },
        onClose: function () { if (!done) resolve(false); }
      });
    });
  }

  /* ---------------- 右键 / ⋯ 菜单 ---------------- */
  function closeMenus() {
    document.querySelectorAll('.menu').forEach(function (m) { m.remove(); });
  }
  function openMenu(x, y, items) {
    closeMenus();
    const menu = document.createElement('div');
    menu.className = 'menu';
    items.forEach(function (it) {
      const b = document.createElement('button');
      if (it.danger) b.className = 'danger';
      // 菜单项带图标时用图标 + 文字，保证与页面其他图标成套
      if (it.icon && window.icon) {
        b.innerHTML = window.icon(it.icon, 14) + '<span>' + esc(it.label) + '</span>';
      } else {
        b.textContent = it.label;
      }
      b.addEventListener('click', function () { closeMenus(); it.onClick(); });
      menu.appendChild(b);
    });
    menu.style.left = '0px';
    menu.style.top = '0px';
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
    return menu;
  }
  document.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('.menu')) closeMenus();
  });
  document.addEventListener('scroll', closeMenus, true);

  /* ---------------- AI 视角抽屉 ---------------- */
  function textUrlFor(pathname, search, useLanHint) {
    const params = new URLSearchParams(search || '');
    params.set('format', 'text');
    params.delete('maxlen');
    const qs = params.toString();
    let host = window.location.host;
    if (useLanHint && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
      host = '<局域网IP>:' + (window.location.port || '47321');
    }
    return window.location.protocol + '//' + host + pathname + (qs ? '?' + qs : '');
  }

  function openAiDrawer() {
    const old = document.getElementById('ai-drawer');
    if (old) old.remove();

    const drawer = document.createElement('div');
    drawer.className = 'drawer';
    drawer.id = 'ai-drawer';
    drawer.innerHTML =
      '<div class="close-row"><button class="icon-btn" data-act="close" title="关闭" aria-label="关闭">' +
        window.icon('x', 16) + '</button></div>' +
      '<h2>AI 视角 · 当前状态的纯文本地址</h2>' +
      '<p>把这条 URL 贴给 AI 即可 —— 它拿到的是纯文本，不带任何 HTML 噪音，省 token。</p>' +
      '<textarea class="url-box" id="ai-url" readonly></textarea>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn primary" data-act="copy">一键复制</button>' +
        '<button class="btn" data-act="lan">换成局域网 IP 写法</button>' +
      '</div>' +
      '<div class="tip">把这条 URL 贴给 AI 即可。</div>' +
      '<p>同一条内容还有三种等价取法：末尾加 <code>.txt</code>、加 <code>?format=text</code>、或让 AI 用 <code>Accept: text/plain</code> 请求原地址。</p>';

    const ta = drawer.querySelector('#ai-url');
    const path = window.location.pathname;
    const search = window.location.search;
    ta.value = textUrlFor(path, search, false);

    drawer.addEventListener('click', async function (e) {
      const act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'close') drawer.remove();
      if (act === 'lan') ta.value = textUrlFor(path, search, ta.value.indexOf('<局域网IP>') === -1);
      if (act === 'copy') {
        try {
          await navigator.clipboard.writeText(ta.value);
          toast('已复制，贴给 AI 即可', 'ok');
        } catch (err) {
          ta.removeAttribute('readonly');
          ta.select();
          document.execCommand('copy');
          ta.setAttribute('readonly', 'readonly');
          toast('已复制，贴给 AI 即可', 'ok');
        }
      }
    });
    document.body.appendChild(drawer);

    // 统一的收尾：移除抽屉 + 摘掉两个全局监听，避免泄漏
    function closeDrawer() {
      drawer.remove();
      document.removeEventListener('keydown', onEsc);
      document.removeEventListener('mousedown', onOutside);
    }
    function onEsc(e) { if (e.key === 'Escape') closeDrawer(); }

    // 用户补充（#46）：这个抽屉点外面可以直接收回 —— 它只展示一条 URL，没有未保存内容，
    // 不属于「点了外面就丢东西」的表单弹窗，所以维持点外关闭的交互。
    function onOutside(e) {
      if (!drawer.contains(e.target)) closeDrawer();
    }
    document.addEventListener('keydown', onEsc);
    // 延迟挂载，避免「点开抽屉的那一次点击」立刻把它关掉
    setTimeout(function () { document.addEventListener('mousedown', onOutside); }, 0);

    return drawer;
  }

  /* ---------------- 全局状态 + 广播 ---------------- */
  // 三个面板都从这一个 store 读，改完统一 emit，避免各自维护副本
  const S = {
    workspaces: [],
    ws: null,          // 当前工作区 slug
    workspace: null,   // 当前工作区对象
    tickets: [],
    counts: null,      // 全量计数
    q: '',
    // #49 起界面上的「全部状态」下拉已删除；此字段仅用于从 URL ?status= 初始化（分享链接/AI 直达）
    statusFilter: '',
    detailSeq: null,   // 右栏打开的工单 seq
    detailTicket: null,
    sidebarCollapsed: localStorage.getItem('ai-mcp-ticket-sidebar') === '1'
  };

  const listeners = {};
  function on(evt, fn) {
    (listeners[evt] = listeners[evt] || []).push(fn);
  }
  function emit(evt, payload) {
    (listeners[evt] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error('[emit ' + evt + ']', e); }
    });
  }

  // 全量计数：优先用后端 counts.total；后端没给就自己加（契约要求有，做兼容）
  function normalizeCounts(c, tickets) {
    const out = { open: 0, in_progress: 0, reopened: 0, done: 0, cancelled: 0, total: 0 };
    STATUS.forEach(function (s) { out[s.key] = Number((c && c[s.key]) || 0); });
    let sum = 0;
    STATUS.forEach(function (s) { sum += out[s.key]; });
    out.total = Number(c && c.total) || sum;
    if (c && c.total == null && tickets && tickets.length) {
      // 后端还没给 total：用返回的工单自己算（无筛选时才是准的）
      let n = 0;
      tickets.forEach(function (t) { if (out[t.status] !== undefined) n++; });
      out.total = Math.max(out.total, n);
    }
    return out;
  }

  window.TT = {
    STATUS: STATUS, STATUS_LABEL: STATUS_LABEL, STATUS_COLOR: STATUS_COLOR, STATUS_ICON: STATUS_ICON,
    PRIORITY: PRIORITY, PRIORITY_LABEL: PRIORITY_LABEL, PRIORITY_ICON: PRIORITY_ICON,
    STEP: STEP, TITLE_MAX: TITLE_MAX,
    api: api, API: API,
    esc: esc, fmtTime: fmtTime, timeTag: timeTag, priorityPill: priorityPill,
    statusBadge: statusBadge, statusDot: statusDot, depsList: depsList,
    actorText: actorText, truncate: truncate, debounce: debounce, lastComment: lastComment,
    splitMerged: splitMerged, joinMerged: joinMerged,
    toast: toast, openModal: openModal, confirmDialog: confirmDialog,
    openMenu: openMenu, closeMenus: closeMenus,
    openAiDrawer: openAiDrawer, textUrlFor: textUrlFor,
    applyTheme: applyTheme, currentTheme: currentTheme, toggleTheme: toggleTheme,
    S: S, on: on, emit: emit, normalizeCounts: normalizeCounts
  };
})();
