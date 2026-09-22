# 校验：离线复核、隔离彩排、实时校验

三层证据，缺一层就不该宣称"迁移成功"。

## 第 1 层：产物复核（离线，必做）

```powershell
node "<skillDir>\scripts\verify.mjs" <manifest> --home <DSH_HOME>
```

对 manifest 里每个会话：

1. 从磁盘重新读回 artifact；
2. 结构化扫帧（魔数、保留位、校验和标志、块链完整性）；
3. 逐帧解压，确认**首帧恰好一行 header**；
4. 用 DSH 自带的 catalog 做**严格回放**（`recovery:'strict'` + `validation:'current'`，
   经 `Session.fromRestore`）；
5. 校验预置的投影缓存文档：`checkpointRecord.parse()`、`identity.formatVersion` 是否等于
   当前格式代、`identity` 是否与 header 一致、`title`/`sessionListMetadata` 行的 `ver`
   是否等于安装单元的 `stateVersion`、`val` 是否通过该单元的 `stateSchema`。

期望：`replay failed: 0`、`cache rejected: 0`。事件数**增长**是正常的（DSH 追加过帧）。

## 第 2 层：隔离彩排（强烈建议，动真实 home 之前）

目的：在不碰真实 DSH 状态的前提下，验证"DSH 启动 → 侧边栏列出 → 标题正确 → 历史可读"全链路。

用真实数据的副本，而不是合成数据——只有这样才会暴露与既有会话共存的问题。

```powershell
$home = $env:DSH_HOME            # 真实 home
$iso  = "<某个可写目录>\iso\home"

New-Item -ItemType Directory -Force -Path $iso | Out-Null
# profiles 用目录联接，避免复制几百 MB
New-Item -ItemType Junction -Path "$iso\profiles" -Target "$home\profiles" | Out-Null
Copy-Item "$home\settings.yaml"     $iso -Force
Copy-Item "$home\.credentials.yaml" $iso -Force -ErrorAction SilentlyContinue
Copy-Item "$home\sessions"          $iso -Recurse -Force
Copy-Item "$home\storages"          $iso -Recurse -Force
Copy-Item "$home\attachments"       $iso -Recurse -Force -ErrorAction SilentlyContinue

# 用同一个 CLI 起第二个实例（注意给带空格的路径加引号）
$env:ELECTRON_RUN_AS_NODE = "1"
$env:DSH_HOME = $iso
Start-Process -FilePath "<DSH Desktop.exe>" -ArgumentList `
  '--expose-internals','"<...>\resources\app\lib\desktop-cli.js"','web','--port','43999','--no-open' `
  -RedirectStandardOutput "$iso\web.out.log" -RedirectStandardError "$iso\web.err.log" -NoNewWindow
```

启动横幅会打印带 `?token=` 的 URL。`web.err.log` 为空才算启动成功；若有
`plugin tree failed to load`，去看它指向的具体域。

**为什么一定要走副本**：真机上的错误代价很高——`workspace.json` 坏一个字节就是应用起不来。

## 第 3 层：实时校验（对运行中的宿主）

```powershell
node "<skillDir>\scripts\check-live.mjs" --url "http://127.0.0.1:<port>/?token=<token>" `
     --manifest <manifest> --sample 3
```

它模拟浏览器：

1. `GET /?token=...` 换签名 cookie。**必须禁止跟随重定向**——Node 的 fetch 没有 cookie jar，
   跟随到 `/` 会因为检测不到 cookie 而 401；
2. `POST /api/session/list`，body 形如
   `{"type":"client-request","rpcId":"...","method":"session/list","payload":{"args":{"_request":{}}}}`。
   注意载荷必须是 `{args:{...}}` 这一层，缺了会被拒为
   "Remote payload must contain exactly one plain-object args field"；
3. 逐条比对：会话在列表里、`projections.values.title` 等于 manifest 标题、`blank === false`、
   `cwd` 一致、`origin !== 'subagent'`；
4. `POST /api/session/page` 拉取最大的几条会话，body 的 `request` 形如
   `{address:{kind:'session',sessionId},throughSeq:<最后 seq>,maxMessages:400}`；
   **`throughSeq` 不能超过该会话的当前游标**，否则报 "past cursor N"；
   返回的 `value.records[].event.type` 用于统计 user/assistant/tool 数量。

期望：`migrated found: N/N`、`titles matching: N/N`、`PASS`。

### token 从哪来

宿主启动时打印一次（`dsh web: http://127.0.0.1:<port>/?token=...`）。它是**每进程随机**的，
重启即失效，也不会写进日志。桌面应用自带的宿主拿不到该 URL，所以对真实桌面宿主做实时校验
不可行——用第 2 层（副本实例）代替。

## 什么时候可以判定"迁移成功"

- 第 1 层全部通过；
- 第 2 层的 `check-live.mjs` 输出 `PASS`；
- 真实 home 启动后，用户能在预期分组下看到会话、标题正确、点进去有完整历史。

在用户重启 DSH 之前，**不要宣称侧边栏已经能看到**——投影缓存与工作区注册表都要等下一次
启动才加载。
