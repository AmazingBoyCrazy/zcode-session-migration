# 已踩过的坑与根因

每条都是实测撞到过的，附带根因，避免重复。

## 1. PowerShell 写 JSON 会加 BOM，DSH 直接启动失败

**现象**

```
unit 'workspace': file is not valid JSON
SyntaxError: Unexpected token '锘?, "锘縶\n  "u"... is not valid JSON
dsh: plugin tree failed to load: ... failed to apply loader entry workspace (@deepseek-ai/dsh-workspace)
```

**根因**：`Set-Content` / `Out-File -Encoding utf8`（Windows PowerShell 5.1）写入 UTF-8 BOM。
`workspace` 域是 `single` 布局——一份文档坏掉，**整个工作区列表全丢**，应用起不来。

**规则**：所有 JSON 落盘只用 Node 的 `fs.writeFileSync(path, text, 'utf8')`；写前断言首字节不是
`EF BB BF`；写后再 `JSON.parse` 一次。本 skill 的 `register-workspaces.mjs` 三步都做了。

## 2. 只按 `parent_id IS NULL` 过滤会漏掉 fork

**现象**：用户说"会话不全"，某项目下 ZCode 有十几个会话，DSH 只有几个。

**根因**：ZCode 的 `session.task_type` 分 `interactive` / `fork` / `subagent_child`。fork 也带
`parent_id`，但它是**用户可见的独立会话**，自带完整 message/part 历史（实测单个 fork 上千条
消息、上万事件），并且会和父会话平铺在同一个项目列表里。用 `parent_id IS NULL` 一刀切会把
它们全部丢掉。

**规则**：fork 默认迁移；只有 `subagent_child` 默认跳过。

## 3. 以为工作区会自动派生

**现象**：会话文件都在，`session/list` 也能查到，但侧边栏里只在「未分组」下，没有命名分组。

**根因**：`WorkspaceRegistry.bootstrap()` 只在 `global.initialized === false` 时执行，它按会话
`cwd` 派生工作区并把会话挂进 `sessionIds`。已初始化的注册表**永远不会再派生**。
"全新 home 启动后自动出现分组"是首次引导，不是每次启动都发生。

**规则**：导入冷会话后必须把 `initialized` 置回 `false`（`register-workspaces.mjs`），
让 DSH 下次启动用自己的 bootstrap 重建，而不是自己复刻那段逻辑。

**另一个推论**：`session/created` 只会把**新建的 live 会话**挂到工作区；冷导入的会话不会触发
任何挂载。

## 4. 冷会话标题退化成目录名

**现象**：分组对了、会话也在，但每一行显示的标题是目录名（例如 `my-repo`、`workspace`）。

**根因**：列表路径读冷会话的投影值**只查投影缓存**，不折叠日志。缓存缺失时
`displayTitleOf()` 回落到 `cwd` 的 basename。

**规则**：迁移时预置 `session_projcache` 文档；`identity.formatVersion` 必须写，否则
`identityMatches` 不认，记录只能当"前代标题提示"。

## 5. `session/title` 的 source 形状不是随便写的

**现象**：格式校验能过，但标题折叠时报错或标题被 LLM 重新生成覆盖。

**根因**：不变量要求 `messageSeqs` 为空 **当且仅当** `source.kind === 'user'`；非 user 的
kind 必须引用一个更早的、来源为 `user` 的 `user/message` 的 seq。

**规则**：导入外部标题用 `{kind:'user'}` + `messageSeqs: []`（这也是"钉住标题"的形态）。

## 6. `assistant/message` 缺 `stream` 会被拒

**现象**：`Error: seed assistant/message at index N has invalid settlement fields`。

**根因**：v2/v3 的 `assistant/message` 载荷成员是 `turn`/`step`/`message`/`stream`，
`stream` 是**必填**（可选的是 `usage`/`interrupted`）。导入时写 `[]` 即可。

## 7. 用错 projection 行的 `ver`

**现象**：缓存文档写入成功，但某个投影 key 的值不生效。

**根因**：每个投影行有 `ver`，必须等于该单元当前的 `stateVersion`；它会随 DSH 升级变化
（例如 `permissions` 已经变过一次）。照抄旧磁盘样本会写出被拒的行。

**规则**：`ver` 从安装的单元定义读取（`titleProjectionDefinition.stateVersion` 等），
不要硬编码。

## 8. `verify` 把"事件数必须相等"当硬条件

**现象**：迁移完一段时间后复核报 `event count changed`。

**根因**：DSH 打开过某个迁移会话后会**继续往同一个文件追加自己的帧**（seed 标记、
模型选择等），文件里有 3 个以上帧、事件数变多是**正常且是好消息**——说明 DSH 的读取器与
写入器都完全接受了这个文件。

**规则**：复核只要求事件数不减少；增长单独记为信息。

## 9. 迁移会话时 DSH 仍在运行

**影响**：

- 会话日志本身可以随时写入（纯新增，新 id 不冲突；每个会话目录有自己的写锁）。
- 但 `workspace.json` 与 `session_projcache` 是**内存为权威**的域，运行中的 Host 不会看到
  磁盘上的新增，甚至可能覆盖你刚写的注册表。

**规则**：`register-workspaces` 与最终生效都需要 **DSH 停止 → 写 → 启动**。
在运行中写入不会损坏任何东西，只是不生效。

## 11. 导入后会话"上下文过长"，DSH 自己的压缩救不了

**现象**

```
This model's maximum context length is 1048576 tokens.
However, you requested 2040304 tokens (1784304 in the messages, 256000 in the completion).
```

**根因**：迁移复制的是源工具的**原始全量日志**。源工具（ZCode）会自动压缩，它实际发给模型的
只有摘要 + 一小段尾部（实测 1~2 万 token），而原始日志有 180 万 token。DSH 拿到全量日志后
第一次请求就被提供方拒绝。

**为什么不能让 DSH 自己压**：`dsh-compaction-basic` 的摘要请求会**逐字回放被遮蔽区域的消息**
（为了让辅助调用成为会话的真正前缀、复用 KV cache）。所以对一个已经超限的会话发起压缩，
摘要请求本身也会超限——`/compact` 和溢出恢复都一样跑不动。

**规则**：源工具已经付过摘要的钱，直接复用它。`compact.mjs` 读取源工具的压缩边界
（`tail_start_id` / `summaryMessageIds` / `preCompactTokenCount`），在对应位置插入一组
DSH 原生压缩事件，生成一个**新会话**（原始会话保留）。实测 10,643 事件 / 180 万 token 的会话
压缩后模型 surface 只剩 325 个节点，同一会话成功跑完一轮对话。

**顺带记下**：迁移时如果源工具已经压缩过，其实可以一开始就在日志里带上压缩事件；本工具选择
"先全量导入、需要时再生成压缩版"，是为了让原始会话保持可读。

## 12. 交付时容易忘记的边界

- **附件**：ZCode 的图片/文件 part 只存引用（`zcode-artifact://...`），二进制不在会话库里。
  迁移只能落成文本注记；要 1:1 还原需要额外搬运 artifact 存储。
- **降级项**：`timeline`（模型切换分隔符）与 `compaction` 标记没有对应的 DSH 事件，丢弃并计数。
- **推理过程**：ZCode 的 `reasoning` part 映射为 DSH 的 `reasoning` 内容块，**不要丢**。
- **幂等**：靠 manifest 里的 `zcodeId` 去重；重跑不会产生重复会话。manifest 是回滚的唯一依据，
  不要删。
- **回滚会连 DSH 侧的后续内容一起删**：如果用户已经打开过某个迁移会话并继续对话（DSH 会把新
  事件追加到同一个文件），`rollback.mjs` 删除该会话目录时会一并删掉这些新内容。回滚前先确认
  用户没有在迁移过来的会话里继续工作；必要时先只回滚 `register-workspaces.mjs`（分组），
  保留会话文件。
