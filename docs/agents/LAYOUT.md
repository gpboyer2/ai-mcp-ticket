# 目录地图与文件规范

> 本文件是「文件和目录放哪里」的唯一权威清单，由根目录 [`AGENTS.md`](../../AGENTS.md) 引用。
> 冲突时以本文件为准：`AGENTS.md` 只留引用，不再重复登记。

这个仓库有多个会话、多个 AI 同时在改。历史上每个 AI 都按自己的习惯造一套目录（`static/` / `public/` / `frontend/` …），导致资源散落、同一种东西好几个地方都有。下面这套规则就是为了把这件事锁死。

要求：

1. 只用第一节目录树里登记过的目录。 树里没有的目录，未经过用户明确要求的一律不许新建。
2. 判定看用途，不看名字。 不要问"我叫这个名字算不算违规"，要问"这个用途树里有没有登记位置"。有，就必须用那一个；换个名字另造一份，同样是违规。
3. 根目录是锁死的。 根级只允许 `AGENTS.md` `README.md` `LICENSE` `package.json` `package-lock.json` `.gitignore`，不许往根上扔任何报告、脚本、截图、日志。
4. 确实找不到合适的位置才允许新建，而且必须同一次改动里先把新条目写进第一节的目录树（写清用途和约束），再创建目录。
5. 提交前必跑 `npm test` 与 `npm run smoke`，两个都全绿才算过。布局本身目前靠这条规则和 review 核对，没有脚本自动兜。

`目录地图` 就是那份唯一的权威清单。

---

## 一、目录地图

规则：已登记目录内部可以正常新增文件（比如 `tests/` 里多一份用例、`src/repo/` 里多一个模块），但文件名必须过下面「文件命名」那几条。

下面这些同类型行为一律禁止：

| 想干的事 | 树里已登记的位置 | 不许出现的写法（举例，不限于此） |
| --- | --- | --- |
| 截图、图片目录 | `docs/screenshots/` | `screenshot/` `shots/` `captures/` `snapshots/` `pics/` `photo/` `img/` `png/` `docs/images/` `docs/assets/` `docs/figures/` |
| 放数据层代码 | `src/repo/` | `src/models/` `src/dao/` `src/db/` `src/store/` |
| 放 HTTP 路由 | `src/routes/` | `src/api/` `src/controllers/` `src/handlers/` `src/endpoints/` |
| 放纯文本渲染 | `src/render/` | `src/text/` `src/formatter/` `src/format/` `src/plain/` |
| 放前端脚本 | `web/` | `static/` `public/` `frontend/` `client/` `assets/` `js/` `css/` |
| 放自动化测试 | `tests/` | `test/` `__tests__/` `spec/` `e2e/` |
| 放可重复跑的工具脚本 | `scripts/` | `tools/` `bin/` `util/` `helpers/` |
| 放一次性试验脚本 | 不许留在仓库；要留就进 `scripts/` 并写清用途 | `tmp/` `scratch/` `temp/` `playground/` `demo/` `sandbox/` `experiments/` |
| 写项目级文档 | `docs/` | 根级 `REPORT.md` `SUMMARY.md` `NOTES.md` `TODO.md` `验收.md`；`doc/` `documents/` |
| 放运行期数据 | `data/`（整个目录 gitignore） | 根级 `db/` `database/` `storage/` `uploads/` |
| 备份 / 旧版本 | 不许备份，用 git 历史 | `bak/` `backup/` `old/` `legacy/` `archive/` `*-copy` `*-old` `v2/` `new/` |

三秒判定法：先问"这个东西属于哪个已登记用途"，找到就用那一个位置；一个都找不到，才允许新建，而且必须先写进下面的目录树、再创建目录。

```
ai-mcp-ticket/
├── AGENTS.md                    协作铁律（唯一入口）。目录与文件规范见 docs/agents/LAYOUT.md
├── README.md                    项目总览、架构、启动步骤、MCP 接入
├── LICENSE                      MIT
├── package.json                 根脚本：start / dev / test / smoke
├── package-lock.json            依赖版本锁定，npm 自动维护，不手改
├── .gitignore                   依赖 / 运行期数据 / 上传 / 日志 / 备份 全在这里挡
│
├── src/                         后端。ESM，按职责分层，不放前端代码
│   ├── server.js                进程入口：读 PORT，起 HTTP，注册三套接口
│   ├── app.js                   Express 装配：路由挂载 / 内容协商 / 错误处理
│   ├── db.js                    唯一数据库连接：读 DB_PATH，建表，开 WAL
│   ├── actor.js                 身份解析：X-Actor-Id / X-Actor-Role / X-Actor-Model
│   ├── mcp.js                   MCP 服务：12 个工具，走 /mcp
│   ├── views.js                 HTML 视图
│   ├── workspace-sync.js        从 DeepSeek Harness 只读同步工作区，读 DSH_HOME
│   ├── repo/                    数据层，只操作本文件登记的表
│   │   ├── tickets.js
│   │   ├── comments.js
│   │   ├── actors.js
│   │   └── workspaces.js
│   ├── routes/                  HTTP 路由，只做入参校验 + 调 repo
│   │   ├── api.js               JSON 写接口
│   │   ├── pages.js             网页 + 纯文本视图
│   │   └── uploads.js           附件上传，落 UPLOAD_DIR
│   └── render/
│       └── text.js              纯文本渲染。给 AI 读，改这里要算 token 成本
│
├── web/                         前端。原生 HTML/CSS/JS，无框架、无打包、无构建步骤
│   ├── index.html               唯一页面入口
│   ├── app.js                   启动与路由
│   ├── board.js                 看板拖拽
│   ├── detail.js                工单详情
│   ├── editor.js                新建 / 编辑工单
│   ├── common.js                共享工具：请求、格式化、身份
│   ├── sidebar.js               工作区侧栏
│   ├── deps-picker.js           依赖选择器
│   ├── images.js                附件预览
│   ├── icons.js                 内联图标
│   ├── style.css                组件样式
│   └── layout.css               布局样式
│
├── tests/                       node:test 用例，一个文件对一个模块
│
├── scripts/                     可重复跑的工具脚本，不放业务代码
│   ├── smoke.js                 端到端冒烟
│   ├── demo-data.mjs            造演示数据
│   ├── install-dsh-mcp.mjs      把 MCP 接进 DeepSeek Harness
│   └── ticket.sh                命令行读写工单
│
├── docs/                        项目级文档
│   ├── agents/                  给 AI 会话看的规则子文档
│   │   └── LAYOUT.md            本文件：目录地图 + 文件命名 + 新建目录的硬流程（唯一权威）
│   ├── screenshots/             截图、图片目录
│   ├── CONTRACT.md              接口契约（v1，冻结）：领域模型 / 接口形状 / 口径
│   └── research.md              调研笔记
│
└── data/                        运行期数据，整目录 gitignore，不许入库
    ├── ticket.db                SQLite 主库（含 -wal / -shm）
    └── uploads/                 附件
```

### 根目录只许有这几个文件

根目录是"目录名混乱"和"临时文件"的重灾区，所以单独锁死。根级只允许：

`AGENTS.md` `README.md` `LICENSE` `package.json` `package-lock.json` `.gitignore`

### 文件命名也别乱来

1. 文件名用英文小写 + 连字符或下划线，不用中文、不用空格、不用拼音、不用 `新建文档` `未命名` 这类名字。
2. 同一个东西尽量别出现"第二版文件名"：`AGENTS-v2.md` `README-new.md` `xxx-final.md` `xxx-最终版.md` `xxx-副本.md` ，要改最好直接改原文件（git 有历史）。
3. 文档正文放 `docs/`，不许散落在根目录和代码目录里。
4. 临时文件不许落在仓库任何位置；`data/` 里的东西不入库，也别把 `data/` 里的文件路径写进文档或代码。
5. 图片只许放在 `docs/screenshots/` 一处，放在别处一律算违规。

### 新建目录 / 新建文件的硬流程

1. 先查上面的「想干的事 → 已登记位置」表。能对上，就用已登记的位置，不许新建。
2. 对不上，才允许新建；必须同一次改动里先把新条目写进本文件第一节的目录树（写清用途和约束），再创建。
3. 新建目录时里面暂时没文件，必须放一个 `.gitkeep`，否则 git 不跟踪这个目录，用户 clone 下来就没了。
4. 目录名用英文小写 + 连字符，不用中文、不用空格、不用拼音、不用缩写。
5. 一个用途只有一个目录。发现同义目录并存：保留本节登记的那个，另一个清空后删掉，两个都留着算违规。
6. 不许删除或改名本节点里的已登记目录；要动结构，先改本文件，再动磁盘。

### 可选自检

```bash
npm test          # node:test 用例
npm run smoke     # 端到端冒烟
```
