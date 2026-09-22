# zcode-session-migration

把 [ZCode](https://github.com/) CLI（opencode 系的本地 Agent 工具）的历史会话迁移成
[DeepSeek Harness](https://github.com/)（DSH）原生会话日志，让它们出现在 DSH 左侧工作区的
分组里，并保留完整对话——用户消息、助手正文、**推理过程**、**工具调用与执行结果**。

这是一个 **DSH Agent Skill**：克隆到 DSH 的技能目录即可，Agent 会在你提到相关需求时自动加载。

## 安装

```bash
git clone https://github.com/AmazingBoyCrazy/zcode-session-migration.git \
  ~/.dsh/skills/zcode-session-migration
```

Windows PowerShell：

```powershell
git clone https://github.com/AmazingBoyCrazy/zcode-session-migration.git `
  "$env:USERPROFILE\.dsh\skills\zcode-session-migration"
```

装完新开一个 DSH 会话即可生效。也可以用 `install.ps1` / `install.sh` 一键安装。

## 要求

- **Node ≥ 22.15**（需要 `node:sqlite` 与 `node:zlib` 的 Zstandard API；Node 24 实测可用）
- 本机已安装 DSH，且 DSH 的包能从 `<DSH_HOME>/profiles` 解析到（脚本自己找，无需配置路径）
- 迁移前后需要**完全停止 DSH** 才能让分组与标题生效

## 快速开始

```powershell
# skillDir = 本仓库位置
$S = "<skillDir>\scripts"

# 1) 先盘点，不写任何东西
node "$S\migrate.mjs" --dry-run

# 2) 停止 DSH 后写入
node "$S\migrate.mjs" --allow-real --manifest zcode-migration-manifest.json

# 3) 让 DSH 重建工作区分组（幂等）
node "$S\register-workspaces.mjs"

# 4) 启动 DSH，然后实时校验
node "$S\check-live.mjs" --url "http://127.0.0.1:<port>/?token=<启动横幅里的 token>"
```

日常增量再同步（DSH 停止时）：

```powershell
node "$S\sync.mjs" --allow-real     # = migrate + register-workspaces
```

## 它解决的具体问题

这几个坑是 DSH 里没有文档、只能从源码和实测中确认的：

| 问题 | 结论 |
|---|---|
| 会话写进去了但侧边栏看不到 | header 的 `cwd` **必填**，`session.list` 会丢弃 `cwd === undefined` 的会话 |
| 会话在但标题是目录名 | 冷会话标题**只从投影缓存读**；必须预置 `session_projcache` 文档，且 identity 要带 `formatVersion` |
| 会话只在「未分组」里 | 分组由 `workspace.json` 决定；DSH 按 `cwd` 派生工作区**只在 `initialized === false` 时执行一次** |
| 会话数量少了很多 | ZCode 的 `fork` 会话也带 `parent_id`，但它是用户可见的独立会话，按 `parent_id IS NULL` 过滤会把它们全丢掉 |
| DSH 启动失败 `file is not valid JSON` | PowerShell 写 JSON 会加 UTF-8 BOM，`workspace` 域是 `single` 布局——一个坏字节就毁掉整个工作区列表 |
| 导入后发消息报"上下文过长" | 迁移的是源工具的**原始全量日志**，而它实际发给模型的是**压缩后的视图**；DSH 自带的压缩也无法救场（它的摘要请求会原样回放被遮蔽区域），需要复用源工具已有的摘要 |

完整说明见 [references/pitfalls.md](references/pitfalls.md) 与
[references/session-format.md](references/session-format.md)。

## 上下文过长怎么办

源工具（ZCode）会自动压缩长会话，所以它真正发给模型的只有「摘要 + 一小段尾部」。迁移复制的是
原始全量日志，于是 DSH 第一次请求就被提供方拒绝：

```
This model's maximum context length is 1048576 tokens.
However, you requested 2040304 tokens (1784304 in the messages, 256000 in the completion).
```

`compact-inplace.mjs`（推荐）复用源工具**已经生成好的摘要**（不发起任何模型调用），在它自己的压缩边界
插入一组 DSH 原生压缩事件，**原地改写原来的会话**——id 与标题都不变，没有新会话，也不需要重建分组。
要求日志结尾正好位于两个 turn 之间，并且每个被改写的会话都会留 `<file>.bak-<时间戳>`：

```powershell
node "$S\compact-inplace.mjs" --manifest zcode-migration-manifest.json --dry-run
# DSH 完全停止后：
node "$S\compact-inplace.mjs" --manifest zcode-migration-manifest.json --allow-real `
     --manifest-out "$env:TEMP\zcode-inplace.json"
```

`compact.mjs` 是另一种选择：写入一个**新会话**（标题带 `· 压缩续接`），原始会话原样保留，适合想同时留着
全量历史的场景；代价是多一个会话，且需要再跑一次 `register-workspaces.mjs`。

被遮蔽的事件留在日志里可追溯，模型 surface 变成「摘要 + 尾部」。实测一个 10,643 事件 / 180 万 token 的
会话，压缩后模型 surface 只剩摘要，同一会话成功跑完一轮对话。

## 迁移后继续对话：请先读这段

导入的历史**全程发生在源工具里**。它记着的那些调用——`Bash` / `Read` / `Write` 之类——是那个工具的名字，
写在那里的工作目录是那时的路径，记下的审批与权限也是那时的策略。**这些都不描述 DSH 当前环境。**

所以在这类会话里继续干活时：

- 工具名可能对不上：以前叫 `Bash` 的，在 DSH 里可能叫别的名字，或者根本不存在——先看当前可用工具
- 权限与审批策略可能不同：历史里"用户同意了"不构成现在的授权，该问的还是要问
- 工作目录可能变了：历史里的相对路径未必指向同一个地方，动手前用当前环境核实
- 历史里的失败与报错可能只是那套权限的产物，不代表在 DSH 里也会失败（反之亦然）

为此，压缩时会自动在摘要前面加一段说明（`--note <text>` 可自定义，`--no-note` 可关闭），让模型一进来
就知道这段背景来自另一个工具。如果你手动续接一个**没有**经过压缩的迁移会话，建议在第一条消息里说明一句。

## 安全性

- **纯增量**：只新建会话目录与投影缓存文档，不读取、不改写、不删除任何既有 DSH 文件
- **写前校验**：每条会话在落盘前用 DSH 自带的编解码器生成，并通过最严格的回放校验
  （`Session.fromRestore`）
- **创建独占**：目标已存在就报错，绝不覆盖
- **默认拒绝写真实 home**：不加 `--allow-real` 只能写到一次性目录
- **一键回滚**：`rollback.mjs` 只删 manifest 记录的那批路径，目录内容与预期不符就拒绝删除
- **注册表改写有备份**：`register-workspaces.mjs` 自动备份并提供 `--restore`

## 目录

```
SKILL.md                        DSH 技能主文件（Agent 读这个）
references/
  session-format.md             DSH v3 会话格式与物理编码约定
  verification.md               三层校验协议
  pitfalls.md                   已踩过的坑与根因
scripts/
  migrate.mjs                   迁移入口
  compact-inplace.mjs           复用源工具摘要，原地压缩原会话（推荐）
  compact.mjs                   复用源工具摘要，另生成一个续接会话
  sync.mjs                      增量再同步
  register-workspaces.mjs       重建工作区分组
  verify.mjs                    离线复核
  check-live.mjs                对运行中的 DSH 实时校验
  rollback.mjs                  精确回滚
  lib/paths.mjs                 从环境解析 DSH home 与包位置
  lib/dsh-format.mjs            调用 DSH 编解码器 / zstd 帧 / 严格校验
  lib/zcode.mjs                 ZCode SQLite 只读访问
  lib/convert.mjs               事件映射
  lib/cache-seed.mjs            投影缓存文档生成
```

所有路径都从环境解析（`DSH_HOME`、`~/.dsh`、`~/.zcode/cli/db/db.sqlite`），
脚本内**没有硬编码的机器路径**。

## 已验证范围

- ZCode 会话库 schema：`session` / `message` / `part`（本工具只读）
- DSH 会话格式：v3
- 实测规模：45 个会话（31 主会话 + 14 fork）、约 18k 消息、63k part，全部通过严格回放校验，
  并在真实 DSH 实例中确认分组、标题与历史分页均正常

## License

未附带许可证文件。如需开源授权请自行添加（例如 MIT）。
