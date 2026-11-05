# ai-mcp-ticket 接口契约（v1，冻结）

后端 / 前端 / 测试三方唯一对齐依据。变更顺序：先改本文件 → 再同步实现与测试。

---

## 0. 项目坐标

| 项 | 值 |
|---|---|
| 模块制式 | ESM，`"type":"module"`；源码 `src/`，前端 `web/`（无构建，原生 HTML/CSS/JS） |
| 运行环境 | Node.js 22，数据库用 `better-sqlite3` |
| 监听 | `0.0.0.0:47321`（`PORT` 可覆盖） |
| 数据库 | `data/ticket.db`（SQLite，WAL；`DB_PATH` 可覆盖） |
| 启动 | `npm start` → `node src/server.js`；`npm test` → `node --test tests/` |
| MCP 端点 | `POST/GET/DELETE /mcp`（streamable-http，无状态，`enableJsonResponse:true`） |
| 健康检查 | `GET /healthz` → `{"ok":true,"version":"...","db":"...","uptime":n}` |

---

## 1. 领域模型

### 1.1 角色（两种）

```
role = 'user' | 'ai'
```

- `user`：用户本人。固定 `actor id="user"`，`model=null`。
- `ai`：任何 AI，**必须自我声明 `id` 与 `model`**（`id` 自选标识如 `deepseek`，`model` 当前模型如 `deepseek-v4.1`）。换模型用新 `model` 写，历史评论保留当时 model，不改写。

每条写入（工单、评论）记录 `actor_id + role + model + created_at`，这四项是**审计事实，创建后不可改**（工单 content / 评论 body 可改，`updated_at` 随之变）。

### 1.2 工作区（只读镜像）

本项目不增删改工作区，只从 DeepSeek Harness 同步：

- 数据源：`$DSH_HOME/storages/workspace.json`，取 `tables.workspaces` 每条的 `path` / `title`
- 同步时机：启动时一次 + 每 60 秒一次 + `POST /api/workspaces/sync` 手动触发
- DSH 已删的工作区：本项目标记 `archived=1`（不删，可能已有工单挂靠）

`workspace_id` 用 DSH 的 workspace UUID；同时提供 `slug`（由 path 的 basename 生成，冲突追加短哈希）用于友好 URL。

### 1.3 工单

```
ticket:
  id            uuid v4（内部主键）
  ref           "{workspace_slug}#{seq}"，例 "demo-project#12"
  workspace_id  所属工作区
  seq           工作区内自增序号（1,2,3...，不回收）
  content       内容（Markdown），必填，1..100000 字
  status        open | in_progress | reopened | done | cancelled   默认 open
  priority      0=low 1=normal 2=high 3=urgent                        默认 1
  position      float，同 status 内排序（拖拽用，越小越靠前）
  blocked_by    text，逗号分隔的 ref 列表（空表示无依赖）
  actor_id      创建者
  actor_role    user | ai
  model         创建者模型（user 为 null）
  assignee_id    认领者 id（未被认领为 null）
  assignee_role  认领者角色 user | ai（未被认领为 null）
  assignee_model 认领者模型（user 为 null）
  claimed_at     认领时间 ISO8601 UTC（未被认领为 null）
  created_at    ISO8601 UTC
  updated_at    ISO8601 UTC
```

**认领（锁定）**：`assignee_id` 非空即"已被认领"，表示某个会话正在改这张工单，别人不要动。
四个字段一起写、一起清；`claimed_at` 超过 6 小时（`CLAIM_STALE_MS`）视为过期，允许他人接管。
状态改成 `done` / `cancelled` 时自动清空这四项。规则细节见 3.2。

**只有 content 一个内容字段（用户 ai-mcp-ticket#5）**：工单不再区分「标题」与「正文」，
`title` / `body` 两个概念一律废除。卡片上显示的第一行只是 content 的预览，不是独立字段。

迁移（`SCHEMA_VERSION` 升到 **3**）：`tickets` 表加 `content` 列，存量按
`content = title + (body 非空 ? "\n\n" + body : "")` 回填，随后 `title` / `body` 两列彻底从表里移除
（`title` 是 `NOT NULL`，留着就必须每次写入编造一个值，那是假兼容）。

做法是 SQLite 官方的表重建流程，全程一个事务：建新表（含 `content`）→
`INSERT INTO 新表 SELECT ... title || ... AS content FROM 旧表` → 删旧表 → 改名 → 重建索引。
事务内先记 `SELECT COUNT(*)`，重建后再比一次，**行数不等就抛错回滚**。
禁止的是「DROP 之后靠空表/默认值重建」，那会丢用户工单；这里的数据是逐行复制过去的。

**写入前长度校验**：`content` 1..100000 字，空 → 400 `CONTENT_REQUIRED`，超长 → 400 `CONTENT_TOO_LONG`；
评论 `body` 1..10000 字，空 → 400 `BODY_REQUIRED`，超长 → 400 `BODY_TOO_LONG`。

**`blocked_by` 校验**：每个 ref 须形如 `{slug}#{seq}` 且**真实存在**，否则 400 `BLOCKED_BY_INVALID`；允许空字符串表示无依赖。

**`updated_at` 严格单调递增**（进程内单调时钟：本次 `Date.now()` 不大于上次则 +1ms）。AI 靠它判断有无新动静，同毫秒不变会漏读。

状态中文名：`open=打开`、`in_progress=处理中`、`reopened=重新打开`、`done=已完成`、`cancelled=已取消`。

### 1.4 评论

```
comment:
  id            uuid v4
  ticket_id     所属工单
  body          正文，必填，1..10000 字
  actor_id      谁说的
  actor_role    user | ai
  model         AI 模型名（user 为 null）
  created_at    ISO8601 UTC
  updated_at    ISO8601 UTC
```

评论按 `created_at` 升序（同毫秒按自增 `rowid`）。

### 1.6 认领（claim / 锁定）—— 用户 ai-mcp-ticket#2

**为什么需要**：多个 AI 会话可能同时看到同一张工单并同时动手改，互相覆盖。
认领就是「这张单我先占了，别人别动」。

用户原话：「我意识到可能有多个会话在同时修改相关的任务，那么我们这个工单就必须要有一个锁定或者指派的概念。
然后被指派后……目的是让别的会话在修改过程中发现这个工单已经被别人、被某个人或者某个会话认领了，那么他就暂时不要去动。」

#### 数据模型（tickets 表加 4 列）

```
assignee_id     TEXT    认领者 id（空 = 未认领）
assignee_role   TEXT    user | ai
assignee_model  TEXT    AI 的模型名（user 为 null）
claimed_at      TEXT    ISO8601 UTC
```

`SCHEMA_VERSION` 升到 **2**。迁移必须用 `ALTER TABLE ADD COLUMN` 增量加列，
**不许 DROP 重建** —— 用户库里已有真实工单，丢了不可恢复（这是本项目曾踩过的坑）。

#### 规则

1. **认领**：`POST /api/tickets/:id/claim`（带身份）。成功后四列全填。
2. **抢占**：已被别人认领时再认领 → **409 `TICKET_CLAIMED`**，错误信息里带上
   「被谁认领（id + role + model）、什么时候」。
3. **幂等**：同一 actor 重复认领 → 200，只刷新 `claimed_at`。
4. **释放**：`POST /api/tickets/:id/release`。只有认领者本人能释放；别人释放 → 409 `TICKET_CLAIMED`。
5. **超时**：认领超过 **6 小时**（`CLAIM_STALE_MS`）自动失效。惰性判定——读的时候发现超期就当未认领，不需要定时任务。
6. **写操作保护**：已认领且调用者不是认领者时，`PATCH` / `comment_add` → **409 `TICKET_CLAIMED`**。
   **例外：`role=user` 永远可以覆盖** —— 用户是老板，不能被 AI 锁死。
7. **删除工单**不受认领限制（用户的清理动作不能被卡）。

#### 纯文本视图（关键）

已认领的工单，在列表和单条视图里都多一行：

```
    claimed_by: ai:deepseek-v4.1 at 2026-11-04T09:00:00.000Z
```

**理由**：AI 读列表时就该看到「这张被别人占了，别动」，而不是等动手时被 409 拒。
这是本项目「给 AI 纯文本」的核心价值 —— 把冲突信息前置到读的时候。

#### MCP 工具（当前 12 个，见第 5 节完整表）

| 工具 | 入参 | 作用 |
|---|---|---|
| `ticket_claim` | `ref, actor_id, actor_model` | 认领；已被别人认领时返回 409 的文本说明 |
| `ticket_release` | `ref, actor_id, actor_model` | 释放（仅认领者） |
| `ticket_list` | 同前 | 返回里已认领的工单带 `claimed_by:` 行 |

---

## 2. 身份传递（每个写请求都要）

优先级从高到低：

1. HTTP 头：`X-Actor-Id`、`X-Actor-Role`、`X-Actor-Model`
2. JSON body 的 `actor: { id, role, model }`
3. Query：`actor_id`、`actor_role`、`actor_model`

规则：

- `role` 缺省为 `user`；`role=ai` 时 **`id` 与 `model` 必填**，缺任一个返回 `400 {"error":{"code":"ACTOR_REQUIRED","message":"..."}}`
- `role=user` 时强制 `id="user"`、`model=null`（忽略传入值）
- 首次出现的 actor 自动登记到 `actors` 表（`id, role, model, first_seen_at, last_seen_at`）

---

## 3. REST API

统一前缀 `/api`。响应 JSON，时间一律 ISO8601 UTC。错误统一 `{"error":{"code":"...","message":"..."}}`，状态码语义正常（400/404/409/500）。

### 3.1 工作区

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/workspaces` | 列工作区（`?include_archived=1` 含归档） |
| POST | `/api/workspaces/sync` | 立刻重同步，返回 `{synced, added, updated, archived}` |

返回项：`{ id, slug, title, path, archived, ticket_counts:{open,in_progress,reopened,done,cancelled,total}, synced_at }`

### 3.2 工单

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/workspaces/:ws/tickets` | 列表（`ws` 可为 id 或 slug；查询参数见下） |
| POST | `/api/workspaces/:ws/tickets` | 新建。body: `{content, status?, priority?, blocked_by?}` |
| GET | `/api/tickets/:id` | 单条（含 `comments`） |
| PATCH | `/api/tickets/:id` | 局部更新。body 可含 `content, status, priority, blocked_by, position` |
| POST | `/api/tickets/:id/claim` | 认领工单，返回工单 JSON（含认领四字段） |
| POST | `/api/tickets/:id/release` | 释放认领，返回工单 JSON |
| DELETE | `/api/tickets/:id` | 删除（级联删评论），返回 `{deleted:true}` |

列表查询参数：`status`（可重复/逗号）、`priority`、`q`（content 模糊）、`sort`（`position`(默认)|`created_at`|`updated_at`|`priority`）、`order`（`asc`|`desc`）、`limit`（默认 200，上限 1000）、`offset`、`with_comments=1`（附带 `comments`，供卡片显示最后一条评论）。

列表返回：`{ workspace:{...}, tickets:[...], counts:{...} }`；`counts` 必须含五状态 + `total`，且为**该工作区全量计数**（不受筛选影响）。

`status` 变化时后端自动把 `position` 放到目标列末尾（除非显式传 `position`）。

#### 3.2.1 认领 / 释放（防多会话同时改同一张工单）

身份按第 2 节解析（复用同一套 `actorOf`）。`claimed_at` 超过 6 小时（`CLAIM_STALE_MS`，可调常量）算过期。

`POST /api/tickets/:id/claim`：

| 当前状态 | 结果 |
|---|---|
| 未被认领 | 认领成功：写入认领者 id/role/model 与 `claimed_at`，刷新 `updated_at`，200 |
| 已被同一 actor 认领（id+role 相同） | 幂等成功，`claimed_at` 续期到当前时间 |
| 已被他人认领且未过期 | **409 `TICKET_CLAIMED`**，message 带当前认领者 id/role/model 与 `claimed_at` |
| 已被他人认领但已过期 | 允许接管：覆盖为本 actor，响应体多带 `took_over: true` |

`POST /api/tickets/:id/release`：

| 当前状态 | 结果 |
|---|---|
| 未被认领 | 幂等成功，200 |
| 认领者本人（id+role 相同） | 释放，四个字段置 NULL |
| 调用者 `role=user` | 可释放任何人的认领 |
| 其它 AI 且未过期 | **409 `TICKET_CLAIMED`** |
| 其它 AI 且已过期 | 视为接管释放（四个字段置 NULL） |

自动释放：`PATCH /api/tickets/:id` 把 `status` 改成 `done` / `cancelled` 时，同一次 UPDATE 里把认领四字段置 NULL。

### 3.3 评论

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tickets/:id/comments` | 列评论（升序） |
| POST | `/api/tickets/:id/comments` | 新增。body: `{body, status?}` |
| PATCH | `/api/comments/:id` | 改正文。body: `{body}` |
| DELETE | `/api/comments/:id` | 删除 |

`status` 可选：带上就在同一个事务里改状态，规则见 5.5.3。AI 在 `open` 工单上不带 `status` 会被
**400 `TICKET_NOT_STARTED`** 拒绝（见 5.5.2）。

评论写入后**同时刷新所属工单的 `updated_at`**。

### 3.4 角色

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/actors` | 列已登记角色（含 `ticket_count`/`comment_count`） |
| POST | `/api/actors` | 显式登记 AI 身份。body: `{id, role, model}` |

### 3.5 图片上传

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/uploads` | 上传图片。body 为原始二进制（`Content-Type: image/png\|jpeg\|gif\|webp`，**不要 multipart**），返回 `{url, name, size, mime}` |
| GET | `/uploads/:name` | 读取图片（`express.static` 指向 `data/uploads`） |

规则：

- 只接受 `image/png|jpeg|gif|webp`，其它 400 `UNSUPPORTED_TYPE`；单张上限 10MB，超了 413
- 文件名服务端生成：`{yyyyMMdd}-{8位随机}.{ext}`，**不接受客户端文件名**（防路径穿越）
- 落盘 `data/uploads/`（`UPLOAD_DIR` 可覆盖），目录自动创建
- 返回的 `url` 可直接放进 Markdown，如 `/uploads/20261104-a1b2c3d4.png`；评论/正文里的图片以 `![](http://localhost:47321/uploads/xxx.png)`存

---

## 4. 纯文本视图（给 AI 读，省 token）

同一批 URL 按 `Accept` / 后缀 / `format` 决定返回 HTML 还是 text/plain。

判定顺序（命中即返回纯文本）：

1. 路径以 `.txt` 结尾（如 `/demo-project/list.txt`）
2. `?format=text` 或 `?format=txt`
3. 请求头 `Accept` 中 `text/plain` 排在 `text/html` 之前

纯文本响应头：`Content-Type: text/plain; charset=utf-8` + `Vary: Accept`；HTML：`Content-Type: text/html; charset=utf-8`。

### 4.1 文本 URL 一览

| 路径 | 纯文本内容 |
|---|---|
| `/` | 工作区索引（含各状态工单数） |
| `/{ws}/list` | 工单列表，`?status=open,in_progress` 过滤；默认含评论 |
| `/{ws}/t/{seq}` 或 `/{ws}/t/{seq}.txt` | 单张工单全文（含全部评论） |
| `/api/workspaces/:ws/text?status=...` | 同上列表纯文本（给 MCP / 脚本，保证返回 text） |

### 4.2 列表纯文本格式（前端/测试按此断言）

```
# ai-mcp-ticket  workspace: demo-project  path: /path/to/your/workspace/demo-project
# filter: status=open,in_progress  count: 3  generated: 2026-11-04T03:21:00.000Z
# 提示: 读 /{ws}/list?status=... 拿最新；写评论用 POST /api/tickets/{id}/comments，需带 X-Actor-Id/X-Actor-Role/X-Actor-Model

[1] demo-project#12  打开  优先级:高  更新:2026-11-04T03:20:00.000Z
    by: ai:deepseek (deepseek-v4.1) at 2026-11-04T03:00:00.000Z
    blocked_by: demo-project#11
    assignee: ai:deepseek (deepseek-v4.1) since 2026-11-04T03:05:00.000Z
    content: 修复回测空指针
      复现步骤 1) ... 2) ...
    comments(2):
      - 2026-11-04T03:10:00.000Z ai:deepseek (deepseek-v4.1): 已定位到 xxx
      - 2026-11-04T03:15:00.000Z user: 再加一条要求 yyy

[2] demo-project#13  处理中  优先级:普通  更新:...
    content: ...
```

约定：

- 序号 `[n]` 为本次列表展示序号（1 起），真实引用是 `{slug}#{seq}`
- 空字段不输出那一行；**未被认领时连 `assignee` 行都不出现**（省 token）
- 已被认领时在 `blocked_by` 行之后加一行 `assignee: <actorLabel> since <claimed_at>`，`user` 认领写 `assignee: user since <claimed_at>`
- `content` 超 `maxlen`（默认 800，`?maxlen=` 可调，0 不截断）截断加 `…(截断)`
- `?comments=0` 隐藏评论（默认全显）；`?comments=5` 只显最后 5 条并注 `(共 N 条，仅显示最后 5 条)`
- 有漏网工单时，末尾多出 1~2 行 `# 待办:`（按原因分档，见 5.5.4）
- 末尾固定：`# end. 用 ?status= 过滤，?format=text 强制纯文本`

### 4.3 单张工单纯文本格式

```
# ai-mcp-ticket ticket: demo-project#12
status: 打开 (open)   priority: 高 (2)   position: 1024
workspace: demo-project  path: /path/to/your/workspace/demo-project
created: 2026-11-04T03:00:00.000Z by ai:deepseek (deepseek-v4.1)
updated: 2026-11-04T03:20:00.000Z
blocked_by: demo-project#11
assignee: ai:deepseek (deepseek-v4.1) since 2026-11-04T03:05:00.000Z
id: 6f1c...

## 内容
修复回测空指针
复现步骤 ...

## 评论 (2)
- [2026-11-04T03:10:00.000Z] ai:deepseek (deepseek-v4.1)
  已定位到 xxx
- [2026-11-04T03:15:00.000Z] user
  再加一条要求 yyy
```

---

## 5. MCP 工具（12 个；serverName = `ticket`，DSH 中显示 `mcp__ticket__*`）

所有工具**返回纯文本**（`content:[{type:'text', text}]`），不返回 JSON。写操作成功后回显结果。

| 工具名 | 入参 | 作用 |
|---|---|---|
| `workspace_list` | `include_archived?:boolean` | 工作区列表（含各状态计数） |
| `ticket_list` | `workspace, status?, q?, maxlen?, comments?` | 工单列表纯文本（同 4.2） |
| `ticket_get` | `ref`（`{slug}#{seq}` 或 uuid） | 单张工单纯文本（同 4.3） |
| `ticket_create` | `workspace, content, status?, priority?, blocked_by?, actor_id, actor_model` | 新建，返回新工单纯文本 |
| `ticket_update` | `ref, content?, status?, priority?, blocked_by?, position?, actor_id, actor_model` | 更新，返回更新后纯文本 |
| `ticket_claim` | `ref, actor_id, actor_model` | 认领（锁定）工单，返回工单纯文本；已被他人认领时返回提示 |
| `ticket_release` | `ref, actor_id, actor_model` | 释放自己对该工单的认领，返回工单纯文本 |
| `ticket_delete` | `ref, actor_id, actor_model` | 删除，返回 `deleted: ref` |
| `comment_list` | `ref` | 评论纯文本 |
| `comment_add` | `ref, body, status?, actor_id, actor_model` | 加评论（可同一次提交改状态），返回该工单最新纯文本 |
| `comment_update` | `comment_id, body, actor_id, actor_model` | 改评论 |
| `comment_delete` | `comment_id, actor_id, actor_model` | 删评论 |

MCP 侧写操作 `role=ai`，`actor_id`/`actor_model` 必填（schema 设 required，描述只说明「由调用方自报写入者标识与模型名」，不给具体名字或模型名当范例——那会被别的 AI 当成"我是谁"的答案）。

传输：`POST /mcp`，`StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`，每请求新建 server+transport（无状态）。`GET /mcp` 与 `DELETE /mcp` 返回 405 JSON。

### 5.5 状态流转约束

#### 5.5.1 合法迁移表（硬约束）

```
open        → in_progress | cancelled | open(幂等)
in_progress → done | reopened | cancelled | open | in_progress(幂等)
reopened    → in_progress | cancelled | reopened(幂等)
done        → reopened | done(幂等)
cancelled   → reopened | cancelled(幂等)
```

- 非法迁移返回 **400 `TRANSITION_INVALID`**，文案须给出「从 X 只能去 A/B/C」
- 允许同状态迁移（幂等），否则拖拽回原位报错
- `reopened` 用于救回 `done`/`cancelled`，故不开放 `done → open` 跳步
- 删除不受状态限制

#### 5.5.2 状态硬门：AI 不许在「打开」的工单上写评论

**为什么是硬门而不是提醒**：软提醒只在返回文本末尾追加一行，改不改由 AI 自己决定，不改没有任何后果 ——
实测结果是 36 张工单里 0 张被认领、状态变更全部靠事后批量补，唯一还 open 的单里 AI 评论明明写着「做完了」。
所以这里改成**直接拒绝**：AI 必须当场表态。

规则（只对 `role=ai` 生效，`role=user` 行为完全不变）：

| 工单当前状态 | 调用者 | 本次评论带 `status` | 结果 |
|---|---|---|---|
| `open` | `ai` | 不带 / 带 `open` | **400 `TICKET_NOT_STARTED`**，评论不落库，状态不动 |
| `open` | `ai` | 带 `in_progress` 等能离开 open 的状态 | 201，评论与状态一次提交 |
| 非 `open` | `ai` | 不带 | 201，只写评论 |
| 任意 | `user` | 任意 | 201，完全不受限 |

错误文案必须一次给出两条可行路径：① 先 `PATCH status=in_progress` 再写评论；② 本次评论直接带 `status=in_progress`。
两条都写清，AI 才不会卡在这里反复重试。

**唯一实现**：硬门写在 `src/repo/comments.js` 的 `create()` 里。REST `POST /api/tickets/:id/comments`
与 MCP `comment_add` 最终都调它，所以只有一份规则，不存在两边行为漂移。

#### 5.5.3 评论与状态原子提交

`POST /api/tickets/:id/comments` 与 MCP `comment_add` 都接受可选 `status`：

```
POST /api/tickets/:id/comments
{ "body": "做完了", "status": "done" }     // status 可选，省略就只写评论
```

- 评论 INSERT 与状态 UPDATE 在**同一个事务**里：状态非法（`TRANSITION_INVALID` / `STATUS_INVALID`）
  就整条回滚，评论也不落库 —— 不允许出现「评论写成功、状态没跟上」的半截状态
- 状态迁移照样走 5.5.1 的迁移表，不另造一套规则
- 改成 `done` / `cancelled` 时，同一次 UPDATE 里把认领四列置 NULL（沿用 3.2.1 的自动释放）
- **这是「已完成」的唯一可靠通道**：AI 显式写 `status=done` 才 done，不做词表猜测

#### 5.5.4 读侧漏网标记（只标记，不改数据）

列表纯文本（4.2）里，三种漏网都要标出来。**按原因分档，一个档一行**，都放在 `# end.` 之前：

| 档位 | 触发条件 | 追加行 |
|---|---|---|
| done | `in_progress` / `reopened` 且**最后一条 AI 评论**命中完工词 | `# 待办: <refs> 可能漏了 status=done（评论像是完工报告，状态还没改成已完成）。确认做完就调 ticket_update status=done（若是 reopened 的单，先改 in_progress 再改 done）` |
| in_progress | `open` 且**有任何** AI 评论 | `# 待办: <refs> 漏了 status=in_progress（AI 已经在上面写过评论，状态还停在打开）。开始处理了就调 ticket_update status=in_progress` |

```
# 待办: demo-project#12 demo-project#15 可能漏了 status=done（…）
# 待办: demo-project#18 漏了 status=in_progress（…）
```

**为什么 open 档单独一档**：用户最初抱怨的正是这一类 ——「你说做好了，但没看到你做成功啊，
16 个还是打开状态」。AI 明明在 open 单上留了评论（干过活了），状态却还停在打开。
它也是 `in_progress → open`（契约 5.5.1 允许）被合法挪回去之后的形态，光看状态字段看不出问题。

**为什么两档不混排**：混在一行里就说不清哪张该补 done、哪张该补 in_progress，而「补错状态」比「不提醒」更糟。

其它规则：

- 完工词表（中文）：`已完成 / 搞定了 / 已修复 / 已解决 / 修好了`，且必须出现在**句首、行首**，
  或作为完工标题（`## 完成情况` / `## 做完的动作` / `## 验收结果`）
- **不含裸英文 `done` / `fixed` / `resolved`**：在这个项目里它们几乎总是在讨论状态值本身
  （`done → reopened`、`status=done`、`done=circle-check`）或 CSS 的 `position: fixed`，不是完工声明。
  拿真实库 41 条 AI 评论量过：带裸英文词命中 14 条，其中 6 条是这种元文本（**误报 43%**）；
  只留中文词并要求出现在句首/行首后命中 7 条，全部是真完工报告。宁可少报（漏了下轮读列表还能看见），
  不可乱报 —— 乱报的提醒会和被废掉的 `statusHint` 一样被无视
- **只用于标记，绝不触发状态变更**：词表猜错会改坏数据，漏判只是少提醒一次，下一轮读列表还能看见
- 只看最后一条 **AI** 评论，不看最后一条评论：用户事后追一句「收到」不该把 AI 的完工报告盖掉；
  AI 说完「已修复」又补一句「又发现边界问题」时，确实不该再催它收尾
- `done` / `cancelled` 单一律不标（状态已经到位）
- 某档没有命中时，那一行不输出（不浪费 token）

#### 5.5.5 工具描述要求

`comment_add` 的 description 必须写明：工单还是「打开」时 AI 必须先表态（先 `ticket_update status=in_progress`，
或本次评论直接带 `status=in_progress`）；干完了就在写评论时带 `status=done`。
`ticket_update` 的 description 必须写明「处理完务必把 status 推进到 in_progress / done；状态不是装饰，用户靠它看看板」。

#### 5.5.6 锁定提醒（与状态规则无关，独立一条）

写操作（`ticket_create` / `ticket_update` / `comment_add` 等）的纯文本返回里，若工单被**他人**认领且未过期，
在 `# end.` 之前追加一行（`claimLockHint`）：

```
# 锁定提醒: 该工单已被 ai:other (model) 于 <claimed_at> 认领，请勿修改或评论
```

自己认领的、以及 `role=user` 的调用都不提醒（用户是老板，不受锁约束）。读操作不追加。

---

## 6. 前端需求

前端功能与交互需求见 [`docs/功能清单.md`](./功能清单.md)，不在本接口契约内。

---

## 7. 目录结构

```
ai-mcp-ticket/
  package.json
  docs/CONTRACT.md        # 本文件
  docs/research.md        # 调研员写
  src/server.js           # 入口（express + 静态 + 路由 + MCP 挂载）
  src/db.js               # better-sqlite3 连接、建表、迁移
  src/repo/*.js           # workspaces / tickets / comments / actors 数据访问
  src/render/text.js      # 纯文本渲染（第 4 节唯一实现）
  src/routes/api.js       # REST
  src/routes/pages.js     # HTML + 纯文本页面路由 + 内容协商
  src/mcp.js              # MCP server 与工具
  src/workspace-sync.js   # DSH workspace.json 只读同步
  web/                    # index.html / app.js / style.css
  tests/*.test.js         # node --test
  scripts/                # 启停脚本
  data/ticket.db          # 运行时生成，不提交
```

---

## 8. 验收口径（接口级）

1. `npm start` 起得来，`GET /healthz` 200
2. `GET /` 浏览器是 HTML，`curl -H 'Accept: text/plain' /` 是纯文本
3. 工作区列表与 `~/.dsh/storages/workspace.json` 的 workspace 一一对应
4. 建工单 → user 加评论 → AI 身份加评论（带 model）→ 改状态 → 改 position 生效 → 删除，全程无 500
5. `curl -H 'Accept: text/plain' '/{ws}/list?status=open'` 输出符合 4.2 格式
6. MCP `initialize` / `tools/list` / `tools/call ticket_list` 全通
7. `npm test` 全绿

前端功能验收见 [`docs/功能清单.md`](./功能清单.md)。
