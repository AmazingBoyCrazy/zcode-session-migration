---
name: zcode-session-migration
description: 把 ZCode CLI（opencode 系）的本地 SQLite 会话库迁移成 DSH 原生会话日志，使其出现在 DSH 左侧工作区分组中并保留完整历史对话（含推理过程、工具调用与结果）。覆盖 fork 会话识别、冷会话标题投影缓存、工作区注册表重建、迁移前后校验与一键回滚。当用户提到 ZCode 会话导入/搬迁到 DSH、zcode 对话看不到、会话不全、只迁了一部分、fork 没进来，或要求把别的 Agent 工具的历史会话搬到 DSH 时使用。
metadata:
  short-description: ZCode 会话库 → DSH 原生会话日志迁移与分组注册
---

# ZCode → DSH 会话迁移

把 ZCode CLI 的 SQLite 会话库转换成 DSH 的 v3 会话日志，落到 `<DSH_HOME>/sessions`，
并让它们出现在 DSH 左侧工作区的对应分组里，历史对话（用户消息、助手正文、推理过程、
工具调用与结果）完整可读。

## 何时使用

- 用户说"把 zcode 的对话搬到 dsh 里"、"zcode 的会话看不到/不全"。
- 用户反映 DSH 侧边栏里某个项目下少了很多会话（通常是 fork 被漏掉，见下文）。
- 需要把其他 opencode 系工具的历史会话迁进 DSH（SQLite 结构兼容即可）。

## 前置条件

1. **Node ≥ 22.15**（需要 `node:sqlite` 与 `node:zlib` 的 Zstandard API；Node 24 实测可用）。
2. **DSH 完全停止**：`workspace.json` 是 `single` 布局、内存为权威状态，运行中的 Host 会覆盖它。
   写入会话日志本身可以在运行时进行，但分组与标题要等下次启动才生效。
3. **先备份**：迁移是纯增量（只新建文件，不碰任何既有文件），但 `register-workspaces.mjs`
   会改写注册表——它自带 `workspace.json.bak-<时间戳>` 与 `--restore`。
4. 期望的 DSH 包可从 `<DSH_HOME>/profiles/node_modules` 解析到；脚本会自己找，不要写死安装路径。

## 先弄懂这五条不变量（否则必踩坑）

1. **会话格式是带校验和的 Zstandard 拼接帧**，首帧只能有一行 header。逻辑记录必须由 DSH
   自己的编解码器生成——不要手写 JSON，也不要自己拼事件结构。
   细节：[references/session-format.md](references/session-format.md)
2. **header 的 `cwd` 必填**。DSH 的 `session.list` 会直接丢弃 `cwd === undefined` 的会话，
   不写就永远不出现在侧边栏。
3. **冷会话的标题只认投影缓存**。`displayTitleOf()` 的兜底顺序是「缓存标题 → cwd 目录名 →
   会话 id」。从未 live 过的导入会话没有缓存记录，必须由迁移工具预置
   `<DSH_HOME>/storages/session_projcache/sessions/<id>.json`，且 identity 必须带
   `formatVersion`，否则只能当"前代标题提示"，列表不采信。
4. **工作区分组只在 `initialized === false` 时重建**。DSH 按会话 `cwd` 派生工作区，但
   `WorkspaceRegistry.bootstrap()` 只在注册表未初始化时跑一次。已初始化的注册表永远不会
   再派生，新导入的会话会落进浏览器本地的「未分组」。解法是把 `initialized` 置回 `false`，
   让 DSH 下次启动用自己的代码重建（不要自己复刻那段逻辑）。
5. **绝不能用 PowerShell 写 `workspace.json`**。`Set-Content` / `Out-File -Encoding utf8`
   会写入 UTF-8 BOM，而 `workspace` 域是 `single` 布局——整份文档会被判为
   `file is not valid JSON`，DSH 直接启动失败（`plugin tree failed to load`）。
   本 skill 的所有 JSON 写入都走 Node 且显式断言首字节不是 `EF BB BF`。

## 迁移范围：ZCode 的三种 task_type

`session.task_type` 分三类，**只按 `parent_id IS NULL` 过滤会漏掉 fork**：

| task_type | 说明 | 默认 |
|---|---|---|
| `interactive` | 主会话（`parent_id IS NULL`） | 迁移 |
| `fork` | 用户在界面上看到的分叉会话，**自带独立且完整的 message/part 历史**（实测可达单个会话 2000+ 条消息、10000+ 事件） | **迁移**（`--no-forks` 可关） |
| `subagent_child` | 子代理的内部调研轮次，通常很小 | 跳过（`--include-subagents` 可开） |

判断依据：fork 会和父会话**平铺在同一个项目列表里**，用户会认为它属于"我的会话"；
子代理是 agent 的内部行为。迁移前先跑一次计数，把三类数量报给用户确认。

fork 在 DSH 里作为**独立会话**导入（保留 `Fork of ...` 这类标题），不建立 `parentSession`
血缘：DSH 的 fork 语义是 seeded session（`isSeeded` + 继承事件切点），强行套用会触碰播种
不变量。ZCode 侧的父子关系记录在 manifest 的 `zcodeParentId` 字段里备查。

## 标准流程

```powershell
# skillDir = 本 skill 的绝对路径（agent 已知）
$S = "<skillDir>\scripts"

# 1) 先盘点，不要直接写
node "$S\migrate.mjs" --dry-run            # 默认 home = $DSH_HOME 或 ~/.dsh
                                           # 输出 candidates / converted / failed 与分类

# 2) （强烈建议）拿一个一次性 DSH_HOME 彩排：把真实 home 的 sessions/storages 复制过去，
#    用第二个 dsh 实例启动并肉眼确认，再动真实 home。见 references/verification.md

# 3) 停止 DSH，写入真实 home
node "$S\migrate.mjs" --allow-real --manifest zcode-migration-manifest.json

# 4) 重建工作区分组（幂等）
node "$S\register-workspaces.mjs"

# 5) 启动 DSH，然后做实时校验
node "$S\check-live.mjs" --url "http://127.0.0.1:<port>/?token=<启动横幅里的 token>"
```

日常增量再同步（用户持续开新会话时）一条命令：

```powershell
node "$S\sync.mjs" --allow-real     # = migrate + register-workspaces，幂等
```

`sync.mjs` 必须 **DSH 停止时**运行，然后启动 DSH。

### 参数速查

| 参数 | 说明 |
|---|---|
| `--home <dir>` | DSH_HOME，默认 `$DSH_HOME` 或 `~/.dsh` |
| `--db <path>` | ZCode SQLite 路径，默认 `~/.zcode/cli/db/db.sqlite` |
| `--allow-real` | 允许写默认 DSH home（默认拒绝，防止误操作） |
| `--dry-run` | 只转换与校验，不写盘 |
| `--no-forks` / `--include-subagents` | 调整迁移范围 |
| `--no-tool-output` | 不写工具执行结果（体积小，历史不完整） |
| `--only <id,id>` / `--limit N` / `--since <ms\|ISO>` | 筛选 |
| `--manifest <file>` | 清单路径，默认 `zcode-migration-manifest.json`（**回滚依赖它，别删**） |

## 校验

| 层次 | 工具 | 证明什么 |
|---|---|---|
| 字节层 | `verify.mjs` | 帧结构、校验和、首帧单行；DSH 自带编解码器的**严格回放**（`Session.fromRestore`） |
| 投影层 | `verify.mjs` | 预置缓存文档通过 DSH 导出的 `checkpointRecord` / 投影单元 `stateSchema` |
| 运行时层 | `check-live.mjs` | 真的换 cookie 调 `session/list` 与 `session/page`，验证标题、cwd、非空白、历史可分页 |

注意：`verify.mjs` 只要求事件数**不减少**。DSH 一旦打开过某个迁移会话就会继续往同一文件
追加自己的帧（seed 标记、模型选择等），这是格式完全兼容的最强证据，不是错误。

## 回滚

```powershell
node "$S\rollback.mjs" zcode-migration-manifest.json --dry-run   # 先看要删什么
node "$S\rollback.mjs" zcode-migration-manifest.json             # 只删本次迁移创建的文件
node "$S\register-workspaces.mjs" --restore                      # 恢复注册表
```

回滚有硬约束：只删 manifest 记录的路径、必须在派生出的根目录内、目录内容与预期不符就
拒绝删除。删完重启 DSH 即恢复原样，**不会碰到任何既有会话**。

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 会话全部出现但标题是目录名 | 投影缓存没生效（未重启，或 identity 缺 `formatVersion`） | 重启 DSH；用 `verify.mjs` 看 cache rejected |
| 分组里没有新会话，只在「未分组」 | `workspace.json` 已 `initialized: true`，bootstrap 没跑 | DSH 停止时跑 `register-workspaces.mjs` |
| DSH 启动报 `unit 'workspace': file is not valid JSON` | 有人用 PowerShell 写了 `workspace.json`（带 BOM） | `register-workspaces.mjs --restore` |
| 某个会话缺失 | 它是 `fork`（默认已含）或 `subagent_child`（默认跳过） | 按 `task_type` 计数核对，必要时 `--include-subagents` |
| 会话数量对但历史不全 | 用了 `--no-tool-output` | 重跑该会话（先回滚该条或换 manifest） |
| 导入后 DSH 里该会话被继续追加事件 | 正常：DSH 接受并扩展了迁移文件 | 无需处理 |

更多踩坑记录：[references/pitfalls.md](references/pitfalls.md)

## 文件

| 路径 | 作用 |
|---|---|
| `scripts/migrate.mjs` | 迁移入口（转换 + 校验 + 落盘 + manifest） |
| `scripts/sync.mjs` | 增量再同步 = migrate + register-workspaces |
| `scripts/register-workspaces.mjs` | 重建工作区注册表（分组），带备份与 `--restore` |
| `scripts/verify.mjs` | 离线复核：重放 + 投影缓存 schema |
| `scripts/check-live.mjs` | 对运行中的 DSH 做实时校验 |
| `scripts/rollback.mjs` | 按 manifest 精确回滚 |
| `scripts/lib/paths.mjs` | 从环境解析 DSH home 与包位置（无硬编码路径） |
| `scripts/lib/dsh-format.mjs` | 调用 DSH 编解码器、路径编码、zstd 帧、严格校验 |
| `scripts/lib/zcode.mjs` | ZCode SQLite 只读访问与 task_type 分类 |
| `scripts/lib/convert.mjs` | 事件映射规则 |
| `scripts/lib/cache-seed.mjs` | 投影缓存文档生成 |
| `references/session-format.md` | DSH v3 会话格式与物理编码细节 |
| `references/verification.md` | 隔离彩排实例的搭法与实时校验协议 |
| `references/pitfalls.md` | 已踩过的坑与根因 |
