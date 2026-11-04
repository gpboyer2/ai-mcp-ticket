# ai-mcp-ticket 调研报告

> 调研时间：2026-11-04（Asia/Shanghai）
> 调研范围：开源方案对比、DSH MCP 接入机制、MCP streamable-http 服务端做法、SQLite 选型、AI 友好的纯文本 URL 约定
> 实测环境：macOS arm64，Node 22.x（另有 DSH 自带 Node 24.x），DSH Desktop 0.2.1-rc.x

---

## 结论速览

| # | 问题 | 结论 |
|---|---|---|
| 1 | 复用哪个开源方案 | **不复用，自己写**。最接近的 kanzo 是 AGPL-3.0（会传染）、且没有「按工作区隔离」和「AI 纯文本 URL」；其余 3 个 kanban-mcp 要么无 License、要么停更、要么是 Python/Next.js 重栈。可借鉴的是**数据模型**与**工具命名**，不是代码 |
| 2 | 改 cordis.patch.yml 要不要重启 DSH | **不要重启**。profile 配置变更走 HMR 重载队列，插件原地重载。已用实测验证（见 2.4） |
| 3 | streamable-http 标准做法 | `@modelcontextprotocol/sdk` 1.x：`StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` = 无状态模式，每请求新建 server+transport，与 express 5 共存需注意 `express.json()` 位置和 GET/DELETE 返回 405 |
| 4 | SQLite 选型 | **better-sqlite3**。理由：Node 22 的 `node:sqlite` 仍是 Stability 1.1（Active development），API 还是 `DatabaseSync` 老名字、无 `Database` 导出；better-sqlite3 有 prebuild 二进制、同步 API、事务封装、WAL 一行 pragma |
| 5 | AI 纯文本 URL 约定 | 业界主流是 **`Accept: text/plain`/`text/markdown` 内容协商 + `.md` 后缀镜像 + `/llms.txt` 索引**。我们三者都用：内容协商为主、`?format=text` 兜底、`/{ws}/list` 作工作区索引 |

---

## 1. 现成开源方案对比

### 1.1 用户点名的四个项目

数据来自 GitHub REST API（`gh api`，已认证绕过限流），抓取时间 2026-11-04。

| 项目 | Star | 最近提交 | License | 语言 | 单进程 | SQLite | 评论 | 拖拽 | AI 纯文本视图 |
|---|---|---|---|---|---|---|---|---|---|
| [rgracey/kanban-mcp](https://github.com/rgracey/kanban-mcp) | 2 | 2026-02-24 | **无** | Go | ✅ 单二进制 | ✅ 内嵌 | ⚠️ 只有 notes | ✅ | ❌ |
| [eyalzh/kanban-mcp](https://github.com/eyalzh/kanban-mcp) | 41 | 2025-07-13 | MIT | TypeScript | ❌ MCP/Web 两个进程 | ✅ | ❌ | ❌ | ❌ |
| [0xdzik/kanban-mcp](https://github.com/0xdzik/kanban-mcp) | 4 | 2026-02-26 | **无** | TypeScript | ⚠️ Next.js 应用 | ✅ Drizzle | ✅ 评论线程 | ✅ dnd-kit | ❌ |
| [TheBengineer/KanbanMCP](https://github.com/TheBengineer/KanbanMCP) | 1 | 2026-08-06 | **无** | Python | ✅ | ✅ WAL | ❌ 只有 checklist | ✅ SortableJS | ❌ |

**逐个说明**

**rgracey/kanban-mcp**（Go，2 star，2026-02-24 后无提交）
- 架构最接近我们的目标：单个二进制，`--mcp-transport stdio|http|both`，SQLite + 前端资源全内嵌，Web UI 默认 8080，MCP 在 `/mcp`（[README](https://raw.githubusercontent.com/rgracey/kanban-mcp/main/README.md)，L145-214）。
- 有 audit history、blocking relations、SSE 实时刷新、`board context` 一次性拿全板（省 token）。
- **但没有 License 文件**（`gh api repos/rgracey/kanban-mcp/license` → 404，raw LICENSE → 404）。法律上等于"保留所有权利"，不能作为基础复用。
- 没有"给 AI 的纯文本 URL"，只有 MCP 工具。
- 另外它是 Go，我们是 Node，语言不通。

**eyalzh/kanban-mcp**（TypeScript，41 star，**2025-07-13 停更**，MIT）
- 四个里唯一 MIT、star 最高，但架构是 `mcp-server` + `web-server` + `web-ui` + `shared/db` 四个 npm 包分别 `npm ci && npm run build`（README L14-30），不是单进程。
- 没有评论，没有拖拽，没有纯文本视图。
- 核心卖点是 WIP limit（列容量限制），我们不需要。
- 一年半没更新，MCP SDK 早已从 1.x 换到 2.x，接口大概率过时。

**0xdzik/kanban-mcp**（TypeScript + Next.js 16，4 star，2026-02-26）
- 功能最全：拖拽（dnd-kit）、评论线程、子任务、标签、活动日志、13 个 MCP 工具 + 4 个 resource（`kanban://task/{id}` 等）。
- 但：**无 License**；技术栈是 Next.js 16 + Drizzle + shadcn + Zustand，我们只想要"单进程 + 原生 HTML"，引入 Next.js 会带来构建步骤和一大坨依赖。
- 它的 resource URI 设计（`kanban://task/{id}`）值得借鉴。

**TheBengineer/KanbanMCP**（Python + FastAPI，1 star，2026-08-06）
- 唯一明确写了 "One SQLite file, single process"（README L3），并且明确 "SQLite with WAL mode for concurrent web + MCP access"（这是我们要的）。
- Web UI 用 HTMX + SortableJS，MCP over HTTP 在 `/mcp`，还有 stdio 代理。
- 但：**无 License**；Python 栈（我们项目是 Node）；无评论功能；138 个测试但没有纯文本视图。

### 1.2 其他值得看的项目（GitHub 搜索发现）

搜索关键词：`mcp kanban`、`mcp ticket system`、`agent task board mcp`、`llm todo mcp server`、`kanban mcp sqlite`（按 star 排序）。

| 项目 | Star | 最近提交 | License | 语言 | 关键特征 |
|---|---|---|---|---|---|
| [emanuele-em/kanzo](https://github.com/emanuele-em/kanzo) | 988 | 2026-11-02 | **AGPL-3.0** | Rust | 最接近的目标形态（见下） |
| [usekaneo/kaneo](https://github.com/usekaneo/kaneo) | 9708 | 2026-11-03 | MIT | TypeScript | 完整项目管理平台，重，非 MCP 原生 |
| [markrai/scrumboy](https://github.com/markrai/scrumboy) | 448 | 2026-11-01 | AGPL-3.0 | Go | 项目管理全家桶 + MCP，过重 |
| [ustoppble/overclick](https://github.com/ustoppble/overclick) | 119 | 2026-11-04 | MIT | TypeScript | 人审 + AI 执行，但用 **PostgreSQL** + Docker |
| [sirsjg/flux](https://github.com/sirsjg/flux) | 108 | 2026-10-21 | MIT | TypeScript | 数据存**单个 JSON 文件**在 git 里，不是 SQLite |
| [tcarac/taskboard](https://github.com/tcarac/taskboard) | 39 | 2026-02-16 | MIT | Go | 单二进制 + SQLite + 22 个 MCP 工具 + 拖拽，但 Go |
| [phodal/routa](https://github.com/phodal/routa) | 1836 | 2026-10-14 | MIT | TypeScript | 多 agent 协作平台，比我们要的大一个数量级 |

**kanzo 值得单独说**（最接近的竞品）：
- 单 4.5 MB 程序 = 浏览器看板 + MCP server + CLI 三合一，数据在 `~/kanzo/kanzo.db`（SQLite），MCP 在 `http://localhost:4242/mcp`。
- 明确优化了 token：README「Small and fast」表格写「Agents' tool list ~900 tokens once per session / Agents' replies 10-60 tokens of plain text」。
- 有评论、有拖拽、有"Human"标记让 agent 别碰、支持局域网共享。
- **但**：(a) **AGPL-3.0**——我们只要通过网络提供服务，改过的代码就必须开源，对本项目是硬伤；(b) 数据模型是 `project`，不是"按 DSH 工作区隔离"；(c) 没有"AI 读 URL 拿 text/plain"这条路径，只有 MCP 工具；(d) Rust，无法作为 Node 项目的依赖。

### 1.3 结论：自己写，借设计不借代码

**决策：不 fork、不 vendor、不作为依赖引入任何上述项目。** 理由按优先级：

1. **License 是硬门槛**。四个点名项目里三个（rgracey、0xdzik、TheBengineer）**完全没有 License 文件**——法律上不可复用。唯一 MIT 的 eyalzh 已停更 16 个月且架构是四包分离。最接近的 kanzo 是 AGPL-3.0，会把整个项目拖进 copyleft。
2. **没有一个满足"AI 纯文本 URL"**。这是我们最核心的差异化需求（用户明确要求 `text/plain` 省 token），所有项目都只做 MCP 工具。kanzo 虽然在 MCP 返回里省 token，但没有"AI 直接 fetch 一个 URL 拿到纯文本"的路径。
3. **没有一个满足"工作区只读同步自 DSH"**。这是本项目独有的领域约束，任何通用 kanban 都不会有。
4. **技术栈对不上**。Go（rgracey/taskboard/scrumboy）、Rust（kanzo）、Python（TheBengineer）、Next.js 全家桶（0xdzik）——我们的目标是 Node + 原生 HTML 无构建。

**具体借鉴什么**（合法且省事）：

| 来源 | 借鉴内容 |
|---|---|
| rgracey | `board context` 一次调用返回整板快照（`filter_status` + `omit_descriptions` 控制 token）；`board ready` 只返回未被 block 的 todo（AI 的工作队列）；action-dispatch 工具模式（一个资源一个工具 + `action` 参数） |
| 0xdzik | MCP resource URI 设计 `kanban://project/{id}/tasks`、`kanban://task/{id}`；活动日志表结构 |
| TheBengineer | "integer-gap positioning (1000, 2000, 3000...) — rebalanced automatically" 的排序方案（拖拽改 position 时不用重排全表）；WAL 模式说明 |
| eyalzh | WIP limit 概念（可选，暂不做） |
| kanzo | "Human" 标记（AI 不要碰的工单）；token 预算意识——把工具描述压到最小 |

**注**：本仓库已经按此结论落地实现（`src/mcp.js` 的无状态每请求新建、`src/routes/pages.js` 的 Accept 协商、`src/db.js` 的 better-sqlite3 + user_version 迁移），本报告是对该决策的事后论证与来源留档。

---

## 2. DeepSeek Harness 的 MCP 接入机制

### 2.1 结论（一句话）

**改 `cordis.patch.yml` 不需要重启 DSH。** DSH 的 HMR 插件监听 profile 的 patch 文件，变更后走统一重载队列做 profile recomposition，MCP 客户端插件原地重载并重连，工具立即出现/消失。**已实测验证**（2.4 节）。

### 2.2 机制链条（带文件与行号）

证据来源：DSH 安装包内的 `app.asar`，内含 `dsh/node_modules/@deepseek-ai/*` 各包的 README 与编译产物。

**① 配置写在哪**

- profile patch 文件名常量：`cordis.patch.yml`
  → `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:510`
  ```js
  const PROFILE_PATCH_FILENAME = "cordis.patch.yml";
  ```
- 实际路径：`~/.dsh/profiles/desktop/cordis.patch.yml`（Desktop profile 下，可含多条 MCP server 配置）
- `dsh-app-boot/README.md:62` 说明语义：「**`cordis.patch.yml`** — your tweak layer, applied after every bundle layer … replace one entry's whole config, insert new entries, or interpolate `!!js` expressions at boot.」

**② HMR 是否默认开启**

- `dsh-base` bundle 的 patch 里 HMR 行（`dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:28-33`）：
  ```yaml
  # Profile configuration reloads by default; module roots are opt-in.
  - id: hmr
    name: '@deepseek-ai/dsh-hmr'
    disabled: !!js "!ctx.get('profileContext')"
    config:
      root: []
  ```
  即：**只要 launcher 提供了 `profileContext`，HMR 就启用**；`root: []` 表示只监听配置、不监听源码模块（这正是我们需要的）。
- Desktop 确实提供了 `profileContext`：`dsh/lib/profile-boot-C14i-8IN.js:291-305`
  ```js
  const profileContext = { name: options.profile, dir: composed.profile.dir,
    patchPath: composed.profile.patchPath, home: resolveDshHome(), ... };
  const ctx = await boot(NAME, rootConfig, readProfilePatches(...), async (hostCtx) => {
      hostCtx.provide("profileContext", profileContext);
      ...
  });
  ```
  调用方是 Desktop host：`dsh-desktop-host/lib/index.js:225-240` 调 `runProfile({ profile: "desktop", ... })`。
- 反向确认：headless / acp / sdk 三个 bundle 都把 hmr 显式关掉（`dsh-headless/cordis.patch.yml:33`、`dsh-acp-app/cordis.patch.yml:23`、`dsh-sdk-app/cordis.patch.yml:24` 全是 `disabled: true`）。所以**"改配置要重启"这条经验只对 headless 成立，对 Desktop 不成立**——这大概是传闻的来源。

**③ HMR 到底监听哪些文件**

- `dsh/node_modules/@deepseek-ai/dsh-hmr/lib/index.js:851`：
  ```js
  const patchFiles = [profile.patchPath, join(profile.home, PROFILE_PATCH_FILENAME)];
  ```
  即监听**两个** patch 文件：profile 级（`~/.dsh/profiles/desktop/cordis.patch.yml`）和 home 级（`~/.dsh/cordis.patch.yml`）。
- `:873-874` 注册监听：
  ```js
  for (const filename of patchFiles) await this.watchConfig(filename, () => refresh(false));
  await this.watchConfig(manifestPath, () => refresh(true));
  ```
- `:866-868` 重载后记录结果：
  ```js
  const { warnings, pending, restartReason } = await this.reconcileProfile();
  if (restartReason !== void 0) this.ctx.logger.warn("restart required: %s", restartReason);
  if (pending.length > 0) this.ctx.logger.warn("changed modules keep running their previous code until a restart: %o", pending);
  ```
  注意：这两条是 **warn 而非阻塞**，且只在特定条件触发（模块文件比对失败 / 包目录被移动）。**新增一个 MCP server 行不触发其中任何一条**。

**④ 重载的粒度**

- `dsh-hmr/README.md:13`：「Module replacements, Include refreshes and **profile configuration changes share one queue**.」
- `dsh-hmr/README.md:60`：「`watchConfig()` registers an awaited configuration handler and watches only its target path and required parent directories … `runExclusive()` serializes configuration changes and Loader updates with automatic reloads.」
- `dsh-hmr/README.md:50`：「Profile recompositions run by HMR's profile watches and by Plugin Manager also replace plugins whose loaded files below the profile directory changed on disk … therefore takes effect **without a restart** at the next such recomposition.」
- `dsh-app-boot/README.md:64`：「The enabled `dsh-hmr` plugin watches the profile manifest and both user patch files, re-reads the ordered bundle layers … **The launcher does not install HMR or watchers; disabled or absent HMR means changes require restart.**」

**⑤ MCP 客户端插件本身的重连语义**

- `dsh-mcp-client/README.md:94`（关键一句）：
  > 「**Editing the configuration entry reloads the server connection in place, and unchanged names stay unchanged.**」
  同段还说明：连接断掉后自动重连，500ms 起翻倍到 30s，10 次连续失败才摘掉工具；「After ten consecutive failed attempts the server's tools are removed and reconnection stops **until you reload the configuration** or restart the harness」。
- 也就是说：**服务没起也不影响 DSH 启动**（`failOnStartupError` 默认 `false`，见 README:64），服务起来后重连即可。这对我们"先起 DSH、后起 ticket 服务"的开发顺序很友好。
- 建议给 `ticket` 行显式写 `failOnStartupError: false`（「服务没起时不要拦住 DSH 启动，工具稍后自动重连」）。

**⑥ streamable-http 配置字段**（`dsh-mcp-client/README.md:38-52`）

```yaml
- id: mcp-web
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: web
    transport: streamable-http
    url: http://localhost:3000/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `transport` | 必填 | `stdio` 或 `streamable-http` |
| `serverName` | 必填 | `[A-Za-z0-9_-]{1,32}`，决定工具名前缀 `mcp__<serverName>__<tool>` |
| `url` / `headers` | — | streamable-http 专用 |
| `toolCallTimeoutMs` | 60,000 | 每次工具调用超时 |
| `failOnStartupError` | false | 启动连不上是否让插件激活失败 |
| `reconnect.*` | enabled, 500ms→30s, 10 次 | 重连策略 |

工具命名：`mcp__ticket__workspace_list` 这种形式。

**⑦ 客户端 SDK 版本与协议协商**

- DSH 自带 `@modelcontextprotocol/client` **2.2.0**（`dsh/node_modules/@modelcontextprotocol/client/package.json`）。
- `dsh-mcp-client/lib/index.js:597-602` 显式开了自动协商：
  ```js
  const generation = new Client({ name: "dsh-mcp-client", version: "0.0.1" },
    { capabilities: {}, versionNegotiation: { mode: "auto" }, ... });
  ```
- `:47` streamable-http transport 构造：
  ```js
  case "streamable-http": return new StreamableHTTPClientTransport(new URL(config.url),
      { requestInit: { headers: config.headers } });
  ```
- **实测**（见 3.4）：`mode: "auto"` 会先发 `server/discover` 探测，服务端不认（v1 SDK 返回 -32601）就自动回落到 2025 `initialize` 握手。所以**我们用 v1 SDK 写的服务端，v2 客户端能连**，无需担心版本错配。

### 2.3 为什么 magpie 的文档会让人以为"要重启"

Magpie（Go 写的第三方 DSH 辅助工具）**动态写** DSH 的 MCP 配置（`internal/library/dsh.go` 文件头注释详述了格式：DSH 没有 MCP 配置文件，一个 server 就是 `@deepseek-ai/dsh-mcp-client` 的一行，用顶层 `insert:` 加进去）。

但 magpie 里的提示语写的是：
- `internal/agent/dsh.go:2319`：
  ```go
  noticeDsh2 = newNotice("dsh reads its config at start-up — restart open dsh sessions to use this.")
  ```
- 而这条 notice 的**触发条件是**（`internal/agent/dsh.go:117-121`）：
  ```go
  } else if Running(`DeepSeek Harness\.app/`, `(^|/)dsh( |$)`) {
      notes = append(notes, noticeDsh2.String())
  }
  ```
  注意这是一个 `else if` 链：**只有当 profile 目录不存在（即老版 `~/.dsh/config.yaml` 时代）且 DSH 正在运行时才提示**。有 `~/.dsh/profiles/*/cordis.patch.yml` 的现代安装会走 `noticeDsh1`（讲的是"会话模型"而不是"配置重载"）。

**结论：magpie 的这条提示针对的是 DSH 0.1.5 之前的 `config.yaml` 老架构，不适用于当前 profiles + HMR 的架构。** 这条过时提示很可能是"改配置要重启 DSH"这个印象的来源之一。

参考：某同类项目的 `docs/reference.md` 的 DSH 行也只说「`~/.dsh/profiles/*/cordis.patch.yml` … or `~/.dsh/config.yaml` before dsh 0.1.5」，没有说需要重启。

### 2.4 实测证据（最强证据）

| 事实 | 观察结果 |
|---|---|
| DSH 主进程启动时间 | 早于本次调研两天以上（`ps -o lstart`） |
| 调研期间进程是否重启 | 否 |
| `cordis.patch.yml` 中新增的 MCP server 行 | 写入时间远晚于进程启动时间（`stat` mtime 与备份文件名可证） |
| 该行内容 | `serverName: "ticket"` / `transport: "streamable-http"` / `url: "http://127.0.0.1:<port>/mcp"` |
| 新增后能否调用 `mcp__ticket__*` | **能**。`workspace_list` 返回了工作区索引（调研过程中实际调用成功） |

**推理**：DSH 进程自启动后从未重启，而进程启动**之后**新加的 MCP server 行已经生效并可调用 —— 这**直接证伪**了"改 cordis.patch.yml 必须重启 DSH"。

补充旁证：`lsof` 显示该进程持有 `cordis.patch.yml` 的读句柄，说明是运行中读取而非启动时一次性读入内存。

### 2.5 什么情况下**才**需要重启

按 `dsh-hmr/README.md:112`、`dsh-plugin-manager/README.md:74/101`、`dsh-app-boot/README.md:200`，只有这些情况：

1. 用 `link:` 链接了 DSH 自身静态导入的包（如 `dsh-app-boot`、Cordis、Loader）——「their changes stay pending, and Plugin Manager reports `restart-required` … until the process restarts」
2. 包目录被移动（`restartReason: 'package-moved'`）
3. HMR 被显式禁用（headless/acp/sdk profile，或 patch 里写了 `- id: hmr / disabled: true`）
4. 模块文件比对失败（`restartReason: 'module-comparison'`）

**新增/修改一个 MCP server 行不属于以上任何一种。**

---

## 3. Node 里 streamable-http MCP 服务端的标准做法

### 3.1 版本选择：v1 还是 v2？

**当前生态处于 v1→v2 迁移期**（重要，选错会踩坑）：

| | v1 | v2 |
|---|---|---|
| 包名 | `@modelcontextprotocol/sdk` | `@modelcontextprotocol/server` + `@modelcontextprotocol/client` |
| 最新版 | **1.32.2**（2026-10-23） | **2.4.0**（2026-10-23） |
| 协议 | 2025-11-25 及更早（`initialize` 握手） | 2026-07-28（`server/discover`，无 `initialize`，无 `Mcp-Session-Id`） |
| 维护承诺 | v2 发布（2026-07-27）后**至少 6 个月**继续修 bug 和安全更新 | 主线 |
| 服务端写法 | `new StreamableHTTPServerTransport()` + `server.connect()` | `createMcpHandler(factory)` + `toNodeHandler()` |

来源：[typescript-sdk main README](https://github.com/modelcontextprotocol/typescript-sdk) 顶部 IMPORTANT 块；npm `@modelcontextprotocol/sdk` dist-tags = 1.32.2；`@modelcontextprotocol/server` = 2.4.0。

**建议：服务端用 v1（`@modelcontextprotocol/sdk@^1.32.2`）**，理由：
1. DSH 客户端已实测能连（见 3.4），v2 客户端自动回落到 legacy era。
2. v1 的 `StreamableHTTPServerTransport` 无状态模式代码量最小、最直观，v2 的 `createMcpHandler` 虽然更简洁但依赖 `@modelcontextprotocol/node` + `@modelcontextprotocol/express` 两个额外包（且 `@modelcontextprotocol/express` 的 peer 是 `@modelcontextprotocol/server ^2.3.0`，不能和 v1 混用）。
3. v1 至少还有 6 个月安全支持，本项目是内网自用工具，迁移成本可控。

> 若未来要迁 v2：v2 的 `createMcpHandler` 每请求跑一次 factory，天然就是无状态，且 `responseMode: 'json'` 可强制非 SSE。见 [v2 serving/http 文档](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.md)。

### 3.2 v1 最小可跑示例（无状态 + express 5）

以下代码**已实测通过**（Node 22.x，`@modelcontextprotocol/sdk@1.32.2` + `express@5` + `zod`），客户端 `listTools` 与 `callTool` 均返回正确结果。

```js
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const makeServer = () => {
  const s = new McpServer({ name: 'ticket', version: '0.1.0' });
  s.registerTool('list_tickets', {
    description: 'List tickets by status',
    inputSchema: { status: z.string().optional() },
  }, async ({ status }) => ({
    content: [{ type: 'text', text: `open tickets (status=${status ?? 'any'})` }],
  }));
  return s;
};

const app = express();
app.use(express.json());            // ← 必须在 /mcp 路由之前

app.post('/mcp', async (req, res) => {
  // 无状态：每个请求一对全新的 server + transport
  const server = makeServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });   // 防泄漏，必须
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);             // 第三个参数传已解析的 body
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: String(e) }, id: null });
    }
  }
});

// 无状态模式下 GET（SSE 通知流）和 DELETE（结束会话）都不支持，必须显式 405
const notAllowed = (req, res) => res.writeHead(405).end(JSON.stringify({
  jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null,
}));
app.get('/mcp', notAllowed);
app.delete('/mcp', notAllowed);

app.listen(3000, '0.0.0.0');
```

**要点逐条**

1. **`sessionIdGenerator: undefined` 就是无状态模式**。官方表述：「On `NodeStreamableHTTPServerTransport`, `sessionIdGenerator` turns sessions on; leaving it `undefined` is stateless mode.」（[v2 sessions 文档](https://ts.sdk.modelcontextprotocol.io/v2/serving/sessions-state-scaling.md)；v1 同理，见 [v1 server.md L36-40](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md)）
2. **每请求新建 server + transport**，不要复用。这是官方 `simpleStatelessStreamableHttp.ts` 示例的做法（[源码](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/examples/server/simpleStatelessStreamableHttp.ts)）。
3. **`res.on('close')` 里 `transport.close()` + `server.close()`** —— 官方示例有这一句，漏了会泄漏。
4. **`handleRequest(req, res, req.body)` 第三参数传已解析 body**，避免 transport 重复读流。
5. **GET/DELETE 显式返回 405**。无状态模式下这两个动词没有意义，官方示例也是这么写的。实测 v1 与 v2 服务端对 GET/DELETE 都返回 405。
6. **`express.json()` 必须挂在 `/mcp` 路由之前**，否则 `req.body` 是 undefined。

**v1 有状态模式**（如果需要会话）：`sessionIdGenerator: () => randomUUID()`，然后用一个 `Map<sessionId, transport>` 保存，`initialize` 请求时新建并存入 `onsessioninitialized`，后续请求按 `Mcp-Session-Id` 头路由，并做空闲超时与并发上限。官方明确警告：「A stateful server keeps one transport per session in memory, so it should close sessions that have been idle for a while and limit how many can be open at once.」（[v1 server.md L47](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md)）

**对本项目的建议：用无状态。** 理由：我们的工具全是无副作用的 CRUD，不需要 server→client 的通知推送、不需要断线续传；无状态省掉 session 生命周期管理、内存泄漏风险和"重启服务后旧 session 全废"的问题。

### 3.3 与 express 5 共存的注意点

实测 `express@5.3.0`，v1 SDK 的 `dependencies` 里也已经是 `express: ^5.2.1`，版本一致。

| 注意点 | 说明 | 来源 |
|---|---|---|
| **通配符必须命名** | `app.get('/*')` 在 express 5 会抛错，要写 `app.get('/*splat')`；要匹配根路径用 `/{*splat}` | [Express 5 迁移指南](https://expressjs.com/en/guide/migrating-5.html) |
| **async handler 的 rejection 会被自动转给错误中间件** | express 5 新行为，不用再手写 `try/catch` + `next(err)`；但**在 `/mcp` 路由里仍建议保留 try/catch**，因为 MCP 需要返回 JSON-RPC 格式的错误而不是 HTML 错误页 | 同上 |
| **`req.param(name)` 已移除** | 用 `req.params` / `req.body` / `req.query` | 同上 |
| **`express.static` 的 dotfiles 默认拒绝** | 要服务 `.well-known` 需显式 `{ dotfiles: 'allow' }` | 同上 |
| **body parser 顺序** | `express.json()` 在 `/mcp` 之前，在 `hostHeaderValidation` 之后（官方 `createMcpExpressApp` 就是这么排的） | [v1 `src/server/express.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/server/express.ts) |
| **DNS rebinding 防护** | 绑 `0.0.0.0` 时官方会 warn：「Server is binding to 0.0.0.0 without DNS rebinding protection」。我们要局域网访问，无法用 `localhostHostValidation`，但**这是内网自用场景，可接受**；若担心，可用 `allowedHosts: ['192.168.x.x']` | 同上 |

**关于 `enableJsonResponse`**：设 `true` 后服务端用单个 JSON body 回复而非 SSE。实测我们不需要——无状态模式下 SSE 只在工具内部发通知时才升级，普通 CRUD 工具走 JSON 即可。**但注意**：`Accept` 头必须包含 `application/json, text/event-stream` 两者（MCP 客户端会自动带），只带 `application/json` 会被拒。

### 3.4 跨版本兼容性实测（v1 服务端 × v2 客户端）

因为 DSH 自带的是 v2 客户端（`@modelcontextprotocol/client@2.2.0`，`versionNegotiation: { mode: 'auto' }`），必须确认它能连我们的 v1 服务端。

**实测结果**：

| 场景 | 结果 |
|---|---|
| v1 客户端 → v1 服务端 | ✅ `listTools` / `callTool` 正常 |
| v2 客户端（`mode:'auto'`）→ v1 服务端 | ✅ `getProtocolEra()` 返回 **`legacy`**，工具正常 |
| v2 客户端（`mode:'auto'`）→ v2 服务端 | ✅ 返回 `modern` |
| v1 客户端 → v2 服务端 | ✅ 正常（v2 服务端默认兼容 2025-era 客户端） |
| 对 v1 服务端发 `server/discover` | 返回 `-32601 Method not found`（HTTP 200），客户端据此回落 |

**结论：v1 服务端 × DSH 的 v2 客户端可行，已实测。** 回落只多一个 round trip，无报错。

---

## 4. Node 里 SQLite 的选型

### 4.1 结论

**用 `better-sqlite3`（^13.0.3）。** 不建议用 `node:sqlite`。

### 4.2 逐条对比

| 维度 | `node:sqlite`（Node 22.22.3 内置） | `better-sqlite3@13.0.3` |
|---|---|---|
| 稳定性 | **Stability 1.1 – Active development**（Node 22 文档）；Node 24 起才是 1.2 Release candidate | 成熟稳定，7,546 star |
| API 名字 | 导出的是 `DatabaseSync`（**`Database` 尚未导出**，实测 `sqlite.Database === undefined`） | `new Database(path)` |
| 实验警告 | 每次启动打 `ExperimentalWarning: SQLite is an experimental feature` | 无 |
| 安装 | 零安装 | 有 **prebuild 二进制**（`prebuilds/darwin-arm64.node` 等 8 个平台），实测 `npm i` 约 1 秒，**无编译** |
| License | Node 自身（MIT） | **MIT** |
| 同步 API | ✅ 全同步 | ✅ 全同步 |
| 事务封装 | ❌ 只能手写 `BEGIN`/`COMMIT`/`ROLLBACK` | ✅ `db.transaction(fn)`，自动嵌套为 SAVEPOINT，异常自动回滚 |
| WAL | ✅ `pragma journal_mode=wal` 可用（实测 `wal`） | ✅ 一行 `db.pragma('journal_mode = WAL')` |
| busy_timeout | ⚠️ Node 22.22.3 **接受 `{timeout}` 选项**（实测通过），但该选项 v24.0.0/v22.16.0 才加入——**意味着 Node 22.22.3 上文档与实现不完全一致，跨版本行为有风险** | ✅ 内置 `db.pragma('busy_timeout = 5000')`，行为稳定 |
| SQLite 版本 | 3.51.3 | 3.53.4（更新） |
| 性能（实测） | 2 万条事务插入 **23ms**；2000 次查询 **33ms** | 2 万条事务插入 **48ms**；2000 次查询 **57ms** |
| 迁移到新 Node | 跟随 Node 版本，可能 breaking | 独立版本，可控 |

**性能实测说明**：`node:sqlite` 在我们的微基准里反而**快约一倍**。但这不构成选它的理由——两者的绝对数字（23ms vs 48ms / 2万条）对工单系统完全无感，而 `node:sqlite` 的**稳定性等级、API 变更风险、跨 Node 版本行为差异**才是真成本。

### 4.3 为什么并发场景下这个选择是安全的

用户担心的场景是「MCP + HTTP 同进程多请求」。事实是：

1. **同进程内 SQLite 不会真并发**。两个库都是**同步 API**，Node 单线程 + 同步调用 = 天然串行，同进程内不存在写冲突。
2. **真正需要担心的是多进程**（比如未来起第二个实例、或用 `--watch` 起了两份）。这时：
   - WAL 模式下读不阻塞写、写不阻塞读，但**同一时刻只允许一个写者**。
   - 实测：进程 A 持 `BEGIN IMMEDIATE` 时，进程 B 插入 → `ERR_SQLITE_ERROR: database is locked`。
   - **对策**：`db.pragma('busy_timeout = 5000')`，让 SQLite 自旋等锁而不是立刻报错。better-sqlite3 上这条是稳定的；`node:sqlite` 上要靠 `{timeout}` 选项，而该选项在 Node 22.22.3 的可用性属于"文档未覆盖但实测可用"的灰色地带。
3. **WAL 是必须的**：官方 better-sqlite3 README L46 明说「it is generally important to set the WAL pragma for performance reasons」。
4. **同步 API 在 HTTP 服务里不会卡死**：SQLite 单次查询微秒级，工单系统 QPS 极低。better-sqlite3 作者的反驳很到位：「`node-sqlite3` uses asynchronous APIs for tasks that are either CPU-bound or serialized. That's not only bad design, but it wastes tons of resources. It also causes mutex thrashing」（README L62）。

### 4.4 落地建议（本仓库已按此实现）

```js
import Database from 'better-sqlite3';
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');     // 并发读写必需
db.pragma('busy_timeout = 5000');    // 多进程/多连接时等锁而非报错
db.pragma('foreign_keys = ON');      // 外键约束（默认 off，容易踩坑）
db.pragma('synchronous = NORMAL');   // WAL 下的推荐值，兼顾安全与性能
```

**不要**引入 `node:sqlite` 作为 fallback——两套 API 名字不同（`DatabaseSync` vs `Database`）、`prepare().run()` 返回结构不同、事务写法不同，做"兼容层"的复杂度远大于收益，而且会掩盖真正的 bug。等 Node 24 普及（`node:sqlite` 升为 1.2 RC）再评估迁移。

---

## 5. 「URL 内容按 Accept 返回纯文本给 AI」的业界约定

### 5.1 三条并行的业界约定

**① 内容协商 `Accept: text/markdown`（Cloudflare 2026 主推）**

- Cloudflare 2026-02-12 发布 [Introducing Markdown for Agents](https://blog.cloudflare.com/markdown-for-agents)（最后更新 2026-07-15），在边缘节点做 HTML→Markdown 实时转换：
  > 「the client needs to add the `Accept` negotiation header with `text/markdown` as one of the options. Cloudflare will detect this, fetch the original HTML version from the origin, and convert it to markdown before serving it to the client.」
- 官方文档：[Markdown for Agents](https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/)（2026-10-09 更新）
- **实测响应头**：
  ```
  $ curl -sI https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/ -H "Accept: text/markdown"
  content-type: text/markdown; charset=utf-8
  vary: accept-encoding, accept          ← 关键：Vary 必须含 accept
  ```
- **要点**：`Vary: Accept` 必须有，否则中间缓存会把 HTML 版本喂给 AI。

**② `.md` 后缀镜像（llms.txt 提案 v2）**

- [llmstxt.org](https://llmstxt.org/)（Jeremy Howard，v1 2024-09-03，v2 2026-08-10 更新）明确提案：
  > 「pages with information that agents might need provide a clean markdown version of those pages at the same URL as the original page, either with `.md` appended (`page.html.md`) or with the extension replaced by `.md` (`page.md`). (URLs without file names should append `index.html.md` or `index.md` instead.)」
  > 「we recommend using standard link relations: `rel="alternate" type="text/markdown"` points to the markdown version of a page, and `rel="describedby"` points to the `llms.txt` file that covers it.」
- 实践验证：Stripe 文档 `https://docs.stripe.com/payments/accept-a-payment.md` → 实测 `200 text/markdown; charset=utf-8`；Cloudflare 文档 `.../index.md` → `text/markdown`。
- 我方也已在用这套：`llms.txt` 实测 `content-type: text/plain; charset=utf-8`。

**③ `/llms.txt` 站点索引**

- 规范：[llms.txt v2](https://llmstxt.org/)，放在站点根或任意路径下，覆盖该路径下所有页面。
- 被 OpenAI / Anthropic / Gemini 的开发者文档采纳，Chrome Lighthouse 的 agentic browsing 检查项里也有它（llmstxt.org v2 原文：「Chrome's Lighthouse audits sites for one as part of its agentic browsing checks」）。

**④ 其他真实存在的"AI 友好"URL 惯例（实测）**

| 惯例 | 例子 | 实测 |
|---|---|---|
| `.json` 后缀 | Hacker News API `https://hacker-news.firebaseio.com/v0/item/1.json` | `200 application/json` |
| `?action=raw` 查询参数 | Wikipedia `.../index.php?title=SQLite&action=raw` | `200 text/x-wiki` |
| `Accept: application/vnd.github.raw` | GitHub Contents API | `200 application/vnd.github.raw` |

### 5.2 对本项目 URL 设计的建议

**三条路都用，优先级从高到低：**

| 手段 | 实现 | 理由 |
|---|---|---|
| **主：`Accept` 内容协商** | `Accept` 里 `text/plain` 出现在 `text/html` 之前（或根本没有 `text/html`）→ 返回纯文本；响应带 `Vary: Accept` | 零额外 URL，AI 用 `fetch` 默认 `Accept: */*` 也能命中；这是 Cloudflare 主推、业界在收敛的方向 |
| **兜底：`?format=text`** | 显式查询参数强制纯文本 | AI 的 HTTP 客户端五花八门，有的会强制发 `Accept: text/html`；也给 `curl` 调试和浏览器手测留口子 |
| **索引：`/` 和 `/{ws}/list`** | `/` 返回工作区索引纯文本（等价于站点级 `llms.txt`）；`/{ws}/list` 返回该工作区的工单列表 | 对标 `llms.txt` 的"先给索引、再给详情"模式，AI 不用猜 URL |

**具体 URL 形状**（与本仓库 `docs/CONTRACT.md` 第 4 节一致）：

```
GET /                                     → 工作区索引（纯文本 / HTML 双形态）
GET /{ws}/list?status=open                → 该工作区工单列表
GET /{ws}/ticket/{seq}                    → 单张工单 + 评论
GET /{ws}/list?status=open&format=text    → 强制纯文本
```

**必须遵守的三条硬规则：**

1. **`Vary: Accept` 一定要设**（本仓库 `src/routes/pages.js:32/39` 已设）。否则任何中间缓存（公司代理、CDN、甚至浏览器）都可能把 HTML 版喂给 AI。
2. **纯文本视图必须是"为 token 优化过的"，不是 HTML 去标签**。参考 kanzo 的自我约束（「Agents' replies 10-60 tokens of plain text」）和 rgracey 的 `omit_descriptions` 参数。列表视图默认不输出正文，只给 `ref / 状态 / 标题 / 优先级`。
3. **错误也要按 Accept 分流**。AI 读不了 HTML 错误页——本仓库 `src/routes/pages.js:108` 的注释就是这个意思：「纯文本请求要拿到 text/plain 的说明（AI 读不了 HTML 错误页）」。

**一个反例供参考**：Reddit 的 `.json` 后缀现在返回 `403 text/html`（实测），说明"后缀约定"在反爬策略下会失效。这也侧面说明**内容协商 + 显式 `?format=` 双保险**比单靠后缀更可靠。

---

## 6. 参考链接汇总

**开源项目**
- https://github.com/rgracey/kanban-mcp — Go，2 star，无 License，2026-02-24
- https://github.com/eyalzh/kanban-mcp — TS，41 star，MIT，2025-07-13
- https://github.com/0xdzik/kanban-mcp — Next.js，4 star，无 License，2026-02-26
- https://github.com/TheBengineer/KanbanMCP — Python，1 star，无 License，2026-08-06
- https://github.com/emanuele-em/kanzo — Rust，988 star，**AGPL-3.0**，2026-11-02
- https://github.com/tcarac/taskboard — Go，39 star，MIT，2026-02-16
- https://github.com/ustoppble/overclick — TS，119 star，MIT，2026-11-04（PostgreSQL）
- https://github.com/sirsjg/flux — TS，108 star，MIT，2026-10-21（JSON 文件非 SQLite）
- https://github.com/markrai/scrumboy — Go，448 star，AGPL-3.0，2026-11-01

**MCP 规范与 SDK**
- https://modelcontextprotocol.io/specification/2026-07-28 — 当前协议版本
- https://github.com/modelcontextprotocol/typescript-sdk — 主仓（v2 在 main，v1 在 `v1.x` 分支）
- https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md — v1 服务端文档（stateless vs stateful 在 L36-47）
- https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/examples/server/simpleStatelessStreamableHttp.ts — 官方无状态示例
- https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/server/express.ts — `createMcpExpressApp` 源码
- https://ts.sdk.modelcontextprotocol.io/v2/serving/http.md — v2 HTTP 服务端指南
- https://ts.sdk.modelcontextprotocol.io/v2/serving/express.md — v2 Express 配方
- https://ts.sdk.modelcontextprotocol.io/v2/serving/sessions-state-scaling.md — v2 会话/无状态说明
- https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.md — legacy vs modern era
- https://www.npmjs.com/package/@modelcontextprotocol/sdk — v1.32.2（2026-10-23）
- https://www.npmjs.com/package/@modelcontextprotocol/server — v2.4.0（2026-10-23）

**SQLite**
- https://nodejs.org/api/sqlite.html — `node:sqlite`，Node 22 为 Stability 1.1，Node 24 为 1.2 RC
- https://nodejs.org/docs/latest-v22.x/api/sqlite.html — Node 22 分支文档
- https://nodejs.org/docs/latest-v24.x/api/sqlite.html — Node 24 分支文档（v24.15.0 起升 RC）
- https://github.com/WiseLibs/better-sqlite3 — 7,546 star，MIT，2026-08-10
- https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md — WAL 与性能
- https://www.npmjs.com/package/better-sqlite3 — v13.0.3（2026-08-05）

**AI 友好的纯文本约定**
- https://blog.cloudflare.com/markdown-for-agents — Cloudflare，2026-02-12 发布 / 2026-07-15 更新
- https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/ — 官方文档，2026-10-09 更新
- https://llmstxt.org/ — llms.txt 提案 v2，2026-08-10 更新
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Content_negotiation — HTTP 内容协商
- https://expressjs.com/en/guide/migrating-5.html — Express 5 迁移指南

**文件证据**
- `~/.dsh/profiles/desktop/cordis.patch.yml`（其中含 `ticket` 的 MCP server 行）
- `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 内：
  - `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:510` — `PROFILE_PATCH_FILENAME`
  - `dsh/node_modules/@deepseek-ai/dsh-app-boot/README.md:62/64` — patch 层语义、HMR 监听
  - `dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:28-33` — HMR 默认启用条件
  - `dsh/node_modules/@deepseek-ai/dsh-hmr/lib/index.js:851/866-868/873-874` — 监听两个 patch 文件
  - `dsh/node_modules/@deepseek-ai/dsh-hmr/README.md:13/28/50/60/112` — 重载队列与重启条件
  - `dsh/node_modules/@deepseek-ai/dsh-mcp-client/README.md:38-52/64/76/94` — 配置字段与"原地重载"
  - `dsh/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js:47/597-602` — transport 构造与 v2 客户端 auto 协商
  - `dsh/node_modules/@deepseek-ai/dsh-plugin-manager/README.md:74/101` — `restart-required` 语义
  - `dsh/node_modules/@modelcontextprotocol/client/package.json` — v2.2.0
- Magpie `internal/agent/dsh.go` — `noticeDsh2` 及其触发条件（仅老 `config.yaml` 架构）
- Magpie `internal/library/dsh.go` — DSH MCP 写入格式说明
- Magpie `docs/reference.md` — DSH 配置文件位置（含 "before dsh 0.1.5" 注记）

---

## 附录：本报告中的实测清单

| 实测项 | 方法 | 结果 |
|---|---|---|
| `node:sqlite` 可用性与导出 | `node -e "require('node:sqlite')"` | `['DatabaseSync','StatementSync','constants','backup']`，`Database` 为 undefined |
| `node:sqlite` WAL | `pragma journal_mode=wal` | `wal` ✅ |
| `node:sqlite` 多进程写锁 | 两连接，A 持 `BEGIN IMMEDIATE`，B 插入 | `ERR_SQLITE_ERROR: database is locked` |
| `node:sqlite` `{timeout}` 选项 | `new DatabaseSync(path,{timeout:3000})` | Node 22.22.3 接受 ✅（但文档未覆盖） |
| better-sqlite3 安装 | `npm i better-sqlite3` | 963ms，用 prebuild，无编译 |
| better-sqlite3 WAL + 版本 | `pragma journal_mode` / `sqlite_version()` | `wal` / 3.53.4 |
| 性能对比（2 万条事务插入 / 2000 次查询） | 同机脚本 | node:sqlite 23ms/33ms；better-sqlite3 48ms/57ms |
| v1 服务端 + v1 客户端 | `listTools` + `callTool` | ✅ |
| v1 服务端 + v2 客户端（`mode:auto`） | 同上 + `getProtocolEra()` | ✅ era = `legacy` |
| v2 服务端 + v2 客户端 | 同上 | ✅ era = `modern` |
| v2 服务端 + v1 客户端 | 同上 | ✅ |
| `server/discover` 打 v1 服务端 | curl POST | `-32601 Method not found`，HTTP 200 |
| GET/DELETE 打无状态 `/mcp` | curl | 均为 405 |
| Cloudflare `Accept: text/markdown` | curl -I | `content-type: text/markdown`，`vary: accept-encoding, accept` |
| Stripe 文档 `.md` 后缀 | curl -I | `200 text/markdown` |
| llms.txt content-type | curl -I | `text/plain; charset=utf-8` |
| Reddit `.json` 后缀 | curl -I | `403 text/html`（反例） |
| DSH 进程启动时间 | `ps -o lstart` | 早于配置写入时间两天以上 |
| ticket MCP 配置写入时间 | `stat` + 备份文件名 | 晚于进程启动 |
| `mcp__ticket__*` 当前可用性 | 实际调用 `workspace_list` | ✅ 返回工作区索引 |
