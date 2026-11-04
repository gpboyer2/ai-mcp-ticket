// 端口解析（工单 ai-剧本#70）
//
// 为什么单独一个模块：这里出过真实事故 ——
// 原写法 `Number(process.env.PORT) || 47321` 会让 `PORT=0` 静默变成 47321，
// 于是"想要随机端口的自测实例"直接顶掉了用户正在用的真实服务（当天两次）。
//
// 抽成纯函数还有个好处：能单测，不用真去 bind 端口 ——
// 否则测试自己想绑 47321 时，会被正在运行的真实服务占住而失败。

export const DEFAULT_PORT = 47321;

/**
 * 把环境变量 PORT 解析成端口号。
 * - 未设置 / 空串 → 默认 47321
 * - "0" → 0（合法，交给系统分配随机端口）
 * - 其它非整数或越界 → 抛错（调用方负责退出进程，不静默降级）
 * @param {string|undefined|null} raw
 * @returns {number}
 */
export function resolvePort(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_PORT;
  // 只认十进制数字串：Number('0x10') 会得到 16、Number('1e5') 得到 100000，
  // 这类写法在环境变量里几乎一定是笔误，宁可报错也不要猜用户想要什么。
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(`PORT 不合法："${raw}"。必须是十进制整数 0..65535（0 表示由系统分配随机端口）。`);
  }
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`PORT 不合法："${raw}"。必须是十进制整数 0..65535（0 表示由系统分配随机端口）。`);
  }
  return n;
}
