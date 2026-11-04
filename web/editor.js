/* ==========================================================================
   editor.js —— 新建 / 编辑工单弹窗（契约 6.3 / 工单 ai-剧本#14）
   工单只有 content 一个内容字段：整个 textarea 就是 content 原文，不再拆标题与正文。
   依赖字段用 deps-picker.js 的可搜索多选下拉（契约 6.4）
   ========================================================================== */
(function () {
  'use strict';
  const T = window.TT;

  function formHtml(t, ws) {
    const v = t || {};
    const status = v.status || 'open';
    const priority = v.priority == null ? 1 : Number(v.priority);
    const content = t ? String(v.content || '') : '';
    return '<div class="field">' +
        '<label>工单内容</label>' +
        '<textarea class="textarea merged" name="content" ' +
          'placeholder="写工单内容，可以随便写，也可以直接粘贴图片。第一行会作为卡片预览。">' +
          T.esc(content) + '</textarea>' +
        '<div class="img-hint" id="editor-hint" hidden></div>' +
        '<div class="editor-actions">' +
          '<button class="btn sm" id="editor-img" type="button" title="插入图片（也可直接粘贴或拖入）">' +
            window.icon('image-plus', 14) + '<span>插入图片</span></button>' +
          '<input type="file" id="editor-file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>' +
        '</div>' +
        '<div class="hint">内容支持 Markdown。图片会以 Markdown 语法插入。</div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>优先级</label><select class="select" name="priority">' +
          T.PRIORITY.map(function (p) {
            return '<option value="' + p.value + '"' + (priority === p.value ? ' selected' : '') + '>' +
              T.esc(p.label) + '</option>';
          }).join('') +
        '</select></div>' +
        '<div class="field"><label>状态</label><select class="select" name="status">' +
          T.STATUS.map(function (s) {
            return '<option value="' + s.key + '"' + (status === s.key ? ' selected' : '') + '>' +
              T.esc(s.label) + '</option>';
          }).join('') +
        '</select></div>' +
      '</div>' +
      '<div class="field">' +
        '<label>依赖的工单（可搜索、可多选）</label>' +
        '<div id="deps-mount"></div>' +
      '</div>' +
      // #58：编辑已有工单时，直接给这张工单的 AI 纯文本 URL
      (t && t.seq ? '<div class="field">' +
        '<label>这张工单的 AI 纯文本地址</label>' +
        '<div class="ai-url-row">' +
          '<code class="ai-url-inline" id="editor-ai-url">' + T.esc(T.ticketTextUrl(ws, t.seq)) + '</code>' +
          '<button class="btn sm" id="editor-copy-ai" type="button">' +
            window.icon('copy', 13) + '<span>复制</span></button>' +
        '</div>' +
      '</div>' : '');
  }

  // 给弹窗里的合并输入框挂上图片能力（粘贴/拖入/点选）
  function mountImageUpload(modal) {
    const ta = modal.querySelector('[name="content"]');
    const hint = modal.querySelector('#editor-hint');
    const btn = modal.querySelector('#editor-img');
    const file = modal.querySelector('#editor-file');
    if (!ta) return;
    const helper = window.Images.attach(ta, { hintEl: hint });
    if (btn && file) {
      btn.addEventListener('click', function () { file.click(); });
      file.addEventListener('change', function () {
        if (file.files && file.files.length) helper.handleFiles(file.files);
        file.value = '';
      });
    }
  }

  // 绑定编辑弹窗里的「复制 AI URL」
  function bindCopyAiUrl(modal) {
    const btn = modal.querySelector('#editor-copy-ai');
    const code = modal.querySelector('#editor-ai-url');
    if (!btn || !code) return;
    btn.addEventListener('click', async function () {
      const url = code.textContent.trim();
      const ok = await T.copyText(url);
      T.toast(ok ? '已复制：' + url : '复制失败，请手动复制', ok ? 'ok' : 'error');
    });
  }

  function readForm(modal, picker) {
    const content = modal.querySelector('[name="content"]').value.trim();
    if (!content) throw new Error('请至少写一行内容');
    return {
      content: content,
      priority: Number(modal.querySelector('[name="priority"]').value),
      status: modal.querySelector('[name="status"]').value,
      blocked_by: picker ? picker.getValue() : ''
    };
  }

  // 新建
  function openCreate(ws, onDone) {
    let picker = null;
    T.openModal({
      title: '新建工单',
      bodyHtml: formHtml(null, ws),
      okText: '创建',
      onMount: function (modal) {
        picker = window.DepsPicker.mount(modal.querySelector('#deps-mount'), { workspace: ws, value: '' });
        mountImageUpload(modal);
      },
      onOk: async function (modal) {
        const payload = readForm(modal, picker);
        const created = await T.API.createTicket(ws, payload);
        // #58：新建时还没有 seq，所以复制按钮放在「创建成功」的反馈里
        if (created && created.seq) {
          T.toastWithAction(
            '已创建 ' + (created.ref || '工单'),
            'ok',
            '复制工单 AI URL',
            function () { return T.ticketTextUrl(ws, created.seq); }
          );
        } else {
          T.toast('已创建 ' + (created && created.ref ? created.ref : '工单'), 'ok');
        }
        if (onDone) onDone(created);
      }
    });
  }

  // 编辑
  function openEdit(t, ws, onDone) {
    let picker = null;
    T.openModal({
      title: '编辑 ' + (t.ref || '工单'),
      bodyHtml: formHtml(t, ws),
      okText: '保存',
      onMount: function (modal) {
        picker = window.DepsPicker.mount(modal.querySelector('#deps-mount'), {
          workspace: ws,
          value: t.blocked_by || '',
          exclude: [t.ref] // 不能依赖自己
        });
        mountImageUpload(modal);
        bindCopyAiUrl(modal);
      },
      onOk: async function (modal) {
        const payload = readForm(modal, picker);
        const updated = await T.API.patchTicket(t.id, payload);
        T.toast('已保存', 'ok');
        if (onDone) onDone(updated);
      }
    });
  }

  window.Editor = { openCreate: openCreate, openEdit: openEdit };
})();
