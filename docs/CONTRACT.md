# ai-mcp-ticket 接口契约（v1，冻结）

本文件是后端 / 前端 / 测试三方的唯一对齐依据。**改动前请先确认契约**；
确需变更时，先改本文件，再同步实现与测试。

---

## 0. 项目坐标

| 项 | 值 |
|---|---|
| 目录 | `<your-project-dir>` |
| 运行环境 | Node.js 22（`node:sqlite` 可用，但本项目统一用 `better-sqlite3`） |
| 模块制式 | ESM（`"type": "module"`），源码在 `src/`，前端在 `web/`（无构建步骤，原生 HTML/CSS/JS） |
| 监听 | `0.0.0.0:47321`（`PORT` 环境变量可覆盖；局域网可访问） |
| 数据库 | `data/ticket.db`（SQLite，WAL 模式；`DB_PATH` 环境变量可覆盖） |
| 启动 | `npm start` → `node src/server.js`；`npm test` → `node --test tests/` |
| MCP 端点 | `POST/GET/DELETE /mcp`（streamable-http，无状态，`enableJsonResponse: true`） |
| 健康检查 | `GET /healthz` → `{"ok":true,"version":"...","db":"...","uptime":n}` |

---

## 1. 领域模型

### 1.1 角色（只有两种）

```
role = 'user' | 'ai'
```

- `user`：用户本人。固定 `actor id = "user"`，`model = NULL`。
- `ai`：任何 AI。**必须自我声明 `id` 与 `model`**：`id` 是 AI 的自选标识（如
  `dsh-lead`、`claude-code`），`model` 是它正在用的模型名（如 `group/cherish-ai`）。
  同一个 AI 换了模型，就用新的 `model` 写，历史评论保留当时的 model，不改写。

每条写入（工单、评论）都要记录「谁说的（actor_id + role）、用什么模型说的（model）、什么时候说的（created_at）」。
这三个字段是**审计事实，创建后不可改**（评论正文可改，但 `updated_at` 会变）。

### 1.2 工作区（只读镜像）

工作区**不在本项目里增删改**，只从 DeepSeek Harness 同步：

- 数据源：`$DSH_HOME/storages/workspace.json`（默认 `~/.dsh/storages/workspace.json`）
- 取其中 `tables.workspaces` 的每条记录的 `path` / `title`
- 同步时机：进程启动时同步一次 + 每 60 秒自动再同步 + `POST /api/workspaces/sync` 手动触发
- 已删除的 DSH 工作区：本项目里标记 `archived=1`（不删，因为可能已有工单挂靠）

`workspace_id` 用 DSH 的 workspace UUID（稳定）；同时提供 `slug`（由 path 的 basename 生成，
冲突时追加短哈希）用于友好 URL。

### 1.3 工单

```
ticket:
  id            uuid v4（内部主键，API 里出现）
  ref           "{workspace_slug}#{seq}"，例 "demo-project#12"（人和 AI 都好引用）
  workspace_id  所属工作区
  seq           工作区内自增序号（1,2,3...，不回收）
  title         标题，必填，1..200 字
  body          正文（Markdown 文本），可空，**上限 100000 字**
  status        open | in_progress | reopened | done | cancelled   默认 open
  priority      0=low 1=normal 2=high 3=urgent                        默认 1
  position      float，同 status 内排序（拖拽用，越小越靠前）
  blocked_by    text，逗号分隔的 ref 列表（依赖；空表示无依赖）
  actor_id      创建者
  actor_role    user | ai
  model         创建者的模型（user 为 null）
  created_at    ISO8601 UTC（如 2026-11-04T03:21:00.000Z）
  updated_at    ISO8601 UTC
```

**长度上限（写入前校验，超了 400）**：`title` ≤ 200 字，`body` ≤ 100000 字（`BODY_TOO_LONG`），
评论 `body` ≤ 10000 字（`BODY_TOO_LONG`）。上限存在的意义是防止 AI 或误操作把整份文件贴进来把库撑爆。

**`blocked_by` 校验**：每个 ref 必须形如 `{slug}#{seq}` 且**在本项目里真实存在**，否则 400 `BLOCKED_BY_INVALID`
（避免 AI 依赖一个不存在的工单而误判"被卡住"）。允许空字符串表示无依赖。

**时间戳单调性**：同一进程内，所有写入生成的 `updated_at` 必须**严格递增**（实现用进程内单调时钟：
若本次 `Date.now()` 不大于上次返回值，就在上次基础上 +1ms）。原因：AI 靠 `updated_at` 判断工单有没有新动静，
同毫秒不变等于告诉 AI「没有新消息」，会导致漏读用户新加的需求。库里已存的历史值不做回填改写。

状态中文名（前端展示用，后端 text 视图用同一套）：
`open=打开`、`in_progress=处理中`、`reopened=重新打开`、`done=已完成`、`cancelled=已取消`。

### 1.4 评论

```
comment:
  id            uuid v4
  ticket_id     所属工单
  body          正文，必填，1..10000 字
  actor_id      谁说的
  actor_role    user | ai
  model         AI 的模型名（user 为 null）
  created_at    ISO8601 UTC
  updated_at    ISO8601 UTC
```

评论按 `created_at` 升序（同毫秒按自增 `rowid`）。

---

## 2. 身份传递（每个写请求都要）

优先级从高到低：

1. HTTP 头：`X-Actor-Id`、`X-Actor-Role`、`X-Actor-Model`
2. JSON body 里的 `actor: { id, role, model }`
3. Query 参数：`actor_id`、`actor_role`、`actor_model`

规则：
- `role` 缺省为 `user`（浏览器默认就是用户本人）；`role=ai` 时 **`id` 与 `model` 都必填**，
  缺任一个返回 `400 {"error":{"code":"ACTOR_REQUIRED","message":"..."}}`
- `role=user` 时强制 `id="user"`、`model=null`（忽略传入值）
- 首次出现的 actor 自动登记到 `actors` 表（`id, role, model, first_seen_at, last_seen_at`）

---

## 3. REST API

统一前缀 `/api`。响应 JSON；时间一律 ISO8601 UTC 字符串。
错误统一：`{"error":{"code":"...","message":"..."}}`，HTTP 状态码语义正常（400/404/409/500）。

### 3.1 工作区

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/workspaces` | 列工作区（`?include_archived=1` 才含归档） |
| POST | `/api/workspaces/sync` | 立刻从 DSH 重同步，返回 `{synced:n, added:n, updated:n, archived:n}` |

返回项：`{ id, slug, title, path, archived, ticket_counts: { open:0, in_progress:0, reopened:0, done:0, cancelled:0, total:0 }, synced_at }`

### 3.2 工单

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/workspaces/:ws/tickets` | 列表。`ws` 可为 workspace `id` 或 `slug`。查询参数见下 |
| POST | `/api/workspaces/:ws/tickets` | 新建。body: `{title, body?, status?, priority?, blocked_by?}` |
| GET | `/api/tickets/:id` | 单条（含 `comments` 数组） |
| PATCH | `/api/tickets/:id` | 局部更新。body 可含 `title, body, status, priority, blocked_by, position` |
| DELETE | `/api/tickets/:id` | 删除（级联删评论），返回 `{deleted:true}` |

列表查询参数：`status`（可重复/逗号分隔）、`priority`、`q`（在 title+body 里模糊匹配）、
`sort`（`position`(默认) | `created_at` | `updated_at` | `priority`）、`order`（`asc`|`desc`）、
`limit`（默认 200，上限 1000）、`offset`、**`with_comments=1`**（每张工单附带 `comments` 数组，
供看板卡片显示最后一条评论；不带时为了省流量不返回评论）。

列表返回：`{ workspace:{...}, tickets:[...], counts:{...} }`
其中 `counts` **必须包含五个状态 + `total`**：`{open, in_progress, reopened, done, cancelled, total}`，
且是**该工作区全量计数**（不受本次筛选影响）。

新建/更新工单时若 `status` 变化，后端自动把 `position` 放到目标状态列末尾（除非显式传了 `position`）。

### 3.3 评论

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tickets/:id/comments` | 列评论（升序） |
| POST | `/api/tickets/:id/comments` | 新增。body: `{body}` |
| PATCH | `/api/comments/:id` | 改正文。body: `{body}` |
| DELETE | `/api/comments/:id` | 删除 |

评论写入后要**同时刷新所属工单的 `updated_at`**（这样 AI 能靠 updated_at 判断"有没有新动静"）。

### 3.4 角色

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/actors` | 列已登记角色（含每条写过的次数 `ticket_count`/`comment_count`） |
| POST | `/api/actors` | 显式登记 AI 身份。body: `{id, role, model}` |

### 3.5 图片上传（网页端可粘贴图片）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/uploads` | 上传一张图片。body 为原始二进制（`Content-Type: image/png|jpeg|gif|webp`），**不要 multipart**，前端直接把 `File` 当 body 发。返回 `{url, name, size, mime}` |
| GET | `/uploads/:name` | 读取图片（`express.static` 指向 `data/uploads`） |

规则：
- 只接受 `image/png`、`image/jpeg`、`image/gif`、`image/webp`，其它 400 `UNSUPPORTED_TYPE`
- 单张上限 10MB，超了 413
- 文件名由服务端生成：`{yyyyMMdd}-{8位随机}.{ext}`，**不接受客户端传的文件名**（防路径穿越）
- 落盘到 `data/uploads/`（`UPLOAD_DIR` 可覆盖），目录自动创建
- 返回的 `url` 是可直接放进 Markdown 的绝对路径，如 `/uploads/20261104-a1b2c3d4.png`
- 评论/正文里的图片以 Markdown `![](/uploads/xxx.png)` 形式存，纯文本视图**原样保留 URL**（AI 需要时自行取）

---

## 4. 纯文本视图（给 AI 读，省 token）

**同一批 URL，按 `Accept` / 后缀 / `format` 参数决定返回 HTML 还是 text/plain。**

判定顺序（命中即返回纯文本）：
1. 路径以 `.txt` 结尾（如 `/demo-project/list.txt`）
2. `?format=text` 或 `?format=txt`
3. 请求头 `Accept` 里 `text/plain` 排在 `text/html` 之前（AI 的 fetch 常带 `Accept: text/plain`）

纯文本响应头：`Content-Type: text/plain; charset=utf-8`，并带 `Vary: Accept`。
HTML 响应头：`Content-Type: text/html; charset=utf-8`。

### 4.1 文本 URL 一览

| 路径 | 纯文本内容 |
|---|---|
| `/` | 工作区索引（含每个工作区的各状态工单数） |
| `/{ws}/list` | 该工作区工单列表，`?status=open,in_progress` 过滤；默认含评论 |
| `/{ws}/t/{seq}` 或 `/{ws}/t/{seq}.txt` | 单张工单全文（含全部评论） |
| `/api/workspaces/:ws/text?status=...` | 同上列表的纯文本版本（给 MCP / 脚本用，保证一定返回 text） |

### 4.2 列表纯文本格式（严格遵守，前端/测试都按此断言）

```
# ai-mcp-ticket  workspace: demo-project  path: /path/to/your/workspace/demo-project
# filter: status=open,in_progress  count: 3  generated: 2026-11-04T03:21:00.000Z
# 提示: 读 /{ws}/list?status=... 拿最新；写评论用 POST /api/tickets/{id}/comments，需带 X-Actor-Id/X-Actor-Role/X-Actor-Model

[1] demo-project#12  打开  优先级:高  更新:2026-11-04T03:20:00.000Z
    title: 修复回测空指针
    by: ai:dsh-lead (group/cherish-ai) at 2026-11-04T03:00:00.000Z
    blocked_by: demo-project#11
    body: 复现步骤 1) ... 2) ...
    comments(2):
      - 2026-11-04T03:10:00.000Z ai:dsh-lead (group/cherish-ai): 已定位到 xxx
      - 2026-11-04T03:15:00.000Z user: 再加一条要求 yyy

[2] demo-project#13  处理中  优先级:普通  更新:...
    title: ...
```

约定细节：
- 序号 `[n]` 是本次列表内的展示序号（1 起），工单真正的引用是 `{slug}#{seq}`
- 空字段不输出那一行（`body:` 为空则不打印）
- 正文超过 `maxlen`（默认 800 字，`?maxlen=` 可调，0 表示不截断）时截断并加 `…(截断)`
- 评论超过 `?comments=0` 时隐藏（默认显示全部）；`?comments=5` 只显示最后 5 条，并注明 `(共 N 条，仅显示最后 5 条)`
- 文件末尾固定输出一行：`# end. 用 ?status= 过滤，?format=text 强制纯文本`

### 4.3 单张工单纯文本格式

```
# ai-mcp-ticket ticket: demo-project#12
status: 打开 (open)   priority: 高 (2)   position: 1024
workspace: demo-project  path: /path/to/your/workspace/demo-project
created: 2026-11-04T03:00:00.000Z by ai:dsh-lead (group/cherish-ai)
updated: 2026-11-04T03:20:00.000Z
blocked_by: demo-project#11
id: 6f1c...

## 正文
复现步骤 ...

## 评论 (2)
- [2026-11-04T03:10:00.000Z] ai:dsh-lead (group/cherish-ai)
  已定位到 xxx
- [2026-11-04T03:15:00.000Z] user
  再加一条要求 yyy
```

---

## 5. MCP 工具（serverName = `ticket`，DSH 里显示为 `mcp__ticket__*`）

所有工具**返回纯文本**（`content: [{type:'text', text}]`），不返回 JSON —— 这是本项目的核心取舍：
AI 拿到的就是第 4 节那套文本，零 token 浪费。写操作成功后在文本里回显结果。

| 工具名 | 入参 | 作用 |
|---|---|---|
| `workspace_list` | `include_archived?:boolean` | 工作区列表（纯文本，含各状态计数） |
| `ticket_list` | `workspace:string, status?:string, q?:string, maxlen?:number, comments?:number` | 工单列表纯文本（同 4.2 格式） |
| `ticket_get` | `ref:string`（`{slug}#{seq}` 或 uuid） | 单张工单纯文本（同 4.3 格式） |
| `ticket_create` | `workspace:string, title:string, body?:string, status?, priority?, blocked_by?, actor_id, actor_model` | 新建，返回新工单纯文本 |
| `ticket_update` | `ref:string, title?, body?, status?, priority?, blocked_by?, position?, actor_id, actor_model` | 更新，返回更新后纯文本 |
| `ticket_delete` | `ref:string, actor_id, actor_model` | 删除，返回 `deleted: ref` |
| `comment_list` | `ref:string` | 评论纯文本 |
| `comment_add` | `ref:string, body:string, actor_id, actor_model` | 加评论，返回该工单最新纯文本 |
| `comment_update` | `comment_id:string, body:string, actor_id, actor_model` | 改评论 |
| `comment_delete` | `comment_id:string, actor_id, actor_model` | 删评论 |

MCP 侧的写操作，actor 固定为 `role=ai`，`actor_id`/`actor_model` 必填（工具 schema 里设为 required，
并在描述里写明"填你自己的身份和模型，例如 dsh-lead / group/cherish-ai"）。

传输：`POST /mcp`，`StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`，
每请求新建 server+transport（无状态）。`GET /mcp` 与 `DELETE /mcp` 返回 405 JSON。

---

## 5.5 状态流转约束与提醒（用户 ai-剧本#45）

用户观察到的真问题：工单建出来永远是「打开」，AI 干完活也不改状态，看板上状态形同虚设。
Jira 一类工具的做法是「工作流 + 迁移校验 + 迁移时强制/提示留痕」，我们取其精髓但保持轻量。

### 5.5.1 合法迁移表（硬约束）

```
open        → in_progress | cancelled | open(幂等)
in_progress → done | reopened | cancelled | open | in_progress(幂等)
reopened    → in_progress | cancelled | reopened(幂等)
done        → reopened | done(幂等)
cancelled   → reopened | cancelled(幂等)
```

- 非法迁移返回 **400 `TRANSITION_INVALID`**，文案必须给出「从 X 只能去 A/B/C」，让 AI 一次就能改对
- 允许同状态迁移（幂等），否则前端拖拽回原位会报错
- **`reopened` 的存在就是为了让 `done`/`cancelled` 能被救回来**，所以不开放 `done → open` 这种跳步
- 删除操作不受状态限制

### 5.5.2 状态提醒（软约束，核心）

AI 不是不听话，是没人提醒它。所以**每个写操作的纯文本返回末尾**，按条件追加一行提醒
（只在需要时出现，不浪费 token；提醒不是错误，操作本身已成功）：

| 触发条件 | 追加的提醒（原文） |
|---|---|
| 工单 `status=open` 且本次是 `comment_add`（AI 身份） | `# 状态提醒: 该工单仍是「打开」。若你已开始处理，请调 ticket_update status=in_progress` |
| 工单 `status=in_progress` 且本次 `comment_add` 正文命中完成词（已完成/搞定了/已修复/已解决/修好了/done/fixed/resolved） | `# 状态提醒: 评论像是完工报告。若确实已完成，请调 ticket_update status=done` |
| 工单 `status=open` 且本次是 `ticket_create`（AI 身份，建完就开始干） | `# 状态提醒: 新建的工单是「打开」。开始处理时请调 ticket_update status=in_progress` |
| 其它情况 | 不追加任何提醒 |

提醒行放在 `# end.` **之前**，用同一个 `# ` 前缀，保持纯文本一致性。

### 5.5.3 工具描述里的显式要求

`comment_add` 与 `ticket_update` 的 MCP 工具 description 必须写明：
「处理完务必把 status 推进到 in_progress / done；状态不是装饰，用户靠它看看板。」

### 5.5.4 前端

- 拖拽换列时若目标状态非法 → 卡片弹回原位 + 顶部 toast 说明原因（不要静默回滚）
- 详情页状态选择器只列出**当前状态可去**的选项（其它置灰或隐藏），从源头避免误操作

---

## 6. 前端页面（单页三栏布局）

**核心原则：全程单页，永不跳转。** 在一个页面内不断点击切换，左中右三栏互相联动：
左边是工作区目录（占宽不多），中栏看板，右栏详情。任何"点进二级页面 / 三级页面"的体验都不采用。

### 6.1 布局：左中右三栏，常驻

```
┌──────────┬─────────────────────────┬──────────────────────┐
│ 左栏      │ 中栏                     │ 右栏                  │
│ 工作区目录 │ 工单看板                  │ 工单详情               │
│ (~200px)  │ (5 列看板，自适应)         │ (~420px，可拖宽/收起)   │
│ 可折叠     │                          │                      │
└──────────┴─────────────────────────┴──────────────────────┘
```

- **左栏**：工作区列表（标题 + 各状态工单数小计）。点击 → 中栏换成该工作区看板，右栏清空。
  窄，可折叠成图标条（记忆在 localStorage）。
- **中栏**：五列看板（打开/处理中/重新打开/已完成/已取消）。拖拽换列/列内排序规则不变。
  顶部：搜索、状态筛选、新建工单。
- **右栏**：点中栏某张卡 → 右栏原地显示该工单详情（正文、评论时间线、评论增删改），
  **中栏看板不消失**。右栏可关闭（回到两栏），可拖拽调宽。
- 三栏联动：左选中工作区 → 中栏列表变；中选中工单 → 右栏详情变。全程无页面跳转、无整页刷新。
- 窄屏（<1100px）：左栏收成抽屉（汉堡按钮唤出），右栏改为浮层覆盖中栏。

### 6.2 URL 仍然保留（但不用于跳转）

| 路径 | 打开时的初始状态 |
|---|---|
| `/` | 只有左栏；中栏提示「从左边选一个工作区」 |
| `/{ws}/list` | 左栏选中该 ws，中栏显示看板 |
| `/{ws}/t/{seq}` | 左栏选中该 ws，中栏显示看板，右栏打开该工单 |

要求：**URL 变化用 `history.pushState`，不用真实跳转**。用户点击切换时地址栏跟着变（可分享、可贴给 AI），
但页面不重新加载。浏览器前进/后退要能用（`popstate` 里还原三栏状态）。

### 6.3 新建/编辑工单表单

- **标题与正文合并为一个输入框**：一个大 textarea，占位提示「第一行是标题，其余是正文；可以随便写」。
  提交时取第一行（去掉行首 `#`、`-`、空白）作 `title`，其余行作 `body`。
  编辑已有工单时，把 `title` 和 `body` 用换行拼回去填进同一个框。
- 输入框**默认高度约 8 行**，且可手动拉高（`resize: vertical`）。
- 该大输入框同样用于「快速新建」：看板顶部一个输入框，回车即建。

### 6.4 依赖（blocked_by）字段

不能是裸 input。要做**可搜索、可选中的下拉**：

- 输入即过滤当前工作区的工单（按 `ref` 与 `title` 模糊匹配），最多显示 20 条
- 每条显示 `{ref}  {title}  状态`
- 键盘可操作：↑↓ 移动、回车选中、Esc 关闭
- 支持选中多个（依赖可以有多条，存成逗号分隔的 ref）
- 已选中的显示成可删除的小标签（chip）

### 6.5 其他要求

- 无构建步骤，原生 HTML/CSS/JS，后端 `express.static` 提供；零 CDN、零外链，断网可用
- 深色/浅色可切换（localStorage 记忆，默认跟随系统），中文界面
- 写操作默认以 `role=user, id=user` 身份发出（头部 `X-Actor-Role: user`）
- "AI 视角"：展示当前状态对应的**纯文本 URL**（一键复制），方便贴给 AI
- 拖拽/增删改后局部刷新，不整页跳转
- 卡片上要能看到最后一条评论摘要 → 列表接口用 `?with_comments=1`（见 3.2 补充）

---

## 7. 目录结构（约定，不要越界改别人的目录）

```
ai-mcp-ticket/
  package.json            # 依赖与脚本
  docs/CONTRACT.md        # 本文件（接口契约）
  docs/research.md        # 调研员写
  src/server.js           # 后端：进程入口（express + 静态 + 路由挂载 + MCP 挂载）
  src/db.js               # 后端：better-sqlite3 连接、建表、迁移
  src/repo/*.js           # 后端：workspaces / tickets / comments / actors 数据访问
  src/render/text.js      # 后端：纯文本渲染（第 4 节格式的唯一实现）
  src/routes/api.js       # 后端：REST
  src/routes/pages.js     # 后端：HTML 页面 + 纯文本页面路由 + 内容协商
  src/mcp.js              # 后端：MCP server 与工具定义
  src/workspace-sync.js   # 后端：DSH workspace.json 只读同步
  web/                    # 前端：index.html / app.js / style.css
  tests/*.test.js         # 测试：node --test
  scripts/                # 启停脚本
  data/ticket.db          # 运行时生成，不提交
```

---

## 8. 验收口径

1. `npm start` 起得来，`GET /healthz` 200
2. `GET /` 浏览器是 HTML，`curl -H 'Accept: text/plain' /` 是纯文本
3. 工作区列表与 `~/.dsh/storages/workspace.json` 里的 5 个 workspace 一一对应
4. 建工单 → 加评论（user）→ 用 AI 身份加评论（带 model）→ 改状态 → 拖拽后 position 变化 → 删除，全程无 500
5. `curl -H 'Accept: text/plain' '/{ws}/list?status=open'` 输出符合 4.2 格式
6. MCP `initialize` / `tools/list` / `tools/call ticket_list` 全部通
7. `npm test` 全绿
8. 网页上能真的拖拽换列、能增删改评论
