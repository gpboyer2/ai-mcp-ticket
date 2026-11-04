// 前端纯函数单测（契约 1.3 的卡片预览、AI 视角 URL 生成）。
// 为什么能在 node 里测：web/common.js 是个 IIFE，只依赖 window/document/localStorage，
// 用最小 stub 顶掉这几个全局就能加载，然后把挂到 window.TT 上的纯函数拿出来直接断言。
// 这比"看代码觉得没问题"可靠得多 —— 这些函数一错，卡片上显示的内容就会错位或丢字。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const WEB = path.resolve(import.meta.dirname, '..', 'web');

/** 用最小 DOM stub 加载 web/common.js，返回它的 window.TT */
function loadCommon() {
  const code = fs.readFileSync(path.join(WEB, 'common.js'), 'utf8');

  // 极简 stub：common.js 在加载期只用到这些
  const noop = () => {};
  const store = new Map();
  const fakeEl = {
    setAttribute: noop,
    getAttribute: () => null,
    addEventListener: noop,
    appendChild: noop,
    remove: noop,
    style: {},
    classList: { add: noop, remove: noop, contains: () => false },
    querySelector: () => null,
    querySelectorAll: () => [],
    textContent: '',
    innerHTML: '',
  };
  const document = {
    readyState: 'complete',
    documentElement: fakeEl,
    body: { appendChild: noop, insertBefore: noop, firstChild: null },
    getElementById: () => null,
    createElement: () => ({ ...fakeEl }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
    execCommand: noop,
  };
  const window = {
    location: { pathname: '/', search: '', protocol: 'http:', host: '127.0.0.1:47321', hostname: '127.0.0.1', port: '47321' },
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    innerWidth: 1400,
    innerHeight: 900,
    addEventListener: noop,
    removeEventListener: noop,
  };
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const ctx = vm.createContext({
    window,
    document,
    localStorage,
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout,
    clearTimeout,
    console,
    fetch: async () => ({ ok: true, text: async () => '{}' }),
    URLSearchParams,
    encodeURIComponent,
    decodeURIComponent,
    parseInt,
    Number,
    String,
    Array,
    Object,
    JSON,
    Math,
    Date,
    isNaN,
    Error,
  });
  vm.runInContext(code, ctx, { filename: 'common.js' });
  assert.ok(ctx.window.TT, 'common.js 必须把能力挂到 window.TT 上');
  return ctx.window.TT;
}

const TT = loadCommon();

test('cardPreview（契约 1.3）：取 content 第一个非空行当预览，剥掉行首 Markdown 记号', () => {
  // 工单只有 content 一个内容字段，卡片上那行字只是它的预览，不是独立字段。
  // 多行内容：第一行就是预览，后面的正文不上卡片
  assert.equal(TT.cardPreview({ content: '修复回测空指针\n\n复现步骤 1) … 2) …' }), '修复回测空指针');
  // 行首的 Markdown 记号要剥掉（用户会顺手写 # 或 -），否则卡片上会原样露出 #
  assert.equal(TT.cardPreview({ content: '# 加个深色模式\n正文' }), '加个深色模式');
  assert.equal(TT.cardPreview({ content: '- 加个深色模式' }), '加个深色模式');
  assert.equal(TT.cardPreview({ content: '* 加个深色模式' }), '加个深色模式');
  assert.equal(TT.cardPreview({ content: '## 二级标题' }), '二级标题');
  // 全角空格也是缩进，要剥
  assert.equal(TT.cardPreview({ content: '\u3000\u3000缩进开头' }), '缩进开头');
  // 前面有空行：跳过空行找第一个非空行
  assert.equal(TT.cardPreview({ content: '\n\n\n真正的第一行\n第二行' }), '真正的第一行');
  // Windows 换行必须归一，\r 不能漏到卡片上
  const crlf = TT.cardPreview({ content: '标题\r\n正文' });
  assert.equal(crlf, '标题');
  assert.ok(!crlf.includes('\r'));
  // 只有一个换行符也算"没内容"
  for (const empty of [{ content: '' }, { content: '   \n\n  \t ' }, {}, null, undefined]) {
    assert.equal(TT.cardPreview(empty), '', `输入 ${JSON.stringify(empty)} 时预览必须是空串（调用方据此显示"(无内容)"）`);
  }
});

test('cardPreview：超过 80 字截断并加省略号（卡片一行放不下）', () => {
  assert.equal(TT.PREVIEW_MAX, 80, '卡片预览上限是 80 字');
  const long = 'A'.repeat(200);
  const out = TT.cardPreview({ content: long });
  assert.equal([...out].length, 81, '80 字 + 省略号，实际 ' + JSON.stringify(out.slice(-3)));
  assert.ok(out.endsWith('…'), '截断要加省略号，让用户知道后面还有内容');
  // 正好 80 字不截断
  const exact = TT.cardPreview({ content: 'B'.repeat(80) });
  assert.equal(exact, 'B'.repeat(80));
  // 中文按字符计数，不是 UTF-16 码元
  const cn = TT.cardPreview({ content: '中'.repeat(81) });
  assert.equal([...cn.replace('…', '')].length, 80, '中文 81 字应截到 80 字');
});

test('textUrlFor（契约 6.5 AI 视角）：生成带 ?format=text 的可复制 URL', () => {
  // 真实调用签名是 textUrlFor(pathname, search, useLanHint)，pathname 与 search 分开传
  assert.equal(
    TT.textUrlFor('/demo-project/list', ''),
    'http://127.0.0.1:47321/demo-project/list?format=text',
    '看板页应生成带 format=text 的 URL',
  );
  // 已有查询参数要保留，且用 & 连接（不是再拼一个 ?）
  assert.equal(
    TT.textUrlFor('/demo-project/list', '?status=open'),
    'http://127.0.0.1:47321/demo-project/list?status=open&format=text',
    '已有 ? 时必须用 & 追加',
  );
  // 已带 format=text 不重复加（URLSearchParams.set 天然幂等）
  const already = TT.textUrlFor('/demo-project/list', '?format=text');
  assert.equal((already.match(/format=/g) || []).length, 1, 'format 参数不能重复');
  // maxlen 会被删掉：AI 视角要的是完整内容
  assert.ok(
    !TT.textUrlFor('/demo-project/list', '?maxlen=50').includes('maxlen'),
    'AI 视角 URL 应去掉 maxlen（否则 AI 只拿到截断内容）',
  );
  // 单工单页
  assert.equal(
    TT.textUrlFor('/demo-project/t/12', ''),
    'http://127.0.0.1:47321/demo-project/t/12?format=text',
  );
  // 根路径
  assert.equal(TT.textUrlFor('/', ''), 'http://127.0.0.1:47321/?format=text');
  // 中文 slug：生成结果必须能被 fetch 直接用（含中文或已编码都行）
  const cn = TT.textUrlFor('/ai-剧本/list', '');
  assert.ok(cn.includes('ai-剧本') || cn.includes('%E5%89%A7%E6%9C%AC'), `中文 slug 必须保留可复制，实际 ${cn}`);
  assert.ok(cn.includes('format=text'));
  // 局域网提示模式：localhost 时应换成占位符，方便贴给别人
  const lan = TT.textUrlFor('/demo/list', '', true);
  assert.ok(lan.includes('<局域网IP>'), `局域网模式应给出占位符，实际 ${lan}`);
});

test('normalizeCounts：counts 缺字段时补 0，total 能算出来', () => {
  const c = TT.normalizeCounts({ open: 3, done: 2 }, []);
  assert.equal(c.open, 3);
  assert.equal(c.done, 2);
  assert.equal(c.in_progress, 0, '缺的状态要补 0，不能是 undefined（前端会显示 NaN）');
  assert.equal(c.total, 5, 'total 必须等于各状态之和');

  // 后端完全没给 counts 时的兜底行为。
  // 注意：这里如实记录当前实现的**实际行为**（total 兜底不生效），
  // 该缺陷已写入 FINDINGS.md 轻微问题；等后端/前端修好后这里会变成 assert.equal(c2.total, 3)。
  const c2 = TT.normalizeCounts(null, [{ status: 'open' }, { status: 'open' }, { status: 'done' }]);
  assert.equal(c2.open, 0, '没有 counts 时各状态计数只能是 0（不能凭空从 tickets 推状态分布）');
  assert.equal(c2.done, 0);
  assert.equal(
    c2.total,
    0,
    '当前实现：counts 为 null 时 total 兜底不生效（死代码，见 FINDINGS.md）。修好后应改为 3',
  );

  // 空输入不能炸
  const c3 = TT.normalizeCounts(undefined, undefined);
  assert.equal(c3.total, 0, '完全没输入时 total 必须是 0 而不是 NaN');
  assert.equal(c3.open, 0);
  // 任何情况下各状态都必须是数字，不能是 undefined（否则前端显示 NaN）
  for (const k of ['open', 'in_progress', 'reopened', 'done', 'cancelled', 'total']) {
    assert.equal(typeof c3[k], 'number', `${k} 必须是数字`);
  }
});

test('esc：HTML 转义覆盖五种字符（XSS 防线）', () => {
  assert.equal(TT.esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(TT.esc('a & b'), 'a &amp; b');
  assert.equal(TT.esc('"双引号"'), '&quot;双引号&quot;');
  assert.equal(TT.esc("'单引号'"), '&#39;单引号&#39;');
  assert.equal(TT.esc(null), '', 'null 要变成空串，不能渲染出 "null"');
  assert.equal(TT.esc(undefined), '');
  assert.equal(TT.esc(0), '0', '数字 0 不能被当成空');
});

test('window.TT 导出的 API 覆盖前端所有被引用的方法（防止改名后运行时 undefined）', () => {
  // 为什么值得单独断言：common.js 是 IIFE，导出漏一个方法，node --check 查不出来，
  // 但浏览器里会变成 "T.xxx is not a function"，而且是点击后才炸，最难发现的那类 bug。
  const exported = Object.keys(TT);
  const used = new Set();
  for (const f of fs.readdirSync(WEB).filter((x) => x.endsWith('.js') && x !== 'common.js')) {
    const src = fs.readFileSync(path.join(WEB, f), 'utf8');
    for (const m of src.matchAll(/\b(?:T|TT)\.([a-zA-Z_$][\w$]*)/g)) used.add(m[1]);
  }
  const missing = [...used].filter((u) => !exported.includes(u)).sort();
  assert.deepEqual(missing, [], `这些方法被前端引用但没从 window.TT 导出：${missing.join(', ')}`);
  // 导出数量兜底：少于 30 个说明导出块被删了
  assert.ok(exported.length >= 30, `window.TT 应导出至少 30 个成员，实际 ${exported.length}`);
});
