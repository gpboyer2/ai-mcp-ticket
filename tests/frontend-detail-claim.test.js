// 详情页认领元素的口径（用户 ai-mcp-ticket#15）：
// 认领只对 AI 生效（MCP 的 ticket_claim / ticket_release）。人类界面不许出现「认领」「释放」这类
// 只对 AI 有意义的操作，也不能把认领 / 释放接口再挂到页面上；只允许在被认领时给一行只读状态，
// 提示用户此刻无法编辑。这里用最小 DOM 桩把这条口径钉死。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const WEB = path.resolve(import.meta.dirname, '..', 'web');

function makeEl(id) {
  const classes = new Set();
  const el = {
    id,
    _html: '',
    children: [],
    style: {},
    dataset: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    focus() {},
    setSelectionRange() {},
    getBoundingClientRect: () => ({ width: 420 }),
    querySelector: () => null,
    querySelectorAll: () => [],
    set innerHTML(html) {
      el._html = String(html);
      el.children = [];
      // 子元素按 id="xxx" 收集，供 getElementById 找到刚渲染出来的节点
      for (const m of el._html.matchAll(/id="([^"]+)"/g)) el.children.push(makeEl(m[1]));
    },
    get innerHTML() { return el._html; },
    set textContent(v) { el._text = String(v); },
    get textContent() { return el._text || ''; },
  };
  return el;
}

/** 加载 web/detail.js，返回 window.Detail 与页面容器 */
function loadDetail() {
  const byId = new Map();
  function getById(id) {
    if (!byId.has(id)) byId.set(id, makeEl(id));
    return byId.get(id);
  }
  const container = makeEl('detail-pane');

  const documentStub = {
    getElementById: getById,
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
  };

  const api = {
    getTicket: async () => null,
    patchTicket: async () => ({}),
    deleteTicket: async () => ({}),
    addComment: async () => ({}),
    patchComment: async () => ({}),
    deleteComment: async () => ({}),
  };

  const sandbox = {
    window: {
      TT: {
        S: { ws: 'demo-project' },
        API: api,
        esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        })[c]),
        fmtTime: (iso) => String(iso || ''),
        depsList: () => [],
        statusBadge: () => '',
        priorityPill: () => '',
        actorText: () => '',
        STATUS: [],
        PRIORITY: [],
        emit() {},
        toast() {},
        confirmDialog: async () => false,
        ticketTextUrl: () => '',
        copyText: async () => true,
        timeTag: () => '',
        cardPreview: () => '',
      },
      Images: { renderMarkdownImages: (s) => String(s), attach: () => ({ handleFiles() {} }) },
      icon: () => '<svg></svg>',
      Editor: { openEdit() {} },
    },
    document: documentStub,
    localStorage: { getItem: () => null, setItem() {} },
    console,
  };
  sandbox.window.document = documentStub;
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(WEB, 'detail.js'), 'utf8');
  vm.runInContext(code, sandbox);
  return { Detail: sandbox.window.Detail, container, api, doc: documentStub };
}

/** 渲染一张工单：走 load()，用假后端把工单喂进去 */
async function renderTicket(Detail, container, ticket, api) {
  api.getTicket = async () => ticket;
  Detail.mount(container);
  await Detail.load('demo-project', ticket.seq);
}

const baseTicket = {
  id: 't1',
  seq: 15,
  ref: 'demo-project#15',
  status: 'open',
  priority: 1,
  content: '认领测试工单',
  blocked_by: null,
  actor_role: 'user',
  actor_id: 'user',
  created_at: '2026-11-05T00:00:00.000Z',
  updated_at: '2026-11-05T00:00:00.000Z',
  comments: [],
};

test('详情页未认领时：没有认领按钮，也不出现「认领」文案', async () => {
  const { Detail, container, api, doc } = loadDetail();
  await renderTicket(Detail, container, { ...baseTicket, assignee_id: null }, api);
  const document1 = doc;
  const body = document1.getElementById('d-body').innerHTML;
  assert.ok(!body.includes('data-claim'), `不该有认领按钮：${body}`);
  assert.ok(!body.includes('>认领<'), `不该出现「认领」文案：${body}`);
  assert.ok(!body.includes('meta-claimed'), '未认领时不该有认领状态 chip');
});

test('详情页被 AI 认领时：只给一行只读状态，没有释放按钮', async () => {
  const { Detail, container, api, doc } = loadDetail();
  await renderTicket(Detail, container, {
    ...baseTicket,
    assignee_id: 'deepseek',
    assignee_role: 'ai',
    assignee_model: 'deepseek-v4.1',
    claimed_at: '2026-11-05T01:00:00.000Z',
  }, api);
  const document1 = doc;
  const body = document1.getElementById('d-body').innerHTML;
  assert.ok(body.includes('meta-claimed'), '被认领时应有状态 chip');
  assert.ok(body.includes('已被 ai:deepseek'), `状态里应写明认领者：${body}`);
  assert.ok(!body.includes('data-claim'), '不该有任何认领 / 释放按钮');
  assert.ok(!body.includes('data-claim'), '认领块里不能有认领 / 释放按钮');
});

test('前端 API 不再暴露认领 / 释放：这两个动作只属于 AI', () => {
  const source = fs.readFileSync(path.join(WEB, 'common.js'), 'utf8');
  assert.ok(!source.includes('/claim'), 'common.js 不该再有认领接口');
  assert.ok(!source.includes('/release'), 'common.js 不该再有释放接口');
  const detail = fs.readFileSync(path.join(WEB, 'detail.js'), 'utf8');
  assert.ok(!detail.includes('claimTicket'), 'detail.js 不该再调认领接口');
  assert.ok(!detail.includes('releaseTicket'), 'detail.js 不该再调释放接口');
});
