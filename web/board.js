/* ==========================================================================
   board.js —— 中栏：五列看板（契约 6.1 / 6.2）
   - 拖拽换列 + 列内排序（规则与 v1 相同，用户没提意见）
   - 搜索、状态筛选、新建工单、快速新建条（回车即建）
   - 点卡片：不跳转，通知 app.js 在右栏打开详情
   ========================================================================== */
(function () {
  'use strict';
  const T = window.TT;
  const S = T.S;

  let rootEl = null;
  let dragging = null;

  /* ---------------- 排序与分组 ---------------- */
  function byPosition(a, b) {
    const pa = Number(a.position), pb = Number(b.position);
    if (pa !== pb) return pa - pb;
    return String(a.created_at).localeCompare(String(b.created_at));
  }
  function grouped() {
    const g = {};
    T.STATUS.forEach(function (s) { g[s.key] = []; });
    (S.tickets || []).slice().sort(byPosition).forEach(function (t) {
      if (!g[t.status]) g[t.status] = [];
      g[t.status].push(t);
    });
    return g;
  }

  /* ---------------- 渲染 ---------------- */
  function cardHtml(t) {
    const deps = T.depsList(t.blocked_by).length;
    const last = T.lastComment(t);
    const commentLine = last
      ? '<div class="card-comment">' + window.icon('message-square', 12) + '<span>' +
          T.esc(T.truncate((last.actor_role === 'ai' ? 'AI：' : '我：') + last.body, 80)) + '</span></div>'
      : '';
    const active = Number(t.seq) === Number(S.detailSeq) ? ' active' : '';
    // #61：刚新建的那张卡，先带一个高亮类，1.6 秒后淡出
    const justNew = (S.newlyCreatedSeq != null && Number(t.seq) === Number(S.newlyCreatedSeq))
      ? ' just-created' : '';
    return '<div class="card st-' + T.esc(t.status) + active + justNew + '" draggable="true" ' +
        'data-id="' + T.esc(t.id) + '" data-seq="' + T.esc(t.seq) + '" data-status="' + T.esc(t.status) + '">' +
      '<div class="card-top">' +
        '<span class="ref">' + T.esc(t.ref || '') + '</span>' +
        T.priorityPill(t.priority) +
        '<button class="icon-btn more" data-act="menu" title="更多操作" aria-label="更多操作">' +
          window.icon('ellipsis', 15) + '</button>' +
      '</div>' +
      '<div class="card-title">' + T.esc(T.cardPreview(t) || '(无内容)') + '</div>' +
      '<div class="card-meta">' +
        (deps ? '<span class="deps">' + window.icon('link', 11) + '<span>' + deps + '</span></span>' : '') +
        '<span>' + T.timeTag(t.updated_at) + '</span>' +
      '</div>' +
      commentLine +
      '</div>';
  }

  function columnHtml(s) {
    return '<section class="column" data-status="' + s.key + '">' +
      '<div class="column-head">' + T.statusDot(s.key) + T.esc(s.label) +
        '<span class="n" data-count="' + s.key + '">0</span></div>' +
      '<div class="column-body" data-status="' + s.key + '"></div>' +
      '</section>';
  }

  function renderColumns() {
    if (!rootEl) return;
    const g = grouped();
    T.STATUS.forEach(function (s) {
      const body = rootEl.querySelector('.column-body[data-status="' + s.key + '"]');
      const counter = rootEl.querySelector('[data-count="' + s.key + '"]');
      if (!body) return;
      const items = g[s.key] || [];
      body.innerHTML = items.length
        ? items.map(cardHtml).join('')
        : '<div class="col-empty">暂无</div>';
      if (counter) counter.textContent = String(items.length);
    });
    const tip = document.getElementById('board-tip');
    if (tip) {
      const n = T.normalizeCounts(S.counts);
      const extra = S.q ? '，搜索「' + S.q + '」' : '';
      tip.textContent = '显示 ' + (S.tickets || []).length + ' / 共 ' + n.total + ' 张' + extra;
    }
  }

  // 详情开/关只换卡片高亮，绝不重建卡片 DOM。
  // 为什么：点详情面板外面会先关详情，如果关的时候整块重绘，用户正按着的那张卡片
  // 节点会被销毁，浏览器就不再派发这次 click —— 表现成「要连点两下才能切工单」。
  function markActive(seq) {
    if (!rootEl) return;
    const want = seq == null ? null : Number(seq);
    rootEl.querySelectorAll('.card').forEach(function (el) {
      el.classList.toggle('active', want != null && Number(el.getAttribute('data-seq')) === want);
    });
  }

  /* ---------------- #61：新建成功后滚动并激活 ---------------- */
  // 如果当前筛选会把新工单藏起来，先清掉（否则滚过去是空白）
  function clearFiltersIfHides(created) {
    var cleared = [];
    if (S.q) { S.q = ''; cleared.push('搜索'); }
    if (S.statusFilter && created.status && S.statusFilter.indexOf(created.status) === -1) {
      S.statusFilter = ''; cleared.push('状态筛选');
    }
    if (cleared.length) {
      var se = document.getElementById('search');
      if (se) se.value = '';
      T.toast('已清除' + cleared.join('和') + '，方便你看到新工单');
      return true; // 需要重新拉一次数据
    }
    return false;
  }

  /**
   * 把刚建好的工单「亮出来」：滚到它、短暂高亮、并在右栏打开详情。
   * 内部会处理「筛选把新工单藏了」的情况（清筛选后重新拉一次）。
   * @param {Object} created 后端返回的工单对象（至少有 id / seq / status）
   */
  function revealCreated(created) {
    if (!created || created.id == null) return;
    doScrollAndHighlight(created);
  }

  function doScrollAndHighlight(created) {
    // ② 打上「刚创建」标记，让下一次 render 时这张卡带高亮
    S.newlyCreatedSeq = created.seq;

    // ③ 等看板重绘完再滚动（数据异步，最多重试 10 次约 1 秒）
    function attempt(n) {
      n = n || 0;
      var card = document.querySelector('.card[data-id="' + created.id + '"]');
      if (!card) {
        if (n < 10) return setTimeout(function () { attempt(n + 1); }, 100);
        return;
      }
      // 滚动到可见位置（nearest 不会把页面乱跳，只保证它在视野内）
      try {
        card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      } catch (e) {
        card.scrollIntoView(); // 老浏览器降级
      }
      // 高亮脉冲：加类 -> 动画跑完摘掉（时长与 CSS .just-created 一致）
      card.classList.add('just-created');
      setTimeout(function () {
        if (card) card.classList.remove('just-created');
        if (S.newlyCreatedSeq === created.seq) S.newlyCreatedSeq = null;
      }, 1600);
    }
    setTimeout(function () { attempt(0); }, 60);
  }

  /* ---------------- 骨架 ---------------- */
  function mount(container) {
    rootEl = container;
    rootEl.innerHTML =
      '<div class="pane-head">' +
        '<button class="icon-btn mobile-only" id="hamburger" title="工作区目录" aria-label="工作区目录">' +
          window.icon('menu', 18) + '</button>' +
        '<h1 class="pane-title" id="pane-title">工单看板</h1>' +
        '<span class="pane-path" id="pane-path"></span>' +
        '<div class="pane-tools">' +
          '<input class="input search" id="search" type="search" placeholder="搜索内容…">' +
          // #49：原来的「全部状态」下拉已按用户要求删除（五列本身已按状态分好，再筛一次多余）
          '<button class="btn primary new-btn-wide" id="new-btn" type="button">' +
            window.icon('plus', 15) + '<span>新建工单</span></button>' +
          '<button class="btn" id="refresh-btn" type="button" title="刷新列表" aria-label="刷新列表">' +
            window.icon('refresh-cw', 15) + '<span>刷新</span></button>' +
        '</div>' +
      '</div>' +
      '<div class="quick-add">' +
        '<input class="input" id="quick-add" type="text" placeholder="快速新建：写一行内容，回车即建">' +
        '<span class="hint">回车创建</span>' +
      '</div>' +
      '<div class="board-wrap"><div class="board" id="board">' +
        T.STATUS.map(columnHtml).join('') +
      '</div></div>' +
      '<div id="board-tip" style="padding:0 12px 6px;font-size:11px;color:var(--muted)"></div>';

    document.getElementById('search').addEventListener('input', T.debounce(function (e) {
      S.q = e.target.value.trim();
      T.emit('board:filter');
    }, 280));
    document.getElementById('new-btn').addEventListener('click', function () {
      if (!S.ws) return T.toast('请先选一个工作区', 'error');
      window.Editor.openCreate(S.ws, function (created) {
        // #61：弹窗新建成功后同样滚动+高亮+右栏打开
        clearFiltersIfHides(created);
        T.emit('board:reload', function () {
          revealCreated(created);
          T.emit('ticket:open', created);
        });
      });
    });
    document.getElementById('refresh-btn').addEventListener('click', function () {
      const b = document.getElementById('refresh-btn');
      if (b && b.disabled) return;
      if (b) {
        b.disabled = true;
        b.innerHTML = window.icon('refresh-cw', 15, 'spin') + '<span>刷新中</span>';
      }
      T.emit('board:reload', function () {
        if (b) {
          b.disabled = false;
          b.innerHTML = window.icon('refresh-cw', 15) + '<span>刷新</span>';
        }
      });
      // 兜底：1.2s 后无论如何恢复，避免后端慢时按钮一直转
      setTimeout(function () {
        if (b && b.disabled) {
          b.disabled = false;
          b.innerHTML = window.icon('refresh-cw', 15) + '<span>刷新</span>';
        }
      }, 1200);
    });
    document.getElementById('hamburger').addEventListener('click', function () {
      T.emit('sidebar:toggle-mobile');
    });

    // 快速新建：回车即建
    const quick = document.getElementById('quick-add');
    quick.addEventListener('keydown', async function (e) {
      if (e.key !== 'Enter') return;
      const content = quick.value.trim();
      if (!content) return;
      if (!S.ws) return T.toast('请先选一个工作区', 'error');
      quick.disabled = true;
      try {
        const created = await T.API.createTicket(S.ws, { content: content });
        quick.value = '';
        T.toast('已创建 ' + (created && created.ref ? created.ref : ''), 'ok');
        // #61：先清掉会挡住它的筛选，再刷新看板，然后滚动+高亮+右栏打开
        clearFiltersIfHides(created);
        T.emit('board:reload', function () {
          revealCreated(created);
          T.emit('ticket:open', created);
        });
      } catch (err) {
        T.toast('创建失败：' + err.message, 'error');
      } finally {
        quick.disabled = false;
        quick.focus();
      }
    });

    bindDrag();
  }

  function renderHeader() {
    const titleEl = document.getElementById('pane-title');
    const pathEl = document.getElementById('pane-path');
    const ws = S.workspace;
    if (titleEl) titleEl.textContent = ws ? (ws.title || ws.slug) : '工单看板';
    if (pathEl) pathEl.textContent = ws ? (ws.path || '') : '';
    document.title = ws ? ((ws.title || ws.slug) + ' · Agents 工单') : 'Agents 工单';
  }

  function render() {
    renderHeader();
    renderColumns();
    const se = document.getElementById('search');
    if (se && se.value !== (S.q || '')) se.value = S.q || '';
  }

  /* ---------------- 拖拽（换列 + 列内排序） ---------------- */
  function computePosition(siblings, index) {
    const prev = index > 0 ? siblings[index - 1] : null;
    const next = index < siblings.length ? siblings[index] : null;
    if (prev && next) return (Number(prev.position) + Number(next.position)) / 2;
    if (!prev && next) return Number(next.position) - T.STEP;
    if (prev && !next) return Number(prev.position) + T.STEP;
    return T.STEP;
  }

  function findTicket(id) {
    const list = S.tickets || [];
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function bindDrag() {
    const board = document.getElementById('board');
    if (!board) return;

    board.addEventListener('dragstart', function (e) {
      const card = e.target.closest('.card');
      if (!card) return;
      dragging = { id: card.getAttribute('data-id'), fromStatus: card.getAttribute('data-status'), el: card };
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragging.id); } catch (err) { /* Safari */ }
    });

    board.addEventListener('dragend', function () {
      if (dragging && dragging.el) dragging.el.classList.remove('dragging');
      board.querySelectorAll('.column-body.drag-over').forEach(function (el) {
        el.classList.remove('drag-over');
      });
      dragging = null;
    });

    board.addEventListener('dragover', function (e) {
      if (!dragging) return;
      const body = e.target.closest('.column-body');
      if (!body) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      board.querySelectorAll('.column-body.drag-over').forEach(function (el) {
        if (el !== body) el.classList.remove('drag-over');
      });
      body.classList.add('drag-over');
    });

    board.addEventListener('drop', async function (e) {
      if (!dragging) return;
      const body = e.target.closest('.column-body');
      if (!body) return;
      e.preventDefault();
      body.classList.remove('drag-over');
      const info = dragging;
      dragging = null;
      await handleDrop(info, body, e.clientY);
    });

    board.addEventListener('click', function (e) {
      const menuBtn = e.target.closest('[data-act="menu"]');
      const card = e.target.closest('.card');
      if (!card) return;
      const t = findTicket(card.getAttribute('data-id'));
      if (!t) return;
      if (menuBtn) {
        e.stopPropagation();
        const r = menuBtn.getBoundingClientRect();
        openCardMenu(t, r.left, r.bottom + 4);
        return;
      }
      // 不跳转：交给 app.js 在右栏打开
      T.emit('ticket:open', t);
    });

    board.addEventListener('contextmenu', function (e) {
      const card = e.target.closest('.card');
      if (!card) return;
      e.preventDefault();
      const t = findTicket(card.getAttribute('data-id'));
      if (t) openCardMenu(t, e.clientX, e.clientY);
    });
  }

  async function handleDrop(info, bodyEl, clientY) {
    const targetStatus = bodyEl.getAttribute('data-status');
    const ticket = findTicket(info.id);
    if (!ticket) return;

    const cards = Array.prototype.slice.call(bodyEl.querySelectorAll('.card'))
      .filter(function (el) { return el.getAttribute('data-id') !== info.id; });

    let index = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) { index = i; break; }
    }

    const siblings = cards.map(function (el) { return findTicket(el.getAttribute('data-id')); })
      .filter(Boolean).sort(byPosition);
    const position = computePosition(siblings, index);

    const sameStatus = ticket.status === targetStatus;
    const snapshot = { status: ticket.status, position: ticket.position };

    // 乐观更新
    ticket.status = targetStatus;
    ticket.position = position;
    renderColumns();

    try {
      const updated = await T.API.patchTicket(ticket.id, { status: targetStatus, position: position });
      if (updated && updated.id) {
        Object.keys(updated).forEach(function (k) {
          if (k !== 'comments' && k !== 'last_comment') ticket[k] = updated[k];
        });
        renderColumns();
      }
      if (!sameStatus) T.toast('已移动到「' + T.STATUS_LABEL[targetStatus] + '」', 'ok');
      T.emit('board:changed');
    } catch (err) {
      ticket.status = snapshot.status;
      ticket.position = snapshot.position;
      renderColumns();
      T.toast('移动失败，已回滚：' + err.message, 'error');
    }
  }

  /* ---------------- 卡片菜单 ---------------- */
  function openCardMenu(t, x, y) {
    T.openMenu(x, y, [
      { label: '在右栏打开', icon: 'message-square', onClick: function () { T.emit('ticket:open', t); } },
      { label: '编辑', icon: 'pencil', onClick: function () { window.Editor.openEdit(t, S.ws, function () { T.emit('board:reload'); }); } },
      { label: '删除', icon: 'trash-2', danger: true, onClick: function () { removeTicket(t); } }
    ]);
  }

  async function removeTicket(t) {
    const ok = await T.confirmDialog('删除工单',
      '确定删除「' + t.ref + ' ' + T.cardPreview(t) + '」？评论会一并删除，无法恢复。', '删除');
    if (!ok) return;
    try {
      await T.API.deleteTicket(t.id);
      if (Number(S.detailSeq) === Number(t.seq)) T.emit('detail:close');
      T.toast('已删除 ' + t.ref, 'ok');
      T.emit('board:reload');
    } catch (err) {
      T.toast('删除失败：' + err.message, 'error');
    }
  }

  // M3：加载失败时把看板换成明确的错误提示 + 重试，而不是看起来「没有工单」
  function showLoadError(message, onRetry) {
    const wrap = document.querySelector('.board-wrap');
    if (!wrap) return;
    wrap.innerHTML =
      '<div class="pane-empty" style="flex-direction:column;gap:10px">' +
        '<div style="display:flex;align-items:center;gap:8px;color:var(--danger)">' +
          window.icon('triangle-alert', 18) +
          '<span>工单加载失败：' + T.esc(message || '未知错误') + '</span>' +
        '</div>' +
        '<button class="btn" id="board-retry" type="button">' +
          window.icon('refresh-cw', 14) + '<span>重试</span></button>' +
      '</div>';
    const btn = document.getElementById('board-retry');
    if (btn) {
      btn.addEventListener('click', function () {
        // 恢复骨架再重试
        mount(document.getElementById('board-pane'));
        Board.render();
        if (onRetry) onRetry();
      });
    }
  }

  function focusSearch() {
    const el = document.getElementById('search');
    if (el) el.focus();
  }

  window.Board = {
    mount: mount, render: render, renderColumns: renderColumns, markActive: markActive,
    focusSearch: focusSearch, showLoadError: showLoadError, revealCreated: revealCreated
  };
})();
