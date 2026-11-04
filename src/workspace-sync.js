// 从 DeepSeek Harness 只读同步工作区列表。
// 为什么容错要这么厚：workspace.json 是外部进程写的，可能正在被改写、可能格式演进、
// 可能整台机器上根本没装 DSH。同步失败绝不能拖垮工单系统本身，只能记 warn 保留旧数据。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { nowIso } from './db.js';

export const DEFAULT_DSH_WORKSPACE_FILE = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json');

export function resolveDshWorkspaceFile() {
  const home = process.env.DSH_HOME;
  if (home) return path.join(home, 'storages', 'workspace.json');
  return DEFAULT_DSH_WORKSPACE_FILE;
}

/** slug 生成：path basename → 小写、空格转 -、去非法字符 */
export function slugifyBase(p) {
  const base = path.basename(String(p || '').replace(/[/\\]+$/, '')) || 'workspace';
  const slug = base
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '') // 保留中文等 Unicode 字母，中文目录名也能当 slug
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug || 'workspace';
}

/** 冲突时追加 path 的 4 位哈希：同一 basename 在不同目录时才能区分，且结果稳定可复现 */
export function slugWithHash(p) {
  const h = createHash('sha1').update(String(p)).digest('hex').slice(0, 4);
  return `${slugifyBase(p)}-${h}`;
}

/** 读 DSH 的 workspace.json，返回 [{id,path,title}]；任何异常都返回 null（调用方据此保留旧数据） */
export function readDshWorkspaces(file = resolveDshWorkspaceFile()) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, reason: `读不到 ${file}: ${e.code || e.message}`, items: [] };
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `${file} JSON 解析失败: ${e.message}`, items: [] };
  }

  const table = json?.tables?.workspaces;
  if (!table || typeof table !== 'object') {
    return { ok: false, reason: `${file} 里没有 tables.workspaces`, items: [] };
  }

  const items = [];
  for (const [id, v] of Object.entries(table)) {
    if (!v || typeof v !== 'object') continue;
    const p = typeof v.path === 'string' ? v.path : '';
    if (!p) continue;
    items.push({
      id,
      path: p,
      title: typeof v.title === 'string' && v.title.trim() ? v.title.trim() : path.basename(p),
    });
  }
  return { ok: true, reason: null, items };
}

/**
 * 执行一次同步。
 * @returns {{synced:number, added:number, updated:number, archived:number, ok:boolean, reason?:string}}
 */
export function syncWorkspaces(db, workspaceRepo, { file } = {}) {
  const src = readDshWorkspaces(file);
  if (!src.ok) {
    // 文件不在 / 坏掉：不归档任何东西，保留现有数据，只报 warn
    console.warn(`[workspace-sync] 跳过同步：${src.reason}`);
    return { synced: 0, added: 0, updated: 0, archived: 0, ok: false, reason: src.reason };
  }

  let added = 0;
  let updated = 0;
  const seen = [];

  const run = db.transaction(() => {
    for (const item of src.items) {
      const existing = db.prepare('SELECT id, slug FROM workspaces WHERE id = ?').get(item.id);
      let slug = existing?.slug;
      if (!slug) {
        // 新工作区：先试干净 basename，被占了再加哈希，保证 slug 唯一且稳定
        const base = slugifyBase(item.path);
        slug = workspaceRepo.slugTaken(base, item.id) ? slugWithHash(item.path) : base;
      }
      const r = workspaceRepo.upsert({ id: item.id, slug, title: item.title, path: item.path });
      if (r.added) added++;
      if (r.updated) updated++;
      seen.push(item.id);
    }
  });
  run();

  const archived = workspaceRepo.archiveMissing(seen);

  return { synced: seen.length, added, updated, archived, ok: true, synced_at: nowIso() };
}

/**
 * 启动同步 + 定时同步。返回 stop()，供测试与优雅退出使用。
 * interval 用 unref 避免把进程吊着不退。
 */
export function startWorkspaceSync(db, workspaceRepo, { file, intervalMs = 60_000 } = {}) {
  const tick = () => {
    try {
      syncWorkspaces(db, workspaceRepo, { file });
    } catch (e) {
      console.warn('[workspace-sync] 同步异常（已忽略）:', e.message);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer), sync: tick };
}
