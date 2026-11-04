// 回归测试：详情面板开 / 关时，看板卡片只能换高亮类名，绝不能重建卡片 DOM。
//
// 为什么必须钉住这条：详情是浮层，点面板外面会先关掉详情。如果关的时候顺手重绘看板，
// 用户手指正按着的那张卡片节点就被销毁了，浏览器随后不会再派发这次 click ——
// 表现就是「想切工单必须点两下，第一下只关弹窗」。这个 bug 只有在真实浏览器里点才看得见，
// 所以这里用最小 DOM 桩把「关详情」这一路的 DOM 行为固化成断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const WEB = path.resolve(import.meta.dirname, '..', 'web');

/** 一张卡片的桩：只保留 markActive 与卡片渲染会用到的能力 */
function makeCard(cls, attrs) {
  const classes = new Set(cls.split(/\s+/).filter(Boolean));
  return {
    attrs,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c);
        else classes.delete(c);
        return on;
      },
    },
    hasClass: (c) => classes.has(c),
  };
}

/** 容器桩：innerHTML 被写入时解析出卡片，并记录「重建次数」 */
function makeEl(name) {
  const el = {
    name,
    attrs: {},
    cards: [],
    rebuilds: 0,
    getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
    setAttribute(k, v) { el.attrs[k] = v; },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    remove() {},
    focus() {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 100, left: 0, top: 0, right: 100, bottom: 100 }),
    querySelector: () => null,
    querySelectorAll: () => [],
    set innerHTML(html) {
      el._html = html;
      el.rebuilds += 1;
      el.cards = [];
      // 卡片由 cardHtml 生成：<div class="card st-open active" ... data-seq="60" ...>
      // 按 class 分词精确匹配 card，别把 card-top / card-title / card-meta 也算进来
      for (const m of String(html).matchAll(/<div class="([^"]*)"([^>]*)>/g)) {
        if (!m[1].split(/\s+/).includes('card')) continue;
        const attrs = {};
        for (const a of m[2].matchAll(/data-([a-z]+)="([^"]*)"/g)) attrs['data-' + a[1]] = a[2];
        el.cards.push(makeCard(m[1], attrs));
      }
    },
    get innerHTML() { return el._html || ''; },
  };
  return el;
}

/** 加载 web/board.js，返回 Board 与共享状态 S */
function loadBoard() {
  const byId = new Map();
  const bySel = new Map();
  const getEl = (key) => {
    if (!byId.has(key)) byId.set(key, makeEl(key));
    return byId.get(key);
  };

  const STATUS = ['open', 'in_progress', 'reopened', 'done', 'cancelled'].map((k) => ({ key: k, label: k }));

  // 看板根容器：querySelector('.column-body[data-status="x"]') 每个状态给一个独立桩
  const rootEl = makeEl('board-root');
  rootEl.querySelector = (sel) => {
    if (!bySel.has(sel)) bySel.set(sel, makeEl(sel));
    return bySel.get(sel);
  };
  rootEl.querySelectorAll = (sel) => {
    if (sel === '.card') return bySel.get('ALL_CARDS') || [];
    return [];
  };

  const S = { tickets: [], counts: null, q: '', statusFilter: '', detailSeq: null, ws: 'demo' };

  const T = {
    S,
    STATUS,
    STATUS_LABEL: Object.fromEntries(STATUS.map((s) => [s.key, s.label])),
    STEP: 1000,
    esc: (v) => String(v == null ? '' : v),
    truncate: (v) => String(v || ''),
    cardPreview: (t) => String(t.content || ''),
    timeTag: () => '',
    priorityPill: () => '',
    statusDot: () => '',
    depsList: () => [],
    lastComment: () => null,
    normalizeCounts: (c) => Object.assign({ total: 0, open: 0, in_progress: 0, reopened: 0, done: 0, cancelled: 0 }, c || {}),
    emit: () => {},
    toast: () => {},
    debounce: (fn) => fn,
    on: () => {},
    API: {},
  };

  const document = {
    getElementById: (id) => (id === 'board' ? rootEl : getEl(id)),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };

  const window = { TT: T, icon: () => '', innerWidth: 1440 };
  const ctx = vm.createContext({
    window, document, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    setTimeout, clearTimeout, console, Number, String, Array, Object, JSON, Math, Date, isNaN, Error,
  });
  vm.runInContext(fs.readFileSync(path.join(WEB, 'board.js'), 'utf8'), ctx, { filename: 'board.js' });
  assert.ok(ctx.window.Board, 'board.js 必须把能力挂到 window.Board 上');

  return { Board: ctx.window.Board, S, rootEl, bySel, STATUS };
}

/** 把三个桩里的卡片合并成一个数组，模拟 rootEl.querySelectorAll('.card') */
function wireCards(rootEl, bySel, STATUS) {
  rootEl.querySelectorAll = (sel) => {
    if (sel !== '.card') return [];
    return STATUS.map((s) => bySel.get('.column-body[data-status="' + s.key + '"]'))
      .filter(Boolean)
      .flatMap((el) => el.cards);
  };
}

test('markActive：只切高亮类名，不重建卡片 DOM', () => {
  const { Board, S, rootEl, bySel, STATUS } = loadBoard();
  wireCards(rootEl, bySel, STATUS);

  S.tickets = [
    { id: 'a', seq: 60, status: 'open', position: 1000, content: '第一张' },
    { id: 'b', seq: 65, status: 'open', position: 2000, content: '第二张' },
  ];

  Board.mount(rootEl);
  wireCards(rootEl, bySel, STATUS);
  Board.renderColumns();
  wireCards(rootEl, bySel, STATUS);

  const cardsBefore = rootEl.querySelectorAll('.card');
  assert.equal(cardsBefore.length, 2, '两张卡都应渲染出来');
  const rebuildsBefore = STATUS.reduce((n, s) => n + (bySel.get('.column-body[data-status="' + s.key + '"]')?.rebuilds || 0), 0);

  Board.markActive(60);

  const rebuildsAfter = STATUS.reduce((n, s) => n + (bySel.get('.column-body[data-status="' + s.key + '"]')?.rebuilds || 0), 0);
  assert.equal(rebuildsAfter, rebuildsBefore, '切高亮不能重写列容器 innerHTML（否则正被按着的卡片节点会被销毁，click 丢失）');

  const cards = rootEl.querySelectorAll('.card');
  assert.equal(cards[0], cardsBefore[0], '卡片节点必须是同一批对象，不能被重建');
  assert.ok(cards[0].hasClass('active'), 'seq 60 的卡要带 active');
  assert.ok(!cards[1].hasClass('active'), 'seq 65 的卡不该带 active');

  Board.markActive(65);
  const after = rootEl.querySelectorAll('.card');
  assert.ok(!after[0].hasClass('active'), '切到 65 后，60 的高亮要摘掉');
  assert.ok(after[1].hasClass('active'), '切到 65 后，65 要高亮');
  assert.equal(after.filter((c) => c.hasClass('active')).length, 1, '任何时刻只允许一张卡高亮');
});

test('markActive(null)：关闭详情后不留任何高亮', () => {
  const { Board, S, rootEl, bySel, STATUS } = loadBoard();
  wireCards(rootEl, bySel, STATUS);
  S.tickets = [{ id: 'a', seq: 60, status: 'open', position: 1000, content: '第一张' }];
  Board.mount(rootEl);
  wireCards(rootEl, bySel, STATUS);
  Board.renderColumns();
  wireCards(rootEl, bySel, STATUS);

  Board.markActive(60);
  assert.equal(rootEl.querySelectorAll('.card').filter((c) => c.hasClass('active')).length, 1);

  Board.markActive(null);
  assert.equal(
    rootEl.querySelectorAll('.card').filter((c) => c.hasClass('active')).length,
    0,
    '关详情后看板上不能残留高亮',
  );
});
