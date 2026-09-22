# DSH 会话日志格式（v3）

本文是实现迁移时必须遵守的格式约定，全部来自对已安装 DSH 构建的源码核对与实测。

## 磁盘布局

```
<DSH_HOME>/sessions/
  --<projectKey(cwd)>--/                 # 可读的项目目录
    <encodeSegment(sessionId)>/          # 会话自有目录
      session.jsonl.zstd                 # v0，压缩根
      session.v1.jsonl.zstd              # v1
      session.v2.jsonl.zstd              # v2
      session.v3.jsonl.zstd              # v3（当前构建写入的 generation）
```

- `projectKey`：`/`、`\`、`:` 折叠成一个 `-`（连续分隔符只出一个），`[A-Za-z0-9._-]` 之外
  的 UTF-16 码元转义成 `~XXXX`（大写十六进制 4 位），最后包成 `--...--` 并截到 251 字符。
  例：`C:\Users\me` → `--C-Users-me--`；`D:\Desktop\中文` → `--D-Desktop~4E2D~6587--`。
- `encodeSegment`：同一套转义，作用于会话 id。
- 读取时选择**数值最高的 generation**；写新文件就用当前 generation（本构建为 v3）。
- 目录树里同时存在多个 generation 是正常的（历史迁移产物），不是冲突。

## 物理编码：拼接的校验和 Zstandard 帧

- 整个文件是若干**独立可解码的 zstd 帧**首尾相接。
- **第一帧只包含一行 header**，且必须恰好以 `\n` 结尾，不能有多余换行
  （对应 `assertZstdHeaderFrame`：`plaintext.indexOf('\n') === plaintext.length - 1`）。
- 之后每批已提交事件一帧。导入时把全部事件写成**一帧**即可。
- 每帧都要带校验和：`zstdCompressSync(bytes, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })`。
  读取端会解析帧头里的 checksum 标志位。
- 读取端不靠"扫描魔数"分帧，而是走帧头 → 块头链的结构化扫描
  （`scanZstdFrames`）：魔数错、保留位非零、保留块类型都会拒绝。

**不会**被接受的做法：纯文本 JSONL（`compression: 'none'` 是另一个根配置，混合根不支持）、
一个 JSON 数组、多行 header、缺校验和的帧。

## 逻辑记录

每一行是一个 JSON 对象。header：

```json
{"type":"session","version":3,"id":"session-<uuid>","createdAt":1730000000000,
 "cwd":"<绝对路径>","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

事件：

```json
{"type":"<event type>","seq":0,"time":1730000000000,"data":{...}}
```

- `seq` 必须**从 0 开始稠密递增**（校验按数组下标比对）。迁移时每写一个事件就自增，
  不要留空洞。
- `time` 必须是安全整数毫秒。
- 未知事件类型只有在 event 带 `"ignorable": true` 时才允许出现。

### 会话正文所需的最小事件集

```
permission/preset {preset}          # 开场状态
sandbox/mode      {mode}
approval/policy   {policy}
session/title     {title, messageSeqs, source}   # 标题
turn/start        {turn}
step/start        {turn, step}
user/message      {content, source, role, id}    # surface 事件
assistant/message {turn, step, message, stream, usage?}
tool/call         {turn, step, callId, name, arguments}
tool/result       {turn, step, message, sourceEventSeqs}  # surface 事件
step/end          {turn, step}
turn/end          {turn, reason:{kind:'completed'}}
```

要点：

- `user/message`、`assistant/message`、`tool/result` 是 **surface 事件**，必须带
  `"surfaceOp": "append"`。
- 一个 turn 的第一个 step 里放用户消息（DSH 自己也这么落地 inbox prompt），
  后续每个 assistant 消息各占一个 step。
- `assistant/message.data` 必须含 `stream`（数组即可，导入用 `[]`）；缺它会被
  `Session.fromRestore` 以 "has invalid settlement fields" 拒绝。
- `tool/result.data.message` 必须恰好一个 `tool-result` 内容块，且
  `toolCallId` 与 `source.callId` 一致；`sourceEventSeqs` 指向对应的 `tool/call` 的 seq。
- `session/title` 的 `source.kind` 决定语义：
  - `{kind:'user'}` 时 `messageSeqs` **必须为空**——这是"钉住标题"的形态，导入外部标题用它；
  - 其他 kind 必须**至少引用一个更早的、`source.kind==='user'` 的 `user/message` 的 seq。
  - 用 `{kind:'custom'}` 能通过格式校验，但会在标题折叠时违反该不变量——不要用。

### 校验口径

- 格式层：`sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })`
  → `decodeRow()` 逐行 → `finish()`。这是最严格的一档，会经 `Session.fromRestore`。
- 生产读取用 `{ recovery: 'recoverable', validation: 'transformed' }`，对被截断的尾帧更宽容。
- 迁移工具应在写盘前跑格式层校验。

## 投影缓存（冷会话标题的唯一来源）

`<DSH_HOME>/storages/session_projcache/` 是 `per-record` 布局，每个会话一份文档：

```
<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json
{"version":7,"record":{"identity":{...},"rows":{"<key>":{"ver":N,"seq":N,"val":...}}}}
```

- `identity` **必须带 `formatVersion`**（等于会话 header 的 `version`），另外
  `createdAt`/`cwd`/`isSeeded`/`inheritedEventCount` 要与 header 一致。缺 `formatVersion`
  的记录只被当作"前代标题提示"，不会作为列表值采信。
- `title` 行：`stateVersion` 为 1，`val` 是标题字符串。
- `sessionListMetadata` 行：`stateVersion` 为 1，
  `val = { blank, lastPromptAt }`；`blank` 在首个 `turn/start` 后为 `false`，
  `lastPromptAt` 是最后一条人类 `user/message` 的 time，**它决定侧边栏的"更新于"排序**。
- 该域声明 `invalidRecords: 'backup-and-skip'`：写错只会被 DSH 移到
  `<id>.json.bak.<时间戳>` 并按未缓存处理，不会影响启动。这是它比 `workspace.json` 安全的原因。
- 行 `ver` 必须等于该投影单元当前的 `stateVersion`（`title` 从单元的
  `titleProjectionDefinition.stateVersion` 取，不要照抄旧磁盘样本）。

## 压缩事件

DSH 用一组事件把旧的 surface 替换成摘要，同时把原事件留在日志里。四个事件构成一个事务：

```json
{"type":"compaction/start","seq":S,"time":T,"data":{"compactionId":"cmp_<uuid>","turn":null}}
{"type":"compaction/summary","seq":S+1,"time":T,"data":{
   "compactionId":"cmp_<uuid>","summary":"<摘要文本>",
   "shadowedRange":{"start":<起始 seq>,"end":<结束 seq>},
   "shadowedSeqs":[...],"shadowedTokenCount":123456,
   "provider":"...","model":"..."}}
{"type":"user/message","seq":S+2,"time":T,
 "surfaceOp":{"op":"replace","startSeq":<起始 seq>,"endSeq":<结束 seq>},
 "sourceEventSeqs":[S,S+1,...shadowedSeqs],
 "data":{"content":[{"type":"text","text":"<摘要文本>"}],
         "source":{"kind":"plugin","plugin":"compact","compactionId":"cmp_<uuid>"},
         "role":"user","id":"compaction-checkpoint-cmp_<uuid>"}}
{"type":"compaction/end","seq":S+3,"time":T,"data":{"compactionId":"cmp_<uuid>","turn":null}}
```

必须满足的约束（任一不满足，DSH 会拒绝整条日志）：

| 约束 | 说明 |
|---|---|
| `turn` 归属 | `turn: null` 表示"轮次之间的独立压缩"；此时前面**不能有未闭合的 turn**。若给数字，必须等于当前打开的 turn。 |
| 括号不能跨轮次 | `compaction/start` 打开后，`turn/start` / `turn/end` 都不能出现，直到 `compaction/end`。所以插入点必须在两个 turn 之间。 |
| id 一致 | `summary` / `end` / 检查点的 `source.compactionId` 必须等于 `start` 的 `compactionId`。 |
| 恰好一次 summary | 一个括号内只能有一个 `compaction/summary`；成功的 `compaction/end` 要求已有 summary。 |
| `shadowedTokenCount` | 必须是非负安全整数。 |
| **`shadowedSeqs` 必须精确** | 非空，且**恰好等于当前 surface 上 `[shadowedRange.start .. shadowedRange.end]` 这一段连续节点**（顺序也一致）。`seqs[0] === start`、`seqs.at(-1) === end` 也要成立。 |
| 检查点来源 | 必须是 `{kind:'plugin', plugin:'compact', compactionId}`；只有这种来源的替换型 `user/message` 会被当作压缩检查点。 |
| `time` 必填 | 所有事件都要有毫秒 `time`（这是个容易漏的字段）。 |

**surface 的定义**：带 `surfaceOp` 的事件（`user/message`、`assistant/message`、`tool/result`、
`system/message`）。纯追加的日志里，surface 就等于这些事件按 seq 排列。

**遮蔽一个前缀时的算法**：找到保留尾部所在 turn 的 `turn/start` 下标 `i`；取
`events[0..i-1]` 中所有 surface 事件的 seq 作为 `shadowedSeqs`；`shadowedRange` 取其首尾。
插入点之后的每个事件 seq 都要整体后移，且它们自身的 `sourceEventSeqs` 引用必须同步重映射
（插入点之前的事件 seq 不变，所以 `shadowedSeqs` 不需要重映射）。

校验方式：`verify.mjs` 的严格回放会执行 `assertCurrentSurfaceSpan`，它检查的就是
"`shadowedSeqs` 是否等于当前 surface 的精确切片"。

## 侧边栏如何挑选会话

- `session.list`（Host 侧 `ApiSessionList`）**跳过 `header.cwd === undefined` 的会话**——cwd 必填。
- 冷会话的 `blank` 在缓存缺失时取 `false`（保持可见）。
- `updatedAt = max(header.createdAt, sessionListMetadata.lastPromptAt)`。
- 客户端 `displayTitleOf(title, cwd, id)` 的兜底：缓存标题 → `cwd` 的 basename → 会话 id。
- 分组完全由 `<DSH_HOME>/storages/workspace.json` 的 `tables.workspaces[].sessionIds` 决定，
  和 cwd 字符串没有直接关系（cwd 只用于 bootstrap 派生）。
