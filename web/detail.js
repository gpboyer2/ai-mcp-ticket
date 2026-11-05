/* ==========================================================================
   detail.js —— 右栏：工单详情（契约 6.1）
   点中栏卡片 -> 右栏原地渲染，中栏看板不消失
   可关闭（回两栏）、可拖宽（宽度记在 localStorage）
   评论时间线：user / ai 两种样式，ai 显示 model；评论可编辑、可删除
   ========================================================================== */
(function () {
  'use strict';
  const T = window.TT;
  const S = T.S;

  const WIDTH_KEY = 'ai-mcp-ticket-detail-width';
  let rootEl = null;
  let seq = null;       // 当前显示的工单 seq
  let ticket = null;
  let comments = [];
  let open = false;

  /* ---------------- 骨架 ---------------- */
  function mount(container) {
    rootEl = container;
    const w = Number(localStorage.getItem(WIDTH_KEY));
    if (w && w >= 300) rootEl.style.width = w + 'px';
    rootEl.innerHTML =
      '<div class="resize-handle" id="resize-handle" title="拖动调整宽度"></div>' +
      '<div class="pane-head">' +
        '<span class="ref" id="d-ref"></span>' +
        '<span class="spacer"></span>' +
        '<button class="icon-btn" id="d-close" title="关闭详情" aria-label="关闭详情">' +
          window.icon('x', 16) + '</button>' +
      '</div>' +
      '<div class="detail-scroll" id="d-body"></div>';
    document.getElementById('d-close').addEventListener('click', function () {
      T.emit('detail:close');
    });
    bindResize();
    // #6：详情是浮层，点它外面就关掉。
    // 用 pointerdown 而非 click：点看板卡片时先关旧详情，卡片再开新详情；
    // 若用 click，卡片的 click 先跑、刚开的详情会被这里误关。
    // 弹窗(.overlay)/抽屉(.drawer)/菜单(.menu)/toast/顶栏(.app-bar) 这些浮层不算「外面」。
    document.addEventListener('pointerdown', onOutsidePointerDown);
  }

  // #6：点详情面板之外的区域自动关闭
  function onOutsidePointerDown(e) {
    if (!open || !rootEl) return;
    if (rootEl.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.overlay, .drawer, .menu, #toast-root, .app-bar')) return;
    T.emit('detail:close');
  }

  function bindResize() {
    const handle = document.getElementById('resize-handle');
    if (!handle) return;
    let startX = 0, startW = 0;
    function onMove(e) {
      const delta = startX - e.clientX; // 往左拖变宽
      const w = Math.max(300, Math.min(window.innerWidth * 0.7, startW + delta));
      rootEl.style.width = w + 'px';
    }
    function onUp() {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      localStorage.setItem(WIDTH_KEY, String(parseInt(rootEl.style.width, 10) || 420));
    }
    handle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      startX = e.clientX;
      startW = rootEl.getBoundingClientRect().width;
      handle.classList.add('dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  /* ---------------- 渲染 ---------------- */
  function depsInline(blockedBy) {
    const deps = T.depsList(blockedBy);
    if (!deps.length) return '<span style="color:var(--muted)">无</span>';
    return deps.map(function (ref) {
      return '<a href="#" data-dep="' + T.esc(ref) + '"><code>' + T.esc(ref) + '</code></a>';
    }).join('、');
  }

  // 认领只对 AI 生效（MCP 的 ticket_claim / ticket_release），人类界面不提供认领 / 释放操作。
  // 这里只读：被认领时给一行状态，提示用户此刻无法编辑（写操作会被 409 挡）。
  function claimedChipHtml(t) {
    if (!t.assignee_id) return '';
    const who = t.assignee_role === 'ai'
      ? 'ai:' + t.assignee_id + (t.assignee_model ? '（' + t.assignee_model + '）' : '')
      : '用户本人';
    return '<span class="meta-chip meta-claimed" title="' +
        T.esc('AI 认领于 ' + (t.claimed_at || '') + '，超过 6 小时自动失效') + '">' +
      window.icon(t.assignee_role === 'ai' ? 'bot' : 'user', 12) +
      '<span>已被 ' + T.esc(who) + ' 认领</span></span>';
  }

  // #54 + #13：详情页两段式 —— 「元信息条」+「内容」，没有大标题概念
  function headHtml(t) {
    const depN = T.depsList(t.blocked_by).length;
    return '' +
      // ① 元信息条：一行 chip，间距统一
      '<div class="meta-bar" id="d-meta">' +
        '<span class="meta-chip meta-status">' + T.statusBadge(t.status) + '</span>' +
        '<span class="meta-chip">' + T.priorityPill(t.priority) + '</span>' +
        '<span class="meta-chip" title="' + T.esc(t.blocked_by || '无依赖') + '">' +
          window.icon('link', 12) + '<span>依赖 ' + (depN || '无') + '</span></span>' +
        '<span class="meta-chip">' + window.icon(t.actor_role === 'ai' ? 'bot' : 'user', 12) +
          '<span>' + T.esc(T.actorText(t.actor_role, t.actor_id, t.model)) + '</span></span>' +
        claimedChipHtml(t) +
        '<span class="meta-chip">' + window.icon('clock', 12) + '<span>建于 ' + T.fmtTime(t.created_at) + '</span></span>' +
        '<span class="meta-chip">' + window.icon('refresh-cw', 12) + '<span>更新于 ' + T.fmtTime(t.updated_at) + '</span></span>' +
      '</div>' +

      // ② 操作工具栏：右对齐一组
      '<div class="detail-toolbar">' +
        '<span class="spacer"></span>' +
        '<select class="select sm" id="d-status" title="改状态">' +
          T.STATUS.map(function (s) {
            return '<option value="' + s.key + '"' + (t.status === s.key ? ' selected' : '') + '>' +
              T.esc(s.label) + '</option>';
          }).join('') +
        '</select>' +
        '<select class="select sm" id="d-priority" title="改优先级">' +
          T.PRIORITY.map(function (p) {
            return '<option value="' + p.value + '"' + (Number(t.priority) === p.value ? ' selected' : '') + '>' +
              T.esc(p.label) + '</option>';
          }).join('') +
        '</select>' +
        '<button class="btn sm" id="d-copy-ai" type="button" title="复制这张工单的 Agents 纯文本 URL">' +
          window.icon('copy', 13) + '<span>AI URL</span></button>' +
        '<button class="btn sm" id="d-edit" type="button">' +
          window.icon('pencil', 13) + '<span>编辑</span></button>' +
        '<button class="btn sm danger" id="d-del" type="button">' +
          window.icon('trash-2', 13) + '<span>删除</span></button>' +
      '</div>' +

      // ③ 内容区：content 原文整段显示（只有 content 一个内容字段，没有标题可抽）
      (function () {
        const full = String(t.content || '');
        return '' +
          '<div class="content-block">' +
            '<div class="body-text' + (full ? '' : ' empty') + '" id="d-text">' +
              (full ? window.Images.renderMarkdownImages(full) : '<span class="content-empty">还没有内容</span>') +
            '</div>' +
          '</div>';
      })() +

      // ④ 评论区：分组标题 + 分隔线，和正文拉开呼吸感
      '<div class="comments-block">' +
        '<div class="section-divider">' +
          '<span class="section-title">' + window.icon('message-square', 13) +
            '<span>评论 <span id="d-cmt-n">0</span></span></span>' +
        '</div>' +
        '<ul class="cmt-list" id="d-cmt-list"></ul>' +
        '<div class="cmt-compose">' +
          '<textarea class="textarea" id="d-cmt-input" ' +
            'placeholder="写评论…（可直接 Ctrl/⌘+V 粘贴图片、拖入图片文件）" style="min-height:70px"></textarea>' +
          '<div class="img-hint" id="d-cmt-hint" hidden></div>' +
          '<div class="cmt-actions">' +
            '<button class="btn sm" id="d-cmt-img" type="button" title="插入图片（也可直接粘贴或拖入）">' +
              window.icon('image-plus', 14) + '<span>图片</span></button>' +
            '<input type="file" id="d-cmt-file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>' +
            '<span class="spacer"></span>' +
            '<button class="btn primary sm" id="d-cmt-send">发表评论</button>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function commentHtml(c) {
    const isAi = c.actor_role === 'ai';
    return '<li class="cmt ' + (isAi ? 'ai' : 'user') + '" data-id="' + T.esc(c.id) + '">' +
      '<div class="cmt-head">' +
        '<span class="who">' + window.icon(isAi ? 'bot' : 'user', 13) + '<span>' +
          T.esc(isAi ? (c.actor_id || 'AI') : '用户本人') + '</span></span>' +
        (isAi && c.model ? '<span class="model">' + T.esc(c.model) + '</span>' : '') +
        T.timeTag(c.created_at) +
        (c.updated_at && c.updated_at !== c.created_at ? '<span>（已编辑）</span>' : '') +
        '<span class="acts">' +
          '<button class="icon-btn" data-act="edit" title="编辑评论" aria-label="编辑评论">' +
            window.icon('pencil', 13) + '</button>' +
          '<button class="icon-btn" data-act="del" title="删除评论" aria-label="删除评论">' +
            window.icon('trash-2', 13) + '</button>' +
        '</span>' +
      '</div>' +
      '<div class="cmt-body">' + window.Images.renderMarkdownImages(c.body) + '</div>' +
      '</li>';
  }

  function renderComments() {
    const list = document.getElementById('d-cmt-list');
    if (!list) return;
    list.innerHTML = comments.length
      ? comments.map(commentHtml).join('')
      : '<li style="color:var(--muted);font-size:12.5px">还没有评论。</li>';
    const n = document.getElementById('d-cmt-n');
    if (n) n.textContent = String(comments.length);
  }

  function render() {
    if (!rootEl || !ticket) return;
    const body = document.getElementById('d-body');
    const refEl = document.getElementById('d-ref');
    if (refEl) refEl.textContent = ticket.ref || '';
    body.innerHTML = headHtml(ticket);
    renderComments();
    bindEvents();
    open = true;
    rootEl.classList.remove('hidden');
  }

  function updateMeta() {
    const t = ticket;
    const bar = document.getElementById('d-meta');
    if (bar) {
      const depN = T.depsList(t.blocked_by).length;
      bar.innerHTML =
        '<span class="meta-chip meta-status">' + T.statusBadge(t.status) + '</span>' +
        '<span class="meta-chip">' + T.priorityPill(t.priority) + '</span>' +
        '<span class="meta-chip" title="' + T.esc(t.blocked_by || '无依赖') + '">' +
          window.icon('link', 12) + '<span>依赖 ' + (depN || '无') + '</span></span>' +
        '<span class="meta-chip">' + window.icon(t.actor_role === 'ai' ? 'bot' : 'user', 12) +
          '<span>' + T.esc(T.actorText(t.actor_role, t.actor_id, t.model)) + '</span></span>' +
        claimedChipHtml(t) +
        '<span class="meta-chip">' + window.icon('clock', 12) + '<span>建于 ' + T.fmtTime(t.created_at) + '</span></span>' +
        '<span class="meta-chip">' + window.icon('refresh-cw', 12) + '<span>更新于 ' + T.fmtTime(t.updated_at) + '</span></span>';
    }
    const st = document.getElementById('d-status');
    if (st) st.value = t.status;
    const pr = document.getElementById('d-priority');
    if (pr) pr.value = String(t.priority);
  }

  /* ---------------- 事件 ---------------- */
  function bindEvents() {
    const body = document.getElementById('d-body');

    document.getElementById('d-status').addEventListener('change', async function (e) {
      const next = e.target.value, old = ticket.status;
      ticket.status = next;
      updateMeta();
      try {
        const updated = await T.API.patchTicket(ticket.id, { status: next });
        Object.assign(ticket, updated || {});
        updateMeta();
        T.toast('状态已改为「' + T.STATUS_LABEL[next] + '」', 'ok');
        T.emit('board:reload');
      } catch (err) {
        ticket.status = old;
        updateMeta();
        T.toast('改状态失败，已回滚：' + err.message, 'error');
      }
    });

    document.getElementById('d-priority').addEventListener('change', async function (e) {
      const next = Number(e.target.value), old = ticket.priority;
      ticket.priority = next;
      updateMeta();
      try {
        const updated = await T.API.patchTicket(ticket.id, { priority: next });
        Object.assign(ticket, updated || {});
        updateMeta();
        T.toast('优先级已改为「' + T.PRIORITY_LABEL[next] + '」', 'ok');
        T.emit('board:reload');
      } catch (err) {
        ticket.priority = old;
        updateMeta();
        T.toast('改优先级失败，已回滚：' + err.message, 'error');
      }
    });

    // #58：复制这张工单的 Agents 纯文本 URL
    const copyAiBtn = document.getElementById('d-copy-ai');
    if (copyAiBtn) {
      copyAiBtn.addEventListener('click', async function () {
        const url = T.ticketTextUrl(S.ws, ticket.seq);
        const ok = await T.copyText(url);
        T.toast(ok ? '已复制工单 AI URL：' + url : '复制失败，请手动复制：' + url, ok ? 'ok' : 'error');
      });
    }

    document.getElementById('d-edit').addEventListener('click', function () {
      window.Editor.openEdit(ticket, S.ws, function () {
        T.emit('detail:reload');
        T.emit('board:reload');
      });
    });

    document.getElementById('d-del').addEventListener('click', async function () {
      const ok = await T.confirmDialog('删除工单',
        '确定删除「' + ticket.ref + ' ' + T.cardPreview(ticket) + '」？评论会一并删除，无法恢复。', '删除');
      if (!ok) return;
      try {
        await T.API.deleteTicket(ticket.id);
        T.toast('已删除', 'ok');
        T.emit('detail:close');
        T.emit('board:reload');
      } catch (err) {
        T.toast('删除失败：' + err.message, 'error');
      }
    });

    // #59：点图片直接在新标签页打开图片地址（不再用蒙版放大）
    // 注意：不 preventDefault，保留右键「另存为」等原生行为
    body.addEventListener('click', function (e) {
      const img = e.target.closest && e.target.closest('.md-img');
      if (!img) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // 交给浏览器处理
      window.open(img.getAttribute('src'), '_blank', 'noopener');
    });

    // 依赖链接：在右栏打开被依赖的工单（不跳转）
    body.addEventListener('click', function (e) {
      const a = e.target.closest('[data-dep]');
      if (!a) return;
      e.preventDefault();
      const ref = a.getAttribute('data-dep');
      const m = /^(.+)#(\d+)$/.exec(ref);
      if (m && m[1] === S.ws) T.emit('ticket:open-seq', Number(m[2]));
    });

    // 评论编辑 / 删除
    document.getElementById('d-cmt-list').addEventListener('click', async function (e) {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const li = btn.closest('.cmt');
      const id = li.getAttribute('data-id');
      const c = comments.filter(function (x) { return x.id === id; })[0];
      if (!c) return;

      if (btn.getAttribute('data-act') === 'del') {
        const ok = await T.confirmDialog('删除评论', '确定删除这条评论？无法恢复。', '删除');
        if (!ok) return;
        try {
          await T.API.deleteComment(c.id);
          comments = comments.filter(function (x) { return x.id !== c.id; });
          renderComments();
          T.toast('评论已删除', 'ok');
          T.emit('board:reload');
        } catch (err) {
          T.toast('删除失败：' + err.message, 'error');
        }
        return;
      }

      // 就地编辑
      const bodyEl = li.querySelector('.cmt-body');
      const original = c.body;
      li.querySelector('.acts').style.display = 'none';
      bodyEl.outerHTML =
        '<div>' +
          '<textarea class="textarea" data-edit="1" style="min-height:64px">' + T.esc(original) + '</textarea>' +
          '<div style="display:flex;gap:7px;justify-content:flex-end;margin-top:5px">' +
            '<button class="btn sm" data-edit="cancel">取消</button>' +
            '<button class="btn primary sm" data-edit="save">保存</button>' +
          '</div>' +
        '</div>';
      const ta = li.querySelector('[data-edit="1"]');
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);

      li.addEventListener('click', async function onEditClick(ev) {
        const action = ev.target.getAttribute && ev.target.getAttribute('data-edit');
        if (!action) return;
        ev.stopPropagation();
        if (action === 'cancel') {
          li.removeEventListener('click', onEditClick);
          renderComments();
          return;
        }
        if (action === 'save') {
          const next = ta.value.trim();
          if (!next) return T.toast('评论不能为空', 'error');
          try {
            const updated = await T.API.patchComment(c.id, next);
            Object.assign(c, updated || { body: next });
            li.removeEventListener('click', onEditClick);
            renderComments();
            T.toast('评论已保存', 'ok');
            T.emit('board:reload');
          } catch (err) {
            T.toast('保存失败：' + err.message, 'error');
          }
        }
      });
    });

    // 图片：粘贴 / 拖入 / 点选（用户 ai-剧本#12）
    const cmtHint = document.getElementById('d-cmt-hint');
    const cmtInput = document.getElementById('d-cmt-input');
    let imgHelper = null;
    if (cmtInput) imgHelper = window.Images.attach(cmtInput, { hintEl: cmtHint });
    const imgBtn = document.getElementById('d-cmt-img');
    const imgFile = document.getElementById('d-cmt-file');
    if (imgBtn && imgFile) {
      imgBtn.addEventListener('click', function () { imgFile.click(); });
      imgFile.addEventListener('change', function () {
        if (imgFile.files && imgFile.files.length && imgHelper) {
          imgHelper.handleFiles(imgFile.files); // 复用同一套上传逻辑
        }
        imgFile.value = ''; // 允许连续选同一张
      });
    }

    // 发表评论
    const sendBtn = document.getElementById('d-cmt-send');
    const input = document.getElementById('d-cmt-input');
    async function send() {
      const text = input.value.trim();
      if (!text) return T.toast('评论不能为空', 'error');
      if (text.length > 10000) return T.toast('评论不能超过 10000 字', 'error');
      sendBtn.disabled = true;
      try {
        const created = await T.API.addComment(ticket.id, text);
        if (created && created.id) comments.push(created);
        input.value = '';
        renderComments();
        T.toast('评论已发表', 'ok');
        T.emit('board:reload');
      } catch (err) {
        T.toast('发表失败：' + err.message, 'error');
      } finally {
        sendBtn.disabled = false;
      }
    }
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); }
    });
  }

  /* ---------------- 加载 ---------------- */
  async function load(wsSlug, targetSeq) {
    seq = Number(targetSeq);
    ticket = null;
    comments = [];
    open = true;
    if (rootEl) rootEl.classList.remove('hidden');
    const body = document.getElementById('d-body');
    const refEl = document.getElementById('d-ref');
    if (refEl) refEl.textContent = wsSlug + '#' + seq;
    if (body) body.innerHTML = '<div class="loading">加载中…</div>';

    try {
      // 后端 GET /api/tickets/:id 的 :id 接受 ref 形式，一次拿到工单 + 全部评论
      const detail = await T.API.getTicket(wsSlug + '#' + seq);
      if (!detail || !detail.id) throw new Error('工单不存在');
      ticket = detail;
      comments = detail.comments || [];
      render();
      // 高亮看板上对应的卡
      T.emit('detail:rendered');
    } catch (err) {
      if (body) {
        body.innerHTML = '<div class="empty"><h3>打不开这张工单</h3><p>' +
          T.esc(err.message) + '</p></div>';
      }
    }
  }

  async function reload() {
    if (open && seq != null && S.ws) await load(S.ws, seq);
  }

  function close() {
    open = false;
    seq = null;
    ticket = null;
    if (rootEl) {
      rootEl.classList.add('hidden');
      const body = document.getElementById('d-body');
      if (body) body.innerHTML = '';
    }
    T.emit('detail:closed');
  }

  function isOpen() { return open; }
  function currentSeq() { return seq; }

  window.Detail = {
    mount: mount, load: load, reload: reload, close: close,
    isOpen: isOpen, currentSeq: currentSeq,
    getTicket: function () { return ticket; }
  };
})();
