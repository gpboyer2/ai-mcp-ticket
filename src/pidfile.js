// pid 文件：由服务进程自己写，谁起的都算数（launchd / scripts/ticket.sh / npm start）。
// 放在数据库同目录：自测用临时库时，pid 文件也落在临时目录，不会覆盖真实实例的那一份。
import fs from 'node:fs';
import path from 'node:path';

/** 数据库为 :memory: 时没有目录可放，返回 null 表示不写 pid 文件。 */
export function pidFilePath(dbPath) {
  if (dbPath === ':memory:') return null;
  return path.join(path.dirname(dbPath), 'server.pid');
}

export function writePidFile(file, pid = process.pid) {
  if (!file) return;
  fs.writeFileSync(file, String(pid));
}

/** 只删自己的：pid 文件已被别的实例改写时不动，避免把他人的 pid 抹掉。 */
export function removePidFile(file, pid = process.pid) {
  if (!file) return;
  try {
    if (fs.readFileSync(file, 'utf8').trim() === String(pid)) fs.unlinkSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}