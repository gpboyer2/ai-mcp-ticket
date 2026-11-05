/* ==========================================================================
   images.js —— 网页端图片：粘贴 / 拖入 / 点选上传 + Markdown 图片渲染
   （用户 ai-剧本#12：允许在网页端粘贴图片）

   后端契约（src/routes/uploads.js）：
     POST /api/uploads
       body   : 原始二进制（不是 multipart）
       header : Content-Type: image/png|jpeg|gif|webp
       201    : { url: '/uploads/xxx.png', name, size, mime }
     上限 10MB，超了 413；类型不对 400

   安全：渲染 Markdown 图片时**只认自己站内的 /uploads/ 路径**，
        其它外链图片一律不渲染成 <img>（避免 XSS / 外链追踪）。
   ========================================================================== */
(function () {
  'use strict';
  const T = window.TT;

  const MAX_BYTES = 10 * 1024 * 1024; // 与后端一致
  const ALLOWED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

  /* ---------------- 上传 ---------------- */
  /**
   * 上传一张图片
   * @param {File|Blob} file
   * @returns {Promise<{url:string,name:string,size:number,mime:string}>}
   */
  async function upload(file) {
    const type = (file.type || '').toLowerCase();
    if (ALLOWED.indexOf(type) === -1) {
      throw new Error('不支持的图片格式：' + (type || '未知') + '（只支持 PNG / JPEG / GIF / WebP）');
    }
    if (file.size > MAX_BYTES) {
      throw new Error('图片太大：' + (file.size / 1024 / 1024).toFixed(1) + 'MB，上限 10MB');
    }
    if (!file.size) {
      throw new Error('这张图片是空的，换个文件试试');
    }

    let res;
    try {
      res = await fetch('/api/uploads', {
        method: 'POST',
        headers: {
          'Content-Type': type,
          'X-Actor-Id': 'user',
          'X-Actor-Role': 'user'
        },
        body: file // 直接发二进制，后端用 express.raw 接
      });
    } catch (e) {
      throw new Error('上传失败：网络中断（' + e.message + '）');
    }

    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }

    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
      if (res.status === 413) throw new Error('图片超过 10MB 上限，请压缩后再传');
      throw new Error('上传失败：' + msg);
    }
    if (!data || !data.url) throw new Error('上传失败：服务器没有返回图片地址');
    return data;
  }

  /* ---------------- 在文本框里插入 Markdown 图片 ---------------- */
  // 在光标处插入文本，插完把光标放到插入内容之后
  function insertAtCursor(textarea, text) {
    const start = textarea.selectionStart == null ? textarea.value.length : textarea.selectionStart;
    const end = textarea.selectionEnd == null ? textarea.value.length : textarea.selectionEnd;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    // 前后补换行，避免图片粘在文字中间
    const needBefore = before && !/\n$/.test(before) ? '\n' : '';
    const needAfter = after && !/^\n/.test(after) ? '\n' : '';
    const snippet = needBefore + text + needAfter;
    textarea.value = before + snippet + after;
    const pos = (before + snippet).length;
    textarea.setSelectionRange(pos, pos);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
  }

  /* ---------------- 给一个 textarea 装上图片能力 ---------------- */
  /**
   * @param {HTMLTextAreaElement} textarea
   * @param {Object} [opts] { hintEl: HTMLElement } 用于显示「上传中/失败」提示
   * @returns {Object} { destroy() }
   */
  function attach(textarea, opts) {
    if (!textarea) return { destroy: function () {} };
    const o = opts || {};
    let pending = 0;

    function status(msg, kind) {
      if (o.hintEl) {
        o.hintEl.textContent = msg || '';
        o.hintEl.className = 'img-hint' + (kind ? ' ' + kind : '');
        o.hintEl.hidden = !msg;
      }
      if (kind === 'error') T.toast(msg, 'error');
    }

    async function handleFiles(files) {
      const list = Array.prototype.slice.call(files || []).filter(function (f) {
        return f && f.type && f.type.indexOf('image/') === 0;
      });
      if (!list.length) {
        status('只能粘贴图片文件（PNG / JPEG / GIF / WebP）', 'error');
        return;
      }
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        pending++;
        status('正在上传 ' + (list.length > 1 ? '(' + (i + 1) + '/' + list.length + ') ' : '') +
          (f.name || '粘贴的图片') + '…', 'loading');
        try {
          const data = await upload(f);
          insertAtCursor(textarea, '![](' + data.url + ')');
          status('已插入图片（' + Math.round(data.size / 1024) + 'KB）', 'ok');
          setTimeout(function () { if (pending <= 1) status(''); }, 1600);
        } catch (err) {
          // 失败必须明确报错，不能静默吞
          status(err.message || '上传失败', 'error');
        } finally {
          pending--;
        }
      }
    }

    // 1) 粘贴
    function onPaste(e) {
      const cd = e.clipboardData;
      if (!cd) return;
      const items = cd.items || [];
      const files = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          const f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault(); // 别把图片当成文件路径粘进文本框
        handleFiles(files);
      }
    }

    // 2) 拖入
    function onDragOver(e) {
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        textarea.classList.add('drop-active');
      }
    }
    function onDragLeave() { textarea.classList.remove('drop-active'); }
    function onDrop(e) {
      textarea.classList.remove('drop-active');
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) {
        e.preventDefault();
        handleFiles(files);
      }
    }

    textarea.addEventListener('paste', onPaste);
    textarea.addEventListener('dragover', onDragOver);
    textarea.addEventListener('dragleave', onDragLeave);
    textarea.addEventListener('drop', onDrop);

    return {
      handleFiles: handleFiles,
      destroy: function () {
        textarea.removeEventListener('paste', onPaste);
        textarea.removeEventListener('dragover', onDragOver);
        textarea.removeEventListener('dragleave', onDragLeave);
        textarea.removeEventListener('drop', onDrop);
      }
    };
  }

  /* ---------------- Markdown 图片渲染（安全） ---------------- */
  // 只允许站内 /uploads/ 路径；其它一律当普通文本转义，不生成 <img>
  const SAFE_IMG = /^\/uploads\/[A-Za-z0-9._-]+\.(png|jpe?g|gif|webp)$/i;

  // 纯文本视图给 AI 的图片是绝对 URL（契约 3.5），AI 会把它原样贴回来写进评论。
  // 同源绝对 URL 要能渲染，但 src 统一收敛回站内路径，别把别的主机塞进 <img>。
  function safeImgUrl(url) {
    const u = String(url || '').trim();
    if (SAFE_IMG.test(u)) return u;
    let parsed;
    try { parsed = new URL(u); } catch (e) { return null; }
    if (parsed.origin !== window.location.origin) return null;
    return SAFE_IMG.test(parsed.pathname) ? parsed.pathname : null;
  }

  /**
   * 把纯文本里的 Markdown 图片语法渲染成 <img>，其余内容一律转义。
   * 支持 ![alt](/uploads/xxx.png)，也支持带尖括号的 ![alt](</uploads/xxx.png>)。
   * @returns {string} HTML
   */
  function renderMarkdownImages(text) {
    const src = String(text || '');
    // 找出所有 ![...](...) 片段
    const re = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?\s*\)/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const alt = m[1];
      const url = m[2];
      const safe = safeImgUrl(url);
      // 图片前面的普通文本先转义输出
      out += T.esc(src.slice(last, m.index));
      if (safe) {
        out += '<img class="md-img" src="' + T.esc(safe) + '" alt="' + T.esc(alt) + '" ' +
          'loading="lazy" title="' + T.esc(alt || '图片') + '">';
      } else {
        // 不安全/外链：原样当文本显示（转义），不给它变成 <img> 的机会
        out += T.esc(m[0]);
      }
      last = re.lastIndex;
    }
    out += T.esc(src.slice(last));
    return out;
  }

  // 去掉 Markdown 图片语法，用于卡片上的纯文字摘要
  function stripMarkdownImages(text) {
    return String(text || '').replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?\s*\)/g, function (all, alt) {
      return alt ? '[' + alt + ']' : '[图片]';
    });
  }

  // 统计一段文本里有几张图（给卡片显示「含 N 张图」）
  // 两种写法都算：AI 常把纯文本视图里的绝对 URL 原样贴回来
  function countImages(text) {
    const m = String(text || '').match(
      /!\[[^\]]*\]\(\s*<?(?:(?:https?:\/\/[^)\s>/]+)?\/uploads\/[^)\s>]+)>?\s*\)/g
    );
    return m ? m.length : 0;
  }

  window.Images = {
    upload: upload,
    attach: attach,
    insertAtCursor: insertAtCursor,
    renderMarkdownImages: renderMarkdownImages,
    stripMarkdownImages: stripMarkdownImages,
    countImages: countImages,
    MAX_BYTES: MAX_BYTES,
    ALLOWED: ALLOWED
  };
})();
