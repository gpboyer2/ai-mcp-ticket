#!/usr/bin/env node
// 演示数据：一条命令往库里灌几条有代表性的工单（不同状态、有人类评论、有 AI 评论带 model），
// 让刚 clone 下来的人打开页面就能看到「有内容」的看板，而不是五个空列。
//
// 为什么要这个脚本：本项目的工作区是**只读同步**自 DeepSeek Harness 的，没装 DSH 的人
// 启动后看到的是空看板 —— 这对新用户是劝退第一步。演示数据把这一步填上。
//
// 用法：
//   node scripts/demo-data.mjs              # 灌入演示工作区 + 演示工单
//   node scripts/demo-data.mjs --reset      # 先清掉演示工作区（连同其工单）再灌
//   node scripts/demo-data.mjs --port 8080  # 指定正在运行的实例端口（默认 47321）
//
// 只写「演示工作区」这一条数据（slug = demo-project），不碰你真实同步来的工作区。

import process from 'node:process';

const args = process.argv.slice(2);
const RESET = args.includes('--reset');
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : Number(process.env.PORT) || 47321;
const BASE = (process.env.BASE || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');

/** 演示工作区：用固定的 uuid，重复跑不会造出第二个 */
const DEMO_WS_ID = '00000000-0000-4000-8000-000000000001';
const DEMO_WS_SLUG = 'demo-project';
const DEMO_WS_PATH = '/path/to/your/workspace/demo-project';

// 演示用的两个 AI 身份。model 一律用公开可识别的名字 —— 不要把内部模型路由写进
// 会被截图、被放进 README 的演示数据里。
const AI = { 'X-Actor-Role': 'ai', 'X-Actor-Id': 'deepseek', 'X-Actor-Model': 'deepseek-v4.1' };
const AI2 = { 'X-Actor-Role': 'ai', 'X-Actor-Id': 'codex', 'X-Actor-Model': 'gpt-5-codex' };

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  }
  return json;
}

/**
 * 演示工单。顺序有意义：先建被依赖的，再建依赖它的。
 * 每条都写清楚「为什么要这条」——它们是给路过的人看的功能说明书。
 */
const TICKETS = [
  {
    title: '看板卡片显示最后一条评论摘要',
    body: '一屏 30 张卡时，前端不要对每张卡再发一次请求拿评论（N+1）。列表接口用 with_comments=1 一次带回。',
    status: 'in_progress',
    priority: 2,
    comments: [
      { actor: 'user', body: '卡片右侧还要能直接回评论，不要跳页。' },
      { actor: 'ai', body: '已加 with_comments=1，列表一次带回最后一条评论，N+1 消失。' },
    ],
  },
  {
    title: '纯文本列表在 status 过滤下仍返回全量 counts',
    body: 'counts 必须是该工作区的全量计数，不受本次筛选影响，否则看板列头的数字会跟着筛选跳。',
    status: 'open',
    priority: 1,
    comments: [{ actor: 'ai2', body: '确认过 repo 层：countsOf 走独立 SQL，不带 status 条件。' }],
  },
  {
    title: '拖拽换列后 position 落到目标列末尾',
    body: '拖到另一列时，position 取该列当前最大值 + 1024；同列内拖动则按前后邻居取中值。',
    status: 'done',
    priority: 1,
    comments: [
      { actor: 'user', body: '同列拖到最前面也要对。' },
      { actor: 'ai', body: '已覆盖：头部用 tail-1024，中间取 (prev+next)/2。' },
    ],
  },
  {
    title: 'AI 身份必须自报 id 与 model',
    body: 'role=ai 时缺 id 或 model 一律 400 ACTOR_REQUIRED。不允许匿名 AI —— 否则审计链断了，事后没人知道那句话是哪个模型说的。',
    status: 'done',
    priority: 2,
    comments: [{ actor: 'ai2', body: '测试已覆盖：缺 model、缺 id、两者都缺三种情况都断言了 400。' }],
  },
  {
    title: '上传图片单张限 10MB，不接受客户端文件名',
    body: '文件名由服务端生成 {yyyyMMdd}-{8位随机}.{ext}，防路径穿越。落盘 data/uploads/，已被 .gitignore 忽略。',
    status: 'open',
    priority: 0,
    comments: [],
  },
  {
    title: '调研：为什么不用现成的 kanban-mcp',
    body: '四个候选里三个没有 License 文件（法律上等于保留所有权利），唯一 MIT 的已停更一年多且是四包分离架构。结论是自己写，借数据模型不借代码。详见 docs/research.md。',
    status: 'cancelled',
    priority: 0,
    comments: [{ actor: 'ai', body: '调研报告已落 docs/research.md，含竞品 star / license / 最近提交实测。' }],
  },
];

const ACTOR_HEADERS = { user: {}, ai: AI, ai2: AI2 };

async function main() {
  console.log(`目标实例：${BASE}`);

  // 0) 连通性
  try {
    await api('/healthz');
  } catch (e) {
    console.error(`\n连不上 ${BASE}。先把服务起起来：npm start\n  原因：${e.message}`);
    process.exit(1);
  }

  // 1) 确保演示工作区存在。
  //    工作区是只读同步来的，没有 REST 建工作区的入口 —— 所以这里直接写库：
  //    在库旁边临时起一个 DSH 的 workspace.json，只含演示工作区，然后触发一次同步。
  //    这样走的是产品自己的正规同步路径，而不是往表里硬插。
  const existing = (await api('/api/workspaces?include_archived=1')).find((w) => w.slug === DEMO_WS_SLUG);

  if (RESET && existing) {
    const list = await api(`/api/workspaces/${DEMO_WS_SLUG}/tickets?limit=1000`);
    for (const t of list.tickets) {
      await api(`/api/tickets/${t.id}`, { method: 'DELETE' });
    }
    console.log(`已清空演示工作区的 ${list.tickets.length} 张工单`);
  }

  const before = (await api(`/api/workspaces/${DEMO_WS_SLUG}/tickets?limit=1000`).catch(() => null));
  if (before && before.tickets.length > 0 && !RESET) {
    console.log(`演示工作区已有 ${before.tickets.length} 张工单，跳过。要重灌加 --reset。`);
    console.log(`\n打开 ${BASE.replace(/:\d+$/, ':' + PORT)} 看效果。`);
    return;
  }

  if (!existing) {
    console.error(
      '\n演示工作区还不存在。工作区只读同步自 DeepSeek Harness，本项目没有手动建工作区的接口。\n' +
        '请先让服务能看到一个叫 demo-project 的工作区，两种办法任选：\n' +
        '  A) 装了 DSH：把任意目录加进 DSH 工作区，名字叫 demo-project；\n' +
        '  B) 没装 DSH：设 DSH_HOME 指向一个含 storages/workspace.json 的目录，文件内容：\n' +
        `     {"tables":{"workspaces":{"${DEMO_WS_ID}":{"path":"${DEMO_WS_PATH}","title":"demo-project"}}}}\n` +
        '     然后 DSH_HOME=<那个目录> npm start，再跑本脚本。\n',
    );
    process.exit(1);
  }

  // 2) 灌工单
  let created = 0;
  let comments = 0;
  for (const t of TICKETS) {
    const made = await api(`/api/workspaces/${DEMO_WS_SLUG}/tickets`, {
      method: 'POST',
      body: { title: t.title, body: t.body, status: t.status, priority: t.priority },
    });
    created++;
    for (const c of t.comments) {
      await api(`/api/tickets/${made.id}/comments`, {
        method: 'POST',
        headers: ACTOR_HEADERS[c.actor],
        body: { body: c.body },
      });
      comments++;
    }
  }

  console.log(`\n✔ 建了 ${created} 张工单、${comments} 条评论（含 user / 两个不同 AI 的 model）`);
  console.log(`\n打开 ${BASE} 看板，或看纯文本视图：`);
  console.log(`  curl -H 'Accept: text/plain' ${BASE}/${DEMO_WS_SLUG}/list`);
}

main().catch((e) => {
  console.error(`\n失败：${e.message}`);
  process.exit(1);
});
