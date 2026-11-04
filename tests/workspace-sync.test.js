// 工作区只读同步（契约 1.2、3.1）。
// 为什么重点测"文件缺失不崩"：workspace.json 是 DSH 进程写的，DSH 没开 / 正在改写都会读不到，
// 这时候同步必须只 warn 保留旧数据，绝不能把工单系统一起带崩。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { req, startTestApp, writeWorkspaceFile } from './_helpers.js';
import {
  readDshWorkspaces,
  slugifyBase,
  slugWithHash,
  resolveDshWorkspaceFile,
} from '../src/workspace-sync.js';

test('新增 / 更新 / 归档三种同步情况', async () => {
  const app = await startTestApp({
    workspaces: {
      'ws-a': { path: '/tmp/proj-alpha', title: 'Alpha 项目' },
      'ws-b': { path: '/tmp/proj-beta', title: 'Beta 项目' },
    },
  });
  try {
    // ---- 新增：两个工作区都应入库，slug 由 basename 生成
    assert.equal(app.syncRes.status, 200);
    const s1 = (await req(app.base, '/api/workspaces')).body;
    assert.equal(s1.length, 2, '同步后应有 2 个工作区');
    assert.deepEqual(
      s1.map((w) => w.slug).sort(),
      ['proj-alpha', 'proj-beta'],
      'slug 必须由 path 的 basename 生成（契约 1.2）',
    );
    assert.equal(s1[0].archived, false);
    assert.deepEqual(
      s1.find((w) => w.slug === 'proj-alpha').ticket_counts,
      { open: 0, in_progress: 0, reopened: 0, done: 0, cancelled: 0, total: 0 },
      '契约 3.1 要求返回六项计数（含 total），即使一张工单都没有',
    );
    assert.ok(s1[0].synced_at, '返回项必须带 synced_at');

    // ---- 更新：改标题（slug 必须保持不变，因为 ref 依赖它）
    writeWorkspaceFile(app.dir, {
      'ws-a': { path: '/tmp/proj-alpha', title: 'Alpha 改名了' },
      'ws-b': { path: '/tmp/proj-beta', title: 'Beta 项目' },
    });
    const u = (await req(app.base, '/api/workspaces/sync', { method: 'POST' })).body;
    assert.equal(u.ok, true);
    assert.equal(u.synced, 2);
    assert.equal(u.updated, 1, '只改了 ws-a 的标题，updated 应为 1');
    assert.equal(u.added, 0, '没有新工作区，added 应为 0');
    assert.equal(u.archived, 0);
    const afterUpdate = (await req(app.base, '/api/workspaces')).body;
    const a = afterUpdate.find((w) => w.id === 'ws-a');
    assert.equal(a.title, 'Alpha 改名了', '标题必须被更新');
    assert.equal(a.slug, 'proj-alpha', 'slug 一旦定下不得随 title 变化（ref 里带着它）');

    // ---- 归档：ws-b 从 DSH 消失 → archived=1，但不删（可能已有工单挂靠）
    writeWorkspaceFile(app.dir, {
      'ws-a': { path: '/tmp/proj-alpha', title: 'Alpha 改名了' },
    });
    const d = (await req(app.base, '/api/workspaces/sync', { method: 'POST' })).body;
    assert.equal(d.archived, 1, '消失的工作区应被归档 1 个');
    assert.equal(d.synced, 1);
    // 默认列表不含归档
    const visible = (await req(app.base, '/api/workspaces')).body;
    assert.deepEqual(visible.map((w) => w.id), ['ws-a'], '默认列表不含归档工作区');
    // include_archived=1 才含
    const all = (await req(app.base, '/api/workspaces?include_archived=1')).body;
    assert.equal(all.length, 2, '?include_archived=1 必须包含归档项');
    const b = all.find((w) => w.id === 'ws-b');
    assert.equal(b.archived, true, '归档是标记而不是删除（契约 1.2）');

    // 归档工作区仍可访问其工单（否则历史工单变孤儿）
    const reach = await req(app.base, '/api/workspaces/proj-beta/tickets');
    assert.equal(reach.status, 200, '归档工作区仍应可访问（有工单挂靠）');

    // ---- 复活：ws-b 重新出现在 DSH → archived 回到 0
    writeWorkspaceFile(app.dir, {
      'ws-a': { path: '/tmp/proj-alpha', title: 'Alpha 改名了' },
      'ws-b': { path: '/tmp/proj-beta', title: 'Beta 项目' },
    });
    const r = (await req(app.base, '/api/workspaces/sync', { method: 'POST' })).body;
    assert.equal(r.archived, 0);
    const revived = (await req(app.base, '/api/workspaces?include_archived=1')).body.find((w) => w.id === 'ws-b');
    assert.equal(revived.archived, false, '工作区回到 DSH 后必须取消归档');
  } finally {
    await app.close();
  }
});

test('workspace.json 缺失 / 坏 JSON / 结构不对：不崩、不归档、保留旧数据', async () => {
  const app = await startTestApp({
    workspaces: { 'ws-a': { path: '/tmp/proj-alpha', title: 'Alpha' } },
  });
  try {
    const before = (await req(app.base, '/api/workspaces?include_archived=1')).body;
    assert.equal(before.length, 1);

    // 1) 文件被删掉
    fs.rmSync(app.wsFile);
    const missing = await req(app.base, '/api/workspaces/sync', { method: 'POST' });
    assert.equal(missing.status, 200, '同步失败不能是 5xx，必须优雅返回');
    assert.equal(missing.body.ok, false, 'ok:false 表示这次没同步成');
    assert.equal(missing.body.archived, 0, '读不到源文件时绝不能把已有工作区全部归档');
    const afterMissing = (await req(app.base, '/api/workspaces?include_archived=1')).body;
    assert.equal(afterMissing.length, 1, '旧数据必须原样保留');
    assert.equal(afterMissing[0].archived, false, '旧工作区不得被误归档');

    // 2) 文件存在但不是 JSON
    fs.writeFileSync(app.wsFile, '{ 这不是 json', 'utf8');
    const badJson = (await req(app.base, '/api/workspaces/sync', { method: 'POST' })).body;
    assert.equal(badJson.ok, false);
    assert.equal(badJson.archived, 0);
    assert.match(String(badJson.reason), /JSON/, 'reason 里应说明是 JSON 解析失败，便于排障');

    // 3) 合法 JSON 但没有 tables.workspaces
    fs.writeFileSync(app.wsFile, JSON.stringify({ tables: {} }), 'utf8');
    const noTable = (await req(app.base, '/api/workspaces/sync', { method: 'POST' })).body;
    assert.equal(noTable.ok, false);
    assert.match(String(noTable.reason), /tables\.workspaces/);

    // 4) 记录里 path 为空 / 不是对象 → 跳过该条，不影响其它
    writeWorkspaceFile(app.dir, {
      'ws-a': { path: '/tmp/proj-alpha', title: 'Alpha' },
      'ws-empty': { title: '没有 path' },
      'ws-null': null,
    });
    const mixed = (await req(app.base, '/api/workspaces/sync', { method: 'POST' })).body;
    assert.equal(mixed.ok, true);
    assert.equal(mixed.synced, 1, '没有 path 的记录应被跳过（工单必须有工作区路径）');

    // 5) 服务依然活着
    const h = await req(app.base, '/healthz');
    assert.equal(h.status, 200);
    assert.equal(h.body.ok, true);
  } finally {
    await app.close();
  }
});

test('slug 冲突时追加短哈希，且结果稳定', async () => {
  const app = await startTestApp({
    workspaces: {
      // 两个不同目录但 basename 相同
      'ws-1': { path: '/a/same-name', title: '第一个' },
      'ws-2': { path: '/b/same-name', title: '第二个' },
    },
  });
  try {
    const list = (await req(app.base, '/api/workspaces')).body;
    const slugs = list.map((w) => w.slug).sort();
    assert.equal(new Set(slugs).size, 2, 'slug 必须唯一，否则 ref 无法区分两张工单');
    assert.ok(slugs.includes('same-name'), '先来的应拿到干净 basename');
    assert.match(
      slugs.find((s) => s !== 'same-name'),
      /^same-name-[0-9a-f]{4}$/,
      '冲突时应追加 4 位哈希',
    );

    // 再同步一次，slug 不得漂移（否则已发出去的 ref 全部失效）
    await req(app.base, '/api/workspaces/sync', { method: 'POST' });
    const again = (await req(app.base, '/api/workspaces')).body.map((w) => w.slug).sort();
    assert.deepEqual(again, slugs, '重复同步后 slug 必须完全一致');
  } finally {
    await app.close();
  }
});

test('slug 生成规则与 DSH 源路径解析（纯函数）', () => {
  assert.equal(slugifyBase('/path/to/your/workspace/ai-mcp-ticket'), 'ai-mcp-ticket');
  assert.equal(slugifyBase('/tmp/My Project'), 'my-project', '空格转 -，且转小写');
  assert.equal(slugifyBase('/tmp/中文项目'), '中文项目', '中文目录名应保留（Unicode 字母）');
  assert.equal(slugifyBase('/tmp/a___b'), 'a___b');
  assert.equal(slugifyBase('/'), 'workspace', '根目录兜底成 workspace，不能返回空串');
  assert.equal(slugifyBase(''), 'workspace');
  assert.equal(slugifyBase('/tmp/---'), 'workspace', '全是非法字符时兜底');

  // 同一个 path 哈希稳定，不同 path 不同
  assert.equal(slugWithHash('/a/x'), slugWithHash('/a/x'), '哈希必须可复现（否则每次同步都换 slug）');
  assert.notEqual(slugWithHash('/a/x'), slugWithHash('/b/x'));

  // DSH_HOME 覆盖
  const old = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = '/tmp/fake-dsh';
    assert.equal(resolveDshWorkspaceFile(), path.join('/tmp/fake-dsh', 'storages', 'workspace.json'));
    delete process.env.DSH_HOME;
    assert.match(resolveDshWorkspaceFile(), /\.dsh\/storages\/workspace\.json$/);
  } finally {
    if (old !== undefined) process.env.DSH_HOME = old;
  }

  // readDshWorkspaces 的直接单测：title 缺失时回落到 basename
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-ws-'));
  try {
    const f = writeWorkspaceFile(dir, { id1: { path: '/x/fallback-name' } });
    const r = readDshWorkspaces(f);
    assert.equal(r.ok, true);
    assert.equal(r.items[0].title, 'fallback-name', 'title 缺失时应回落为 path 的 basename');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('同步由 DSH_HOME 决定数据源（契约 1.2 的默认路径规则）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-dsh-'));
  const old = process.env.DSH_HOME;
  try {
    // 造一个 DSH_HOME/storages/workspace.json
    fs.mkdirSync(path.join(dir, 'storages'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'storages', 'workspace.json'),
      JSON.stringify({ tables: { workspaces: { z: { path: '/tmp/from-dsh-home', title: '来自 DSH_HOME' } } } }),
      'utf8',
    );
    process.env.DSH_HOME = dir;
    const r = readDshWorkspaces(); // 不传 file，应走 DSH_HOME
    assert.equal(r.ok, true);
    assert.equal(r.items[0].id, 'z');
    assert.equal(r.items[0].title, '来自 DSH_HOME');
  } finally {
    if (old === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
