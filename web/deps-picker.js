/* ==========================================================================
   deps-picker.js —— 依赖（blocked_by）可搜索多选下拉（契约 6.4 / 工单 ai-剧本#15）
   - 输入即过滤当前工作区工单（ref + 内容预览模糊），最多 20 条
   - 每条显示 `{ref}  {内容预览}  状态`
   - 键盘：上下方向键移动、回车选中、Esc 关闭
   - 多选：已选显示为可删除的 chip，值存逗号分隔 ref
   ========================================================================== */
(function () {
  'use strict';
  const T = window.TT;

  const MAX_ITEMS = 20;

  /**
   * 挂载一个依赖选择器
   * @param {HTMLElement} mountEl 容器（内部会生成 chips + input + 下拉）
   * @param {Object} opts { workspace: slug, value: 'a#1,b#2', exclude: [ref...], onChange: fn }
   * @returns {Object} { getValue(), setValue(str), destroy() }
   */
  function mount(mountEl, opts) {
    const o = opts || {};
    const workspace = o.workspace;
    let selected = T.depsList(o.value || '');
    const exclude = T.depsList((o.exclude || []).join(','));

    mountEl.classList.add('deps-field');
    mountEl.innerHTML =
      '<div class="deps-chips"></div>' +
      '<input class="input deps-input" type="text" autocomplete="off" ' +
        'placeholder="搜索工单号或内容，回车选中；可多选">' +
      '<div class="deps-list" hidden></div>';

    const chipsEl = mountEl.querySelector('.deps-chips');
    const input = mountEl.querySelector('.deps-input');
    const listEl = mountEl.querySelector('.deps-list');

    let candidates = [];   // 当前工作区工单
    let filtered = [];     // 过滤后的候选
    let cursor = 0;        // 键盘高亮下标
    let loading = false;
    let loadedFor = null;
    let loadError = null;   // M3：请求失败要明确报出来，不能伪装成「没有候选」

    /* ---------- chips ---------- */
    function renderChips() {
      chipsEl.innerHTML = selected.map(function (ref) {
        return '<span class="chip" data-ref="' + T.esc(ref) + '">' + T.esc(ref) +
          '<button type="button" data-act="rm" title="移除" aria-label="移除">' +
            window.icon('x', 11) + '</button></span>';
      }).join('');
      chipsEl.style.display = selected.length ? 'flex' : 'none';
    }

    function notify() {
      if (o.onChange) o.onChange(selected.join(','));
    }

    /* ---------- 候选数据 ---------- */
    async function ensureCandidates() {
      if (loadedFor === workspace && candidates.length) return;
      loading = true;
      loadError = null;
      try {
        const data = await T.API.tickets(workspace, { limit: 1000, withComments: false });
        candidates = ((data && data.tickets) || []).filter(function (t) {
          return exclude.indexOf(t.ref) === -1;
        });
        loadedFor = workspace;
      } catch (e) {
        // 不再静默吞掉：记下错误，下拉里显示「加载失败 + 重试」
        candidates = [];
        loadError = (e && e.message) || '网络错误';
      } finally {
        loading = false;
      }
    }

    /* ---------- 过滤 + 渲染下拉 ---------- */
    function filterItems(kw) {
      const k = String(kw || '').trim().toLowerCase();
      let arr = candidates.filter(function (t) {
        return selected.indexOf(t.ref) === -1;
      });
      if (k) {
        arr = arr.filter(function (t) {
          return String(t.ref).toLowerCase().indexOf(k) !== -1 ||
                 T.cardPreview(t).toLowerCase().indexOf(k) !== -1;
        });
      }
      filtered = arr.slice(0, MAX_ITEMS);
      if (cursor >= filtered.length) cursor = Math.max(0, filtered.length - 1);
    }

    // #47：做成标准 popover —— 圆角/阴影/边框/hover/键盘高亮/分组/滚动区/空态/错误态
    function renderList() {
      listEl.hidden = false;

      // 加载中
      if (loading) {
        listEl.innerHTML = '<div class="pop-empty">' +
          '<span class="pop-spinner"></span><span>加载工单列表…</span></div>';
        return;
      }

      // 加载失败（M3）：明确告知 + 可重试，绝不显示成「没有匹配」
      if (loadError) {
        listEl.innerHTML = '<div class="pop-empty pop-error">' +
          window.icon('triangle-alert', 15) +
          '<span>加载失败：' + T.esc(loadError) + '</span>' +
          '<button type="button" class="pop-retry" data-act="retry">点此重试</button>' +
          '</div>';
        return;
      }

      // 没有匹配
      if (!filtered.length) {
        const kw = input.value.trim();
        listEl.innerHTML = '<div class="pop-empty">' +
          window.icon('search', 15) +
          '<span>' + (kw ? '没有匹配「' + T.esc(kw) + '」的工单' : '这个工作区还没有工单') + '</span>' +
          '</div>';
        return;
      }

      // 有结果：分两组（当前工作区 / 无），保持 popover 的视觉层次
      const html = [];
      html.push('<div class="pop-group-label">可选工单 · ' + filtered.length + ' 条' +
        (candidates.length > filtered.length ? '（共 ' + candidates.length + ' 条）' : '') + '</div>');
      filtered.forEach(function (t, i) {
        const st = T.STATUS_LABEL[t.status] || t.status;
        html.push('<div class="deps-item pop-item' + (i === cursor ? ' cursor' : '') + '" ' +
          'role="option" aria-selected="' + (i === cursor) + '" data-idx="' + i + '">' +
          '<span class="pop-item-main">' +
            '<span class="r">' + T.esc(t.ref) + '</span>' +
            '<span class="t">' + T.esc(T.cardPreview(t) || '(无内容)') + '</span>' +
          '</span>' +
          '<span class="s" style="color:' + (T.STATUS_COLOR[t.status] || 'var(--muted)') + '">' +
            window.icon(T.STATUS_ICON[t.status] || 'circle', 12) +
            '<span>' + T.esc(st) + '</span></span>' +
          '</div>');
      });
      listEl.innerHTML = html.join('');
    }

    // 弹窗里 overflow:auto 会把 absolute 的下拉裁掉，所以检测到在弹窗里时改用 fixed 定位
    function positionPopover() {
      const inModal = !!mountEl.closest('.modal, .overlay');
      if (inModal) {
        const r = input.getBoundingClientRect();
        listEl.classList.add('pop-fixed');
        listEl.style.left = r.left + 'px';
        listEl.style.width = r.width + 'px';
        // 默认贴在输入框下面；底下放不下就往上弹
        const listH = listEl.offsetHeight || 200;
        const spaceBelow = window.innerHeight - r.bottom;
        if (spaceBelow < Math.min(listH + 12, 280) && r.top > 300) {
          listEl.style.top = (r.top - Math.min(listH, 268) - 8) + 'px';
        } else {
          listEl.style.top = (r.bottom + 4) + 'px';
        }
      } else {
        listEl.classList.remove('pop-fixed');
        listEl.style.left = '';
        listEl.style.top = '';
        listEl.style.width = '';
      }
    }

    function open() {
      filterItems(input.value);
      renderList();
      positionPopover();
    }
    function close() {
      listEl.hidden = true;
      listEl.innerHTML = '';
    }

    function pick(idx) {
      const t = filtered[idx];
      if (!t) return;
      if (selected.indexOf(t.ref) === -1) selected.push(t.ref);
      input.value = '';
      renderChips();
      notify();
      // 选完继续可以再选
      filterItems('');
      renderList();
      input.focus();
    }

    /* ---------- 事件 ---------- */
    async function openWithCandidates() {
      await ensureCandidates();
      open(); // 必须走 open()，里面才带 positionPopover()
    }

    input.addEventListener('focus', openWithCandidates);
    // 已聚焦时再点一下也要能重新打开（部分环境不重复派发 focus 事件）
    input.addEventListener('click', openWithCandidates);

    input.addEventListener('input', async function () {
      await ensureCandidates();
      cursor = 0;
      open();
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (listEl.hidden) { open(); return; }
        if (!filtered.length) return;
        cursor = (cursor + 1) % filtered.length;
        renderList();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (listEl.hidden) return;
        if (!filtered.length) return;
        cursor = (cursor - 1 + filtered.length) % filtered.length;
        renderList();
      } else if (e.key === 'Enter') {
        if (!listEl.hidden && filtered.length) {
          e.preventDefault();
          e.stopPropagation(); // 别让外层表单把回车当提交
          pick(cursor);
        }
      } else if (e.key === 'Escape') {
        if (!listEl.hidden) {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      } else if (e.key === 'Backspace' && !input.value && selected.length) {
        // 空输入退格删最后一个 chip
        selected.pop();
        renderChips();
        notify();
      }
    });

    // 鼠标点选
    listEl.addEventListener('mousedown', function (e) {
      // 重试按钮（M3）
      if (e.target.closest('[data-act="retry"]')) {
        e.preventDefault();
        loadedFor = null;
        ensureCandidates().then(function () {
          filterItems(input.value);
          renderList();
        });
        return;
      }
      const item = e.target.closest('.deps-item');
      if (!item) return;
      e.preventDefault(); // 保住 input 焦点
      pick(Number(item.getAttribute('data-idx')));
    });

    // 移除 chip
    chipsEl.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-act="rm"]');
      if (!btn) return;
      const ref = btn.parentElement.getAttribute('data-ref');
      selected = selected.filter(function (r) { return r !== ref; });
      renderChips();
      notify();
    });

    // 点外面关掉
    function onDocClick(e) {
      if (!mountEl.contains(e.target)) close();
    }
    document.addEventListener('mousedown', onDocClick);

    renderChips();

    return {
      getValue: function () { return selected.join(','); },
      setValue: function (v) {
        selected = T.depsList(v || '');
        renderChips();
      },
      destroy: function () { document.removeEventListener('mousedown', onDocClick); }
    };
  }

  window.DepsPicker = { mount: mount };
})();
