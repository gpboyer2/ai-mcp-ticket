# 调试记录：血的教训

本文档汇总 ai-mcp-ticket 项目里「踩过的坑 / 事故经过 / 规矩」类内容。这些段落原本写在 `AGENTS.md` 里、篇幅较长，外链到这里方便随时翻查，也避免把 `AGENTS.md` 撑得太长。

---

## 端口纪律（血的教训，2026-11-04）

`47321` 只属于真实实例，数据库必须是 `data/ticket.db`。

事故经过：有人用 `DB_PATH=/tmp/ci_dsh/ticket.db PORT=47321` 起了自测实例，把用户真实服务挤掉约 10 分钟，
网页上 26 张工单全部消失（数据没丢，只是连错了库）。同类事故当天发生两次（`/tmp/ci_dsh`、`/tmp/rt`）。

规矩：

1. 自测一律用**随机端口 + 临时 db**（`PORT=0` 或自己挑 5 位端口，`DB_PATH=$(mktemp -d)/t.db`）。
2. 绑定端口前先检查是否被占：`lsof -nP -iTCP:<port> -sTCP:LISTEN`。
3. **禁止** `pkill -f "node src/server.js"` —— 会杀掉真实服务。停进程用 pid 文件或精确 pid。
4. 真实服务的启停只用 `bash scripts/ticket.sh {start|stop|restart|status}`（有 pid 文件管理）。
5. 每次自测收尾都要核一遍：`curl -s localhost:47321/healthz` 里的 `db` 必须是
   `<项目根>/data/ticket.db`。
6. pid 文件由服务进程自己写（`src/pidfile.js`，跟着数据库目录走）。launchd 起的实例也有 pid，
   所以 `ticket.sh status / stop` 对开机自启的实例照样管用；自测用临时 db 时 pid 落在临时目录，不会污染真实实例。

## MCP 怎么启动（2026-11-05 教训，返工两次）

现象：装了 MCP 之后重启电脑，`http://localhost:47321/ai-mcp-ticket/list` 连不上，MCP 工具也不可用。

两次返工的经过，两次都错在同一处：**把 MCP 的可用性绑在「有没有人守着进程」上**。

1. 第一版认为「MCP 是 HTTP 端点，所以必须常驻」，于是写了 launchd 的 plist。macOS 能跑，
   但 Windows / Linux 用户按这个流程就得各自找守护进程——等于这个 MCP 出了 Mac 就不好用。
2. 第二版仍然只有 HTTP 一条路，只是把注册做成了脚本。换平台依旧不成立。

事实：别的 MCP（filesystem、serena、数据库类）都是 **stdio** —— 客户端用 `npx` / `uvx` / `node`
当子进程拉起来，用完就退。所以它们跨平台、零安装、也不存在「重启后没起来」。它们不是服务，是进程。

规矩：

- **MCP 走 stdio**（`npm run mcp` → `src/mcp-stdio.js`），由客户端拉起，macOS / Windows / Linux 一致，
  不需要任何开机自启。实测：把 47321 的进程停掉（0 个监听），MCP 工具照样能读工单。
- **看板才是服务**：网页要随时能打开，才需要 47321 上有个进程；这一步与 MCP 无关，按平台各自做
  （macOS 用 `scripts/install-autostart.sh`，Linux 用 systemd/pm2，Windows 用任务计划程序/pm2/nssm）。
- HTTP 端点（`/mcp`）保留给「多个客户端共用同一个常驻进程 / 局域网共享」的场景，不再是默认路径。

平台相关的坑（只在要常驻时才遇到）：

1. plist 里的 `ProgramArguments` 直接给 node，**不要**套 `/bin/sh -c`。macOS 的 Desktop 目录有 TCC 保护，
   launchd 拉起的 shell 读写项目目录会 `Operation not permitted`（日志里表现为 pid 文件写不进去）。
2. `KeepAlive` 用 `SuccessfulExit=false`，异常退出才重启。设成 `true` 会让 `ticket.sh stop` 停不下来
   （杀掉 10 秒后又被拉起）。
3. 排查看 `data/launchd.log` 与 `launchctl print gui/$(id -u)/com.<用户名>.ai-mcp-ticket`。

---

## 状态流转纪律（2026-11-04 教训，同日返工一次）

用户明确要求：**AI 必须自己维护工单状态**。这不是可选项，是本职。

事故第一轮：20 张工单里 15 张早就干完了（有 AI 评论留痕），但状态全停在「打开」。
当时的做法是「写评论时接口在返回文本末尾追加一行 `status_hint` 提醒」——**这个做法失败了**。
用户的原话是「明明设定了各种规则和钩子，但是没有生效，说明现有的都是没有必要存在的，真正起效果的钩子没有造出来」。

返工前的实测证据：36 张工单里 **0 张被认领过**；状态变更全部是事后批量补（07:29 一次 14 张、
12:36 一次 6 张、12:30 一次 4 张）；唯一还 open 的 `ai-剧本#60` 里 AI 评论明明写着「做完的动作」。

**根因**：软提醒只往返回文本末尾追加一行字，改不改由 AI 自己决定，**不改没有任何后果**。
写路径（`src/repo/`）里一行状态检查都没有 —— 提醒是装饰，不是钩子。

现行机制（契约 5.5.2 / 5.5.3 / 5.5.4，全部有单测）：

1. **硬门**：`role=ai` 在 `open` 工单上写评论 → **400 `TICKET_NOT_STARTED`**，评论不落库。
   文案一次给出两条出路（先 PATCH `in_progress`，或本次评论直接带 `status=in_progress`），
   所以不会把人烦住 —— 改成处理中就放行。
2. **原子提交**：写评论时带 `status`，评论与状态在同一个事务里落地。状态照样过迁移表，
   改成 `done` / `cancelled` 同一次 UPDATE 释放认领。**这是「已完成」的唯一可靠通道**，
   不做词表猜测。
3. **读侧标记**：列表纯文本里按原因分两档点名漏网单，只标记、不改数据 ——
   词表猜错不能伤数据。两档分开写，因为「补错状态」比「不提醒」更糟：
   - `# 待办: … 可能漏了 status=done` —— 处理中/已重开，且最后一条 AI 评论像完工报告
   - `# 待办: … 漏了 status=in_progress` —— **打开的单上已经有 AI 评论**。
     这一档是第一轮返工时漏掉的：用户抱怨的正是这类「AI 干过活、状态还开着」的单，
     而当时只判 `in_progress`，历史遗留的 open 单一条都标不出来。
     它也是 `in_progress → open` 被合法挪回去之后的形态，光看状态字段看不出来。
4. **user 完全不受限**：用户在网页上写评论、拖拽卡片一切照旧。

规矩：

1. **每张工单改完代码 + 验收通过后，立刻推进状态**，再去做下一张。不许攒到最后。
2. 状态机不允许跳步：`open → in_progress → done`；`done → reopened → in_progress` 是救援路径。
3. 收尾那条评论直接带 `status=done`，一次调用搞定，别分成两次（两次之间崩了就是半截状态）。
4. **直接调接口，不要绕前端**。AI 用 `mcp__ticket__comment_add` 或
   `PATCH /api/tickets/:id`，一行就够。前端拖拽只是给人用的。
5. 每轮开工前先 `ticket_list` 看一遍：有没有 `# 待办:` 标记的漏网工单，先补状态。
6. 看板是给用户看进度的唯一窗口。状态不准 = 用户在瞎猜。

**设计原则**：一条规则只许有一份实现。硬门写在 `src/repo/comments.js` 的 `create()` 里，
REST 与 MCP 共用；状态迁移与认领释放复用 `tickets.update()`。不许在第二个文件里复制一份再改。
