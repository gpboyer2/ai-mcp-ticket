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

  // 带一个操作按钮的 toast（#58：创建成功后给「复制工单 AI URL」）
  // getText 是函数，点了才取值（因为地址可能要等数据回来才有）
  function toastWithAction(msg, kind, actionLabel, getText) {
    const el = document.createElement('div');
    el.className = 'toast toast-action' + (kind ? ' ' + kind : '');
    el.innerHTML = '<span class="toast-msg">' + esc(msg) + '</span>' +
      '<button type="button" class="toast-btn">' + window.icon('copy', 12) + '<span>' +
      esc(actionLabel) + '</span></button>';
    toastRoot().appendChild(el);
    el.querySelector('.toast-btn').addEventListener('click', async function () {
      const text = typeof getText === 'function' ? getText() : String(getText || '');
      const ok = await copyText(text);
      toast(ok ? '已复制：' + text : '复制失败，请手动复制：' + text, ok ? 'ok' : 'error');
      el.remove();
    });
    // 有操作按钮的 toast 停留久一点，给用户时间点
    setTimeout(function () { el.remove(); }, 9000);
    return el;
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

  /* ---------------- AI 视角抽屉（#53） ----------------
     用户要求（原话要点）：
       · 本项目是开源的，陌生用户装好 MCP 后**没有我们的 docs**，所以文案里绝不能提 docs/CONTRACT.md
       · URL 必须带完整 host（动态取 location.origin），不能只给 /xxx/list 这种半截路径
       · status 不能只写 open，要把 in_progress,reopened 一起写出来
       · 站在「全新、陌生的 AI 和用户」的视角 —— 贴过去就能用，不用再问人
     ------------------------------------------------------------------ */

  // 保持向前兼容 textUrlFor 契约
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

  // 站内绝对地址：origin + 路径（origin 动态取，局域网访问时自然是局域网 IP）
  function absUrl(pathname, search) {
    const p = pathname || '/';
    const s = search || '';
    return window.location.origin + p + s;
  }

  // 某工作区的「进行中」工单纯文本 URL（#53：三个状态都要写全）
  function wsTextUrl(slug) {
    return absUrl('/' + encodeURIComponent(slug) + '/list.txt') + '?status=open,in_progress,reopened';
  }
  // 单张工单纯文本 URL
  function ticketTextUrl(slug, seq) {
    return absUrl('/' + encodeURIComponent(slug) + '/t/' + seq + '.txt');
  }
  // 工作区索引纯文本 URL
  function indexTextUrl() {
    return absUrl('/') + '?format=text';
  }

  // 一条「URL + 说明 + 复制按钮」的卡片
  function urlCard(opts) {
    return '<div class="ai-card">' +
      '<div class="ai-card-head">' +
        '<span class="ai-card-title">' + esc(opts.title) + '</span>' +
        '<button class="btn sm" data-copy="' + esc(opts.url) + '" type="button">' +
          window.icon('copy', 13) + '<span>复制</span></button>' +
      '</div>' +
      '<code class="ai-card-url">' + esc(opts.url) + '</code>' +
      '<p class="ai-card-desc">' + opts.desc + '</p>' +
      '</div>';
  }

  function openAiDrawer() {
    const old = document.getElementById('ai-drawer');
    if (old) old.remove();

    const slug = window.TT.S.ws;
    const seq = window.TT.S.detailSeq;
    const origin = window.location.origin;

    // 当前页面对应的那一条，单独放最上面
    let currentUrl = null;
    let currentLabel = '';
    if (seq) {
      currentUrl = ticketTextUrl(slug, seq);
      currentLabel = '当前这张工单（' + slug + '#' + seq + '）';
    } else if (slug) {
      currentUrl = wsTextUrl(slug);
      currentLabel = '当前工作区的进行中工单（' + slug + '）';
    } else {
      currentUrl = indexTextUrl();
      currentLabel = '全部工作区索引';
    }

    const drawer = document.createElement('div');
    drawer.className = 'drawer ai-drawer';
    drawer.id = 'ai-drawer';
    drawer.innerHTML =
      '<div class="close-row">' +
        '<button class="icon-btn" data-act="close" title="关闭" aria-label="关闭">' +
          window.icon('x', 16) + '</button>' +
      '</div>' +
      '<h2>AI 视角</h2>' +
      '<p class="ai-lead">这个系统所有页面都有一个「纯文本版本」：同一个地址，把 <code>.txt</code> 加在路径末尾（或加 <code>?format=text</code>），' +
        '返回的就是没有 HTML 标签的纯文本。把下面的 URL 直接贴给任何 AI，它就能读懂并操作，不需要额外文档。</p>' +

      '<div class="ai-section-title">当前页面</div>' +
      urlCard({
        title: currentLabel,
        url: currentUrl,
        desc: '把这个地址发给 AI，它立刻就能看到当前上下文的完整内容。'
      }) +

      '<div class="ai-section-title">这个系统里所有可用的纯文本地址</div>' +
      urlCard({
        title: '① 所有工作区 + 各状态工单数',
        url: indexTextUrl(),
        desc: 'AI 用它先摸清有哪些工作区、每个工作区有多少工单。'
      }) +
      urlCard({
        title: '② 某个工作区的「进行中」工单',
        url: slug ? wsTextUrl(slug) : absUrl('/<工作区>/list.txt') + '?status=open,in_progress,reopened',
        desc: '末尾的 <code>?status=</code> 可换成任意组合：' +
          '<code>open</code>（打开）、<code>in_progress</code>（处理中）、<code>reopened</code>（重新打开）、' +
          '<code>done</code>（已完成）、<code>cancelled</code>（已取消）；不写就是全部。' +
          '再加 <code>&amp;q=关键词</code> 可搜索，<code>&amp;maxlen=0</code> 正文不截断。'
      }) +
      urlCard({
        title: '③ 单张工单的全文（含全部评论）',
        url: seq ? ticketTextUrl(slug, seq) : absUrl('/<工作区>/t/<序号>.txt'),
        desc: '把 <code>&lt;工作区&gt;</code> 和 <code>&lt;序号&gt;</code> 换成实际值即可，例如 ' +
          esc(seq ? ticketTextUrl(slug, seq) : absUrl('/my-workspace/t/12.txt')) + '。'
      }) +

      '<div class="ai-section-title">AI 想写东西时（评论 / 建单 / 改状态）</div>' +
      '<p class="ai-note">纯文本地址只读。要写入就用下面这些 HTTP 接口，' +
        '请求头必须带 <code>X-Actor-Id</code> 和 <code>X-Actor-Role: ai</code> 与 <code>X-Actor-Model</code>，' +
        '这样系统才知道「是谁、用什么模型」写的。</p>' +
      '<pre class="ai-code">' + esc([
        '# 加一条评论（把 {id} 换成工单的 id，纯文本里能看到）',
        'curl -X POST ' + origin + '/api/tickets/{id}/comments \\',
        '  -H "Content-Type: application/json" \\',
        '  -H "X-Actor-Id: your-agent-name" \\',
        '  -H "X-Actor-Role: ai" \\',
        '  -H "X-Actor-Model: your-model-name" \\',
        '  -d \'{"body":"我看了，问题在 xxx，已修复"}\'',
        '',
        '# 新建工单',
        'curl -X POST ' + origin + '/api/workspaces/' + (slug || '{工作区}') + '/tickets \\',
        '  -H "Content-Type: application/json" \\',
        '  -H "X-Actor-Id: your-agent-name" \\',
        '  -H "X-Actor-Role: ai" \\',
        '  -H "X-Actor-Model: your-model-name" \\',
        '  -d \'{"title":"标题","body":"正文","priority":1,"status":"open"}\'',
        '',
        '# 改状态 / 改优先级 / 改正文（局部更新）',
        'curl -X PATCH ' + origin + '/api/tickets/{id} \\',
        '  -H "Content-Type: application/json" \\',
        '  -H "X-Actor-Id: your-agent-name" \\',
        '  -H "X-Actor-Role: ai" \\',
        '  -H "X-Actor-Model: your-model-name" \\',
        '  -d \'{"status":"in_progress"}\''
      ].join('\n')) + '</pre>' +
      '<p class="ai-note">上面命令里的 <code>{id}</code> 是工单的 uuid，在纯文本视图里能看到；' +
        '也可以用 <code>{工作区}#{序号}</code> 这种更好读的写法代替。' +
        '写完之后再请求一次同一个纯文本 URL，就能看到最新内容。</p>' +

      '<div class="ai-actions">' +
        '<button class="btn primary" data-copy="' + esc(currentUrl) + '" type="button">' +
          window.icon('copy', 14) + '<span>复制当前 URL</span></button>' +
      '</div>';

    drawer.addEventListener('click', async function (e) {
      const act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'close') { drawer.remove(); return; }
      const copyBtn = e.target.closest && e.target.closest('[data-copy]');
      if (copyBtn) {
        const text = copyBtn.getAttribute('data-copy');
        const ok = await copyText(text);
        toast(ok ? '已复制，贴给 AI 即可' : '复制失败，请手动选中上面的地址', ok ? 'ok' : 'error');
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

    // 用户补充（#46）：这个抽屉点外面可以直接收回 —— 它只展示地址，没有未保存内容
    function onOutside(e) {
      if (!drawer.contains(e.target)) closeDrawer();
    }
    document.addEventListener('keydown', onEsc);
    setTimeout(function () { document.addEventListener('mousedown', onOutside); }, 0);

    return drawer;
  }

  // 复制到剪贴板（带降级方案，非安全上下文也能用）
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 落到下面的降级方案 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
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
    toast: toast, toastWithAction: toastWithAction,
    openModal: openModal, confirmDialog: confirmDialog,
    openMenu: openMenu, closeMenus: closeMenus,
    openAiDrawer: openAiDrawer,
    textUrlFor: textUrlFor,
    absUrl: absUrl, wsTextUrl: wsTextUrl, ticketTextUrl: ticketTextUrl, indexTextUrl: indexTextUrl,
    copyText: copyText,
    applyTheme: applyTheme, currentTheme: currentTheme, toggleTheme: toggleTheme,
    S: S, on: on, emit: emit, normalizeCounts: normalizeCounts
  };
})();
