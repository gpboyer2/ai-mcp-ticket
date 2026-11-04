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

  function headHtml(t) {
    return '<h2 class="detail-title" id="d-title" title="点击可编辑">' + T.esc(t.title) + '</h2>' +
      '<div class="meta-row" id="d-meta-1">' +
        '<span class="kv">' + T.statusBadge(t.status) + '</span>' +
        '<span class="kv">' + T.priorityPill(t.priority) + '</span>' +
        '<span class="kv">依赖 ' + depsInline(t.blocked_by) + '</span>' +
      '</div>' +
      '<div class="meta-row" id="d-meta-2">' +
        '<span class="kv">' + T.esc(T.actorText(t.actor_role, t.actor_id, t.model)) + '</span>' +
        '<span class="kv">建于 ' + T.timeTag(t.created_at) + '</span>' +
        '<span class="kv">更新于 ' + T.timeTag(t.updated_at) + '</span>' +
      '</div>' +
      '<div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:12px">' +
        '<select class="select" id="d-status" style="width:auto">' +
          T.STATUS.map(function (s) {
            return '<option value="' + s.key + '"' + (t.status === s.key ? ' selected' : '') + '>' +
              T.esc(s.label) + '</option>';
          }).join('') +
        '</select>' +
        '<select class="select" id="d-priority" style="width:auto">' +
          T.PRIORITY.map(function (p) {
            return '<option value="' + p.value + '"' + (Number(t.priority) === p.value ? ' selected' : '') + '>' +
              T.esc(p.label) + '</option>';
          }).join('') +
        '</select>' +
        '<button class="btn sm" id="d-edit">编辑</button>' +
        '<button class="btn sm danger" id="d-del">删除</button>' +
      '</div>' +
      '<div class="panel"><h2>正文</h2>' +
        '<div class="body-text' + (t.body ? '' : ' empty') + '" id="d-text">' +
          (t.body ? window.Images.renderMarkdownImages(t.body) : '（空）') + '</div>' +
      '</div>' +
      '<div class="panel"><h2>评论（<span id="d-cmt-n">0</span>）</h2>' +
        '<ul class="cmt-list" id="d-cmt-list"></ul>' +
        '<div style="margin-top:10px">' +
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
    const m1 = document.getElementById('d-meta-1');
    const m2 = document.getElementById('d-meta-2');
    if (m1) {
      m1.innerHTML =
        '<span class="kv">' + T.statusBadge(t.status) + '</span>' +
        '<span class="kv">' + T.priorityPill(t.priority) + '</span>' +
        '<span class="kv">依赖 ' + depsInline(t.blocked_by) + '</span>';
    }
    if (m2) {
      m2.innerHTML =
        '<span class="kv">' + T.esc(T.actorText(t.actor_role, t.actor_id, t.model)) + '</span>' +
        '<span class="kv">建于 ' + T.timeTag(t.created_at) + '</span>' +
        '<span class="kv">更新于 ' + T.timeTag(t.updated_at) + '</span>';
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

    document.getElementById('d-title').addEventListener('click', function () {
      T.openModal({
        title: '修改标题',
        bodyHtml: '<div class="field"><label>标题</label><input class="input" name="title" maxlength="200" value="' +
          T.esc(ticket.title) + '"></div>',
        okText: '保存',
        onOk: async function (modal) {
          const v = modal.querySelector('[name="title"]').value.trim();
          if (!v) throw new Error('标题不能为空');
          const updated = await T.API.patchTicket(ticket.id, { title: v });
          Object.assign(ticket, updated || {});
          document.getElementById('d-title').textContent = ticket.title;
          T.toast('标题已更新', 'ok');
          T.emit('board:reload');
        }
      });
    });

    document.getElementById('d-edit').addEventListener('click', function () {
      window.Editor.openEdit(ticket, S.ws, function () {
        T.emit('detail:reload');
        T.emit('board:reload');
      });
    });

    document.getElementById('d-del').addEventListener('click', async function () {
      const ok = await T.confirmDialog('删除工单',
        '确定删除「' + ticket.ref + ' ' + ticket.title + '」？评论会一并删除，无法恢复。', '删除');
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

    // 点图片放大预览
    body.addEventListener('click', function (e) {
      const img = e.target.closest && e.target.closest('.md-img');
      if (!img) return;
      e.preventDefault();
      openLightbox(img.getAttribute('src'), img.getAttribute('alt'));
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

  // 图片放大预览（点空白或 Esc 关闭；这是看图不是弹窗，Esc 关掉合理）
  function openLightbox(src, alt) {
    const box = document.createElement('div');
    box.className = 'img-lightbox';
    box.innerHTML = '<img src="' + T.esc(src) + '" alt="' + T.esc(alt || '') + '">';
    function close() {
      box.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    box.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(box);
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
