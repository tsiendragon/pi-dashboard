# 本机 Pi Live Session 自动发现与实时接管 — Tech Design

- **状态**：Implemented and verified（本地未提交）
- **主仓库**：`/mnt/workspace/lilong/repos/pi-dashboard`
- **Extension 仓库**：`/mnt/workspace/lilong/repos/pi-tsien-extension`
- **目标运行环境**：同一 Linux 用户、同一台 DSW 机器上的多个 Pi 进程
- **默认发现范围**：`/mnt/workspace/lilong/repos/worktree` 及其子目录
- **依赖版本**：`@earendil-works/pi-coding-agent >= 0.84.2`

## 1. 背景

Pi Dashboard 当前只能直接控制由自身创建的 SDK/RPC slot。用户从不同 Worktree 目录启动的 Pi TUI/RPC 进程虽然位于同一台机器，但不归 Dashboard 持有：

- Dashboard 不拥有这些进程的标准输入/输出；
- Pi RPC 没有可供第二个客户端附加的公共监听端口；
- JSONL session 文件是持久化记录，不是实时控制通道；
- 直接写 JSONL、向终端注入按键或附加进程标准输入均可能破坏会话。

本设计在集成版 `pi-tsien-extension` 中增加一个本机会话桥接 Extension。每个运行中的 Pi 进程通过私有 Unix Domain Socket 主动注册到 Dashboard。Pi 进程始终是会话和执行状态的唯一事实来源；Dashboard 只做发现、展示和受控命令转发。

## 2. 目标

1. Dashboard 自动发现以下根目录中的运行中 Pi session：
   - `/mnt/workspace/lilong/repos/worktree`
   - 配置中追加的其他根目录。
2. Dashboard 晚于 Pi 启动时，已有 Pi 仍能自动注册。
3. 展示 session 的工作目录、Git 分支、PID、名称、模型、思考等级和运行状态。
4. 实时镜像用户消息、助手流式输出、thinking、工具开始/更新/结束和错误。
5. 从 Dashboard 发送普通消息、`steer`、`followUp` 和 `abort`。
6. 普通消息由 terminal、web 和 chatapp 共用一个串行输入队列，不要求独占租约。
7. `abort` 和功能控制等强操作继续使用独占控制租约。
8. Dashboard 断开、崩溃或租约过期后自动释放强控制权限。
9. 不修改 Pi Core，不向浏览器暴露本地 Unix Socket、环境变量或进程句柄。
10. Dashboard 自己创建的 SDK/RPC slot 不重复注册为 Live Session。

## 3. 非目标

1. 不通过 `/proc` 扫描后强行附加到未加载桥接 Extension 的 Pi 进程。
2. 不允许两个 Dashboard 实例同时控制一个 Pi session。
3. 第一版不支持从 Dashboard 切换外部 Pi 的 session 文件、模型或思考等级。
4. 第一版不支持浏览器上传图片到外部 Pi session。
5. 不修改、截断或合并外部 session 的 JSONL 文件。
6. 不自动重启已退出的外部 Pi 进程。
7. 不将 Live Session 伪装成 Dashboard 自己管理的 `PiSession` slot。
8. 不将任意 OS 进程识别为 Pi session；只有完成协议握手的 Pi Extension 才是可信 Live Session。

## 4. 用户体验

### 4.1 自动发现

Dashboard 左侧增加 **Live Pi Sessions** 区域，按 Worktree 工作目录分组：

```text
Live Pi Sessions
├─ RISKY-18570-security-guard
│  └─ ● pi  PID 12345  gpt-5.6-sol  Running
├─ RISKY-18801-dashboard
│  └─ ○ pi  PID 12680  gpt-5.6-sol  Idle
└─ RISKY-18801-dashboard
   └─ ○ pi  PID 12702  qwen3-coder-plus  Idle
```

状态定义：

- `● Running`：正在执行 agent turn 或工具；
- `○ Idle`：可立即接收普通消息；
- `◐ Reconnecting`：连接中断但仍处于重连宽限期；
- `🔒 Claimed`：已被某个 Dashboard 浏览器取得控制权；
- `× Offline`：超过宽限期，随后从列表移除。

同一个工作目录允许存在多个 Pi 进程，以 `processInstanceId` 区分，不能只用 `cwd` 作为主键。

### 4.2 查看

点击 Live Session 后进入独立 Live Session 页面，不创建 Dashboard slot。页面复用现有消息、thinking 和工具卡片，但状态来源改为 Live Session store。

未取得控制权时页面为实时只读：

- 可以查看完整初始快照和后续流式事件；
- 输入框显示“发送消息将取得控制权”；
- 可以手工点击“接管”。

### 4.3 输入与强控制

普通消息不接管 session：

1. terminal、web 和 chatapp 输入均携带必填 `channel`；
2. Extension 将普通消息放入同一个 FIFO 队列；
3. TUI 普通输入不会因为 Dashboard 在线或已取得强控制租约而被禁止；
4. `abort` 和功能控制等强操作仍需显式取得租约；
5. `/dashboard-release` 只释放强控制权限。

这样只有一个消息串行点，不为不同入口建立独立队列或租约。

### 4.4 归还

以下任一条件会释放租约：

- Dashboard 点击“归还控制权”；
- TUI 执行 `/dashboard-release`；
- 浏览器 Live Session WebSocket 断开超过 15 秒；
- 30 秒租约到期且连续 3 次续租失败；
- Dashboard broker 退出；
- Pi session shutdown 或切换到不允许的工作目录。

归还后 TUI 普通输入立即恢复。

## 5. 总体架构

```text
┌───────────────────────────────────────────────────────────────┐
│ Pi process A (cwd=/mnt/.../worktree/task-a)                    │
│  pi-tsien-extension/live-session                              │
│  - captures ExtensionContext                                  │
│  - emits snapshot/events                                      │
│  - executes prompt/abort/claim/release                         │
└──────────────────────┬────────────────────────────────────────┘
                       │ private JSONL over Unix Socket
┌──────────────────────▼────────────────────────────────────────┐
│ Pi Dashboard Live Session Broker                              │
│  ~/.pi/agent/run/pi-dashboard/live-sessions.sock              │
│  - authenticates local Extension clients                       │
│  - canonical-path scope check                                  │
│  - registry, sequence, lease and command routing               │
└──────────────────────┬────────────────────────────────────────┘
                       │ authenticated REST + dedicated WebSocket
┌──────────────────────▼────────────────────────────────────────┐
│ Dashboard React WebUI                                         │
│  - Live Session list                                           │
│  - transcript/tool timeline                                    │
│  - claim/release/prompt/steer/followUp/abort                   │
└───────────────────────────────────────────────────────────────┘
```

### 5.1 与现有 Extension Bridge 的关系

现有 Dashboard Extension Bridge 以 `(slotKey, feature)` 为主键，服务于 Dashboard 自己创建的 SDK/RPC slot。Live Session 没有 Dashboard slot，因此不应伪造 slot 或复用该注册表。

可以复用以下基础实现：

- JSONL framing；
- 消息尺寸限制；
- typed command/result envelope；
- WebSocket snapshot reducer 的 revision 处理方式；
- Unix Socket 目录权限和 shutdown 清理模式。

必须新增独立的 `LiveSessionRegistry` 和固定可发现 socket。

## 6. 组件设计

### 6.1 集成版 Pi Extension

新增文件：

```text
/mnt/workspace/lilong/repos/pi-tsien-extension/extensions/live-session.ts
/mnt/workspace/lilong/repos/pi-tsien-extension/extensions/live-session/client.ts
/mnt/workspace/lilong/repos/pi-tsien-extension/extensions/live-session/protocol.ts
/mnt/workspace/lilong/repos/pi-tsien-extension/extensions/live-session/projector.ts
/mnt/workspace/lilong/repos/pi-tsien-extension/extensions/live-session/lease.ts
```

职责：

1. 在 `session_start` 捕获最新 `ExtensionContext`。
2. 通过 `ctx.sessionManager` 读取：
   - `getSessionId()`；
   - `getSessionFile()`；
   - `getSessionName()`；
   - `getBranch()`；
   - `getCwd()`。
3. 监听：
   - `session_start` / `session_info_changed` / `session_shutdown`；
   - `agent_start` / `agent_end` / `agent_settled`；
   - `turn_start` / `turn_end`；
   - `message_start` / `message_update` / `message_end`；
   - `tool_execution_start` / `tool_execution_update` / `tool_execution_end`；
   - `model_select` / `thinking_level_select`；
   - `input`。
4. 使用一个 FIFO 队列和 `pi.sendUserMessage()` 执行 terminal、web 与 chatapp 普通消息。
5. 使用最新 `ctx.abort()` 执行中止。
6. 在 `input` hook 中把普通 TUI 输入标记为 `terminal` 并放入同一队列；Pi 原生命令保持原路径。
7. 注册 `/dashboard-release` 命令释放强控制租约。
8. Dashboard 不存在时静默重连，不影响 Pi 启动和推理。

以下进程不注册：

```ts
if (process.env.PI_RUNTIME === "dashboard") return
if (ctx.mode === "print" || ctx.mode === "json") return
```

第一版正式支持 `ctx.mode === "tui"`。非 Dashboard 所有的长期 RPC 进程可以注册为只读，但不承诺本地输入锁语义。

### 6.2 Dashboard Live Session Broker

新增文件：

```text
/mnt/workspace/lilong/repos/pi-dashboard/backend/live-sessions/broker.ts
/mnt/workspace/lilong/repos/pi-dashboard/backend/live-sessions/registry.ts
/mnt/workspace/lilong/repos/pi-dashboard/backend/live-sessions/protocol.ts
/mnt/workspace/lilong/repos/pi-dashboard/backend/live-sessions/path-policy.ts
/mnt/workspace/lilong/repos/pi-dashboard/backend/live-sessions/auth.ts
/mnt/workspace/lilong/repos/pi-dashboard/backend/routes/live-sessions.ts
/mnt/workspace/lilong/repos/pi-dashboard/shared/src/live-sessions.ts
```

固定运行目录：

```text
~/.pi/agent/run/pi-dashboard/
├─ live-sessions.sock       mode 0600
├─ live-broker-token        mode 0600
├─ live-control-token       mode 0600
└─ live-sessions.lock       mode 0600
```

父目录强制 `0700`。

启动规则：

1. 创建并 `chmod 0700` 运行目录；
2. 若 socket 已存在，先尝试连接；
3. 如果连接成功，说明另一个 broker 正在运行，当前实例禁用 Live Session 并报明确错误；
4. 只有收到 `ECONNREFUSED` 或确认 lock PID 已不存在时才删除 stale socket；
5. 创建 socket 后 `chmod 0600`；
6. SIGINT/SIGTERM/正常 shutdown 均关闭 server 并删除本实例 socket/lock。

### 6.3 前端

新增文件：

```text
/mnt/workspace/lilong/repos/pi-dashboard/frontend/src/features/live-sessions/LiveSessionsList.tsx
/mnt/workspace/lilong/repos/pi-dashboard/frontend/src/features/live-sessions/LiveSessionPage.tsx
/mnt/workspace/lilong/repos/pi-dashboard/frontend/src/features/live-sessions/LiveSessionHeader.tsx
/mnt/workspace/lilong/repos/pi-dashboard/frontend/src/features/live-sessions/LiveSessionComposer.tsx
/mnt/workspace/lilong/repos/pi-dashboard/frontend/src/features/live-sessions/useLiveSession.ts
/mnt/workspace/lilong/repos/pi-dashboard/frontend/src/store/liveSessionsSlice.ts
```

Live Session 使用独立 Redux slice，不写入现有 `chat.slots`，避免 Dashboard 误认为自己拥有该进程生命周期。

## 7. 配置

配置写入 `~/.pi/dashboard.json`，不写项目仓库：

```json
{
  "liveSessions": {
    "enabled": true,
    "roots": [
      "/mnt/workspace/lilong/repos/worktree"
    ],
    "includeOutsideRoots": false,
    "claimMode": "on-first-input",
    "leaseMs": 30000,
    "disconnectGraceMs": 15000,
    "snapshotEntryLimit": 200
  }
}
```

约束：

- `roots` 至少一个绝对路径；
- `leaseMs` 范围 `10000..120000`；
- `disconnectGraceMs` 范围 `5000..60000`；
- `snapshotEntryLimit` 范围 `20..500`；
- 未配置时使用上述默认值；
- 配置错误时禁用 Live Session 控制并记录错误，不回退为无范围限制。

### 7.1 路径授权

Dashboard 对 root 和 session cwd 都执行 `realpath()`，然后使用 `path.relative()` 判断：

```ts
const relative = path.relative(canonicalRoot, canonicalCwd)
const allowed = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
```

禁止使用简单字符串 `startsWith(root)`，避免 `/worktree-evil` 被误判为 `/worktree` 子目录。

如果 cwd 暂时不存在或 `realpath()` 失败，该 session 只显示 `out_of_scope` 诊断，不允许注册或控制。

### 7.2 侧栏行的断开宽限

服务端在 `disconnectGraceMs` 之后 `detach()` 会直接删掉注册表条目，`GET /api/live-sessions` 随之不再返回它。
浏览器若同步删行，「掉线 → 重连」周期里该行会一闪一闪（Pi 重连慢于 15 s 时尤其明显）。

前端因此在 `frontend/src/features/live-sessions/detachGrace.ts` 再保留一段宽限：

- `DETACH_GRACE_MS = 60_000`：收到 `live_session_detached` 后不立即删行，该行继续按「重连中」显示；
- 宽限期内刷新列表时，把仍在宽限中的会话补回 payload，避免 `sessionsLoaded` 的缺失扫描把行删掉；
- 会话重新 `attached` / 收到 `snapshot` 即取消宽限，恢复服务端状态；
- 宽限结束才真正移除该行（并清空 `activeId`），语义与服务端 detach 一致，只是延后。
- `DETACH_FLUSH_MS = 5_000` 为清理周期，行的消失最多滞后这么久。

## 8. 身份与数据模型

```ts
export interface LiveSessionSummary {
  processInstanceId: string
  sessionId: string
  sessionFile?: string
  sessionName?: string
  pid: number
  cwd: string
  canonicalCwd: string
  mode: "tui" | "rpc"
  model?: { provider: string; id: string }
  thinkingLevel?: string
  status: "idle" | "running" | "reconnecting"
  claim: {
    state: "unclaimed" | "claimed"
    leaseId?: string
    expiresAt?: number
  }
  startedAt: number
  lastActivityAt: number
  revision: number
  eventSequence: number
  contextUsage?: {
    tokens: number | null
    contextWindow: number
    percent: number | null
  }
  git?: {
    root?: string
    branch?: string
  }
}
```

`processInstanceId` 在 Extension 实例创建时生成 UUID，进程存续期间稳定。不能只使用 PID，防止 PID 重用；不能只使用 `sessionId`，因为同一进程可能切换 session。

Registry 主键：`processInstanceId`。

发生 session switch 时：

- `processInstanceId` 不变；
- `sessionId`、`sessionFile`、`sessionName`、branch snapshot 更新；
- revision 增加；
- 当前控制租约立即释放，必须重新 claim。

## 9. 本地 Broker 协议

### 9.1 传输

- Unix Domain Socket；
- UTF-8 newline-delimited JSON；
- 协议版本 `1`；
- 单条 event 最大 `1 MiB`；
- snapshot 最大 `2 MiB`；
- 命令最大 `256 KiB`；
- 单连接未处理缓冲最大 `4 MiB`，超出后断开并通过 snapshot 重同步。

### 9.2 Extension → Dashboard

握手：

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "brokerToken": "<local-file-token>",
  "processInstanceId": "uuid",
  "pid": 12345,
  "cwd": "/mnt/workspace/lilong/repos/worktree/task-a",
  "mode": "tui",
  "sessionId": "session-id"
}
```

初始快照：

```json
{
  "type": "snapshot",
  "processInstanceId": "uuid",
  "revision": 7,
  "sequence": 42,
  "summary": {},
  "entries": []
}
```

增量事件：

```json
{
  "type": "event",
  "processInstanceId": "uuid",
  "sequence": 43,
  "event": {
    "type": "message_update",
    "data": {}
  }
}
```

命令结果：

```json
{
  "type": "command_result",
  "requestId": "uuid",
  "ok": true,
  "result": {}
}
```

心跳与退出：

```json
{ "type": "heartbeat", "processInstanceId": "uuid", "at": 1780000000000 }
{ "type": "goodbye", "processInstanceId": "uuid", "reason": "session_shutdown" }
```

### 9.3 Dashboard → Extension

欢迎/拒绝：

```json
{ "type": "welcome", "protocolVersion": 2, "heartbeatMs": 10000 }
{ "type": "reject", "code": "out_of_scope", "message": "cwd is outside configured roots" }
```

统一命令 envelope：

```json
{
  "type": "command",
  "requestId": "uuid",
  "processInstanceId": "uuid",
  "command": {}
}
```

允许的命令：

```ts
type LiveSessionCommand =
  | { type: "resync" }
  | { type: "claim"; browserClientId: string; requestedLeaseMs: number }
  | { type: "renew"; leaseId: string }
  | { type: "release"; leaseId: string }
  | {
      type: "prompt"
      text: string
      channel: "web" | "terminal" | "chatapp"
      deliverAs?: "steer" | "followUp"
      expandPromptTemplates?: false
    }
  | { type: "abort"; leaseId: string }
```

第一版强制 `expandPromptTemplates: false`，防止浏览器输入被扩展为本地 Extension 命令、Skill 或 Prompt Template。后续如开放，必须单独授权。

### 9.4 幂等与顺序

- 每个 command 带唯一 `requestId`；
- Extension 保存最近 256 个 `requestId → result`；
- 重复 request 返回原结果，不重复发送 prompt；
- 每个连接维护单调递增 `sequence`；
- Dashboard 发现 sequence 缺口后停止应用增量事件并发送 `resync`；
- 新 snapshot 的 `revision` 小于等于当前 revision 时丢弃。

### 9.5 背压

`message_update` 和 `tool_execution_update` 可以按 message/tool ID 合并，只保留最新增量状态。以下事件不可丢弃：

- message start/end；
- tool start/end；
- agent start/end；
- claim/release；
- command result；
- session shutdown。

如果 socket 写缓冲持续超过上限，Extension 主动断开并重连，Dashboard 通过新 snapshot 恢复，不允许阻塞 Pi 的推理事件循环。

## 10. Snapshot 投影

Extension 从 `ctx.sessionManager.getBranch()` 建立初始活动分支快照，只发送最后 `snapshotEntryLimit` 条 entry。

投影规则：

1. 保留用于页面渲染的用户、助手、thinking、tool call/result 和自定义可见消息；
2. 不发送系统 prompt；
3. 不发送 provider credential、环境变量或 Model 对象；
4. 不发送函数、AbortSignal、进程句柄等不可序列化对象；
5. 单个工具输出超过 `256 KiB` 时截断并标记 `truncated: true`；
6. 总 snapshot 超过 `2 MiB` 时从最旧 entry 开始裁剪；
7. 消息内容本身可能包含用户敏感信息，因此所有浏览器读取接口必须认证。

Git 信息由 Dashboard 根据 canonical cwd 异步补充并缓存，不让 Extension 执行额外 Git 命令。

## 11. 控制租约状态机

```text
UNCLAIMED
   │ claim
   ▼
CLAIMED ── renew ──► CLAIMED
   │  │
   │  ├─ browser disconnect > 15s
   │  ├─ lease expiry
   │  ├─ /dashboard-release
   │  ├─ Dashboard shutdown
   │  └─ session switch/shutdown
   ▼
UNCLAIMED
```

规则：

- 同一时刻最多一个 `leaseId`；
- claim 默认 30 秒；
- Browser 每 10 秒 renew；
- 第二个 Browser claim 返回 `session_already_claimed`；
- 第一版没有远程 force-claim；
- `/dashboard-release` 不需要 leaseId，本地 TUI 永远优先；
- abort 只中止当前 agent operation，不释放租约；
- release 是幂等操作；
- broker 连接断开后 Extension 立即启动 15 秒宽限计时；宽限到期自动 release。

### 11.1 TUI 输入拦截

```ts
pi.on("input", (event, ctx) => {
  if (!lease.isClaimed()) return { action: "continue" }
  if (event.source === "extension") return { action: "continue" }
  if (event.source !== "interactive") return { action: "handled" }
  ctx.ui.notify(
    "当前 session 由 Dashboard 控制；输入 /dashboard-release 可收回控制权",
    "warning"
  )
  return { action: "handled" }
})
```

Extension 命令在 `input` event 之前分发，因此 `/dashboard-release` 在 claimed 状态仍可执行。

## 12. Prompt 与 Abort 语义

### 12.1 Prompt

- Pi idle：调用 `pi.sendUserMessage(text)`；
- Pi running：`deliverAs` 必须为 `steer` 或 `followUp`；
- 缺少/错误 leaseId：拒绝；
- 文本为空或超过 `128 KiB`：拒绝；
- 第一版只接受文本；
- 接收成功只表示消息已进入 Pi 队列，最终结果通过事件流返回。

### 12.2 Abort

- 使用最近一次事件上下文的 `ctx.abort()`；
- idle 时调用返回 `{ aborted: false, reason: "idle" }`；
- running 时返回 `{ aborted: true }`；
- abort 幂等，不通过信号或 PID 杀进程。

## 13. Dashboard HTTP 与 WebSocket API

所有 `/api/live-sessions` 接口必须通过 Live Session 专用认证。

### 13.1 REST

```text
POST /api/live-sessions/auth
GET  /api/live-sessions
GET  /api/live-sessions/:processInstanceId
POST /api/live-sessions/:processInstanceId/claim
POST /api/live-sessions/:processInstanceId/renew
POST /api/live-sessions/:processInstanceId/release
POST /api/live-sessions/:processInstanceId/commands
```

命令 endpoint 只接受：

```json
{ "command": { "type": "prompt", "leaseId": "...", "text": "..." } }
{ "command": { "type": "abort", "leaseId": "..." } }
```

状态码：

- `400`：schema/大小错误；
- `401`：浏览器未认证；
- `403`：cwd 超出 roots；
- `404`：session 不存在；
- `409`：状态冲突或 stale revision；
- `423`：已由其他 Browser claim；
- `504`：Extension 命令超时。

### 13.2 WebSocket

新增专用 WebSocket：

```text
/api/live-sessions/ws
```

不能把 transcript 广播到当前未认证的全局 `/api/ws`。

事件：

```text
live_session_attached
live_session_snapshot
live_session_event
live_session_claim_changed
live_session_reconnecting
live_session_detached
live_session_error
```

连接建立后先发送完整 session summary 列表，再发送增量事件。

## 14. 浏览器认证

当前 Dashboard 主 API 仍是单用户/网关信任模型，但 Live Session 会暴露外部会话内容和控制能力，因此必须增加独立认证。

### 14.1 Token

Dashboard 首次启动 Live Session 功能时生成：

```text
~/.pi/agent/run/pi-dashboard/live-control-token
```

- 32 字节随机值；
- 文件 mode `0600`；
- 只在启动日志中打印文件路径，不打印 token；
- 用户在 Dashboard Settings 中输入一次 token；
- `POST /api/live-sessions/auth` 校验后设置随机 HttpOnly session cookie；
- cookie 使用 `SameSite=Strict`；
- DSW HTTPS 下设置 `Secure`；
- server restart 后现有认证 session 失效，需要重新认证。

### 14.2 Browser client

认证成功后后端生成 `browserClientId`，用于 lease owner。浏览器 JavaScript 不读取 HttpOnly cookie，只通过同源请求自动携带。

WebSocket upgrade 必须校验同一 cookie。Origin 必须是当前 host 或 `PI_DASH_ALLOWED_ORIGIN`，继续拒绝 cross-site 请求。

### 14.3 Broker token

Pi Extension 与 Dashboard Broker 使用独立 `live-broker-token`。Extension 每次重连时重新读取 token 文件，Dashboard restart 可以旋转 token。

浏览器永远不能读取 broker token。

## 15. 重连与故障恢复

### 15.1 Pi 早于 Dashboard 启动

Extension 连接固定 socket 失败后使用带 jitter 的指数退避：

```text
250ms → 500ms → 1s → 2s → 5s → 10s → 30s（上限）
```

Dashboard 启动后，所有仍存活 Extension 最迟 30 秒内注册。成功后退避重置。

### 15.2 Dashboard 重启

1. Extension 发现 socket 断开；
2. 保留 claim 15 秒；
3. 重新读取 token 并连接新 broker；
4. 发送 hello + 完整 snapshot；
5. 如果 15 秒内恢复且 Browser lease owner 已恢复，可续租；
6. 否则自动 release，避免 TUI 长期锁死。

第一版为了安全，Dashboard server restart 后浏览器认证失效，因此通常会释放旧 lease。

### 15.3 Pi 退出

正常退出发送 `goodbye`。异常退出由 socket close 检测；Registry 标记 `reconnecting` 15 秒，未重连则 detach。

### 15.4 Session 切换

Extension 在 session switch 后重新发送 snapshot。旧 lease 立即 release，旧 transcript 从 Live Session 页面替换，禁止把两个 session 的事件合并。

## 16. 可观测性

允许记录：

- processInstanceId；
- PID；
- canonical cwd；
- protocol version；
- attach/detach/reconnect；
- claim/release reason；
- command type、耗时和结果 code；
- event/snapshot 字节数和截断次数。

禁止记录：

- prompt 正文；
- assistant 正文；
- tool 完整输入/输出；
- session transcript；
- browser token 或 broker token。

建议计数器：

```text
live_sessions_connected
live_sessions_claimed
live_session_reconnect_total
live_session_command_total{type,result}
live_session_resync_total
live_session_truncated_total{kind}
```

## 17. 安全边界

1. Pi 进程是唯一执行者；Dashboard 不写 session JSONL。
2. 只有 canonical cwd 位于授权 roots 内的 session 才可注册。
3. Unix Socket 和 token 文件只允许当前 Unix 用户访问。
4. Browser 必须通过专用 token 认证。
5. 所有命令使用严格 union schema 和长度限制。
6. 第一版禁止远程 template/skill/extension command expansion。
7. 第一版禁止 shell、文件写入、session switch、model switch 等直接管理命令。
8. Dashboard 不能通过 live protocol 请求任意 Extension tool。
9. 本地 `/dashboard-release` 永远优先于远程 lease。
10. Dashboard disconnect 后必须 fail-open：恢复 TUI，而不是继续锁定。
11. 未知协议版本、未知字段类型、超限消息和认证失败立即关闭 socket。
12. Dashboard 自身进程通过 `PI_RUNTIME=dashboard` 排除，防止注册环路。

## 18. 测试设计

### 18.1 Pi Extension 单元测试

1. `session_start` 生成正确 hello/snapshot。
2. dashboard runtime 不注册。
3. print/json mode 不注册。
4. idle prompt 调用 `sendUserMessage(text)`。
5. running prompt 必须带 steer/followUp。
6. abort 调用当前 context 的 `abort()`。
7. claimed 时 interactive input 返回 handled。
8. claimed 时 extension input 返回 continue。
9. `/dashboard-release` 清除 lease。
10. lease 过期和 broker 断开宽限后恢复输入。
11. 重复 requestId 不重复发送 prompt。
12. message/tool update 合并不丢 start/end。
13. snapshot 截断满足条数和字节限制。
14. session switch 释放 lease并刷新 identity。

### 18.2 Dashboard backend 单元测试

1. canonical root 正确接受真正子目录。
2. 拒绝 `/worktree-evil`、`..` 和越界 symlink。
3. cwd 不存在时 fail closed。
4. broker socket/目录权限为 0600/0700。
5. 活跃 broker 存在时不删除其 socket。
6. stale socket 可安全恢复。
7. token 错误和协议版本错误断开。
8. sequence gap 触发 resync。
9. stale snapshot revision 被忽略。
10. 两个同 cwd Pi 使用不同 processInstanceId 共存。
11. claim 冲突返回 423。
12. renew/release/expiry 状态机正确。
13. browser 未认证不能读取 transcript 或发送命令。
14. 命令串行化、timeout、断线结果正确。
15. registry detach 清理 pending command 和 lease。

### 18.3 Frontend 测试

1. Live Session 按 cwd 分组。
2. 同 cwd 多进程不会覆盖。
3. snapshot + event sequence reducer 正确。
4. stale revision 不回滚 UI。
5. 未 claim 时输入触发 claim → prompt。
6. claim 失败不发送 prompt。
7. claimed banner、续租和 release 正确。
8. WebSocket 重连期间显示 reconnecting。
9. detach 后停止续租并禁用输入。
10. token 认证失败不泄露 session 内容。

### 18.4 真实集成测试

在两个临时 Worktree 子目录启动不调用模型的 Pi RPC/TUI fixture：

1. Dashboard 后启动，两个 session 自动出现；
2. 验证 cwd、sessionId、PID 不串线；
3. claim/release/abort-idle 往返；
4. 杀掉一个 Pi，只 detach 对应 session；
5. 重启 Dashboard，Extension 自动重连；
6. socket/token/测试进程全部清理。

正式集成测试不发送会触发模型推理的 prompt；消息注入由 mock ExtensionContext 验证。

## 19. 实施阶段

### Stage 1：只读发现与镜像

- shared protocol；
- broker socket/token/path policy；
- Extension reconnect + hello/snapshot/events；
- backend registry/API/WebSocket；
- Live Session list/page只读 UI；
- 多 cwd 和断线测试。

**退出条件**：Dashboard 可自动发现 `/mnt/workspace/lilong/repos/worktree/**` 下所有已加载 Extension 的运行中 Pi，并实时镜像事件，无控制能力。

### Stage 2：认证与控制租约

- browser token/cookie；
- claim/renew/release；
- TUI input gate；
- `/dashboard-release`；
- disconnect/expiry fail-open。

**退出条件**：接管时本地普通输入被阻止，任何断线或超时都在规定时间内恢复 TUI。

### Stage 3：Prompt、Steer、Follow-up、Abort

- typed command validators；
- command idempotency；
- composer 状态；
- abort；
- stream result association。

**退出条件**：Browser 能可靠控制已 claim session，不允许无 lease 或跨 session 命令。

### Stage 4：生产验证与文档

- 两个以上 Worktree 并行 session 冒烟；
- Dashboard 先/后启动；
- Dashboard/Pi 异常退出；
- `/reload` 与新进程注册；
- 安全和资源清理检查；
- README 操作说明。

## 20. 文件级变更清单

### `pi-dashboard`

```text
shared/src/live-sessions.ts                                      新增
backend/live-sessions/protocol.ts                               新增
backend/live-sessions/path-policy.ts                            新增
backend/live-sessions/registry.ts                               新增
backend/live-sessions/broker.ts                                 新增
backend/live-sessions/auth.ts                                   新增
backend/routes/live-sessions.ts                                 新增
backend/routes/index.ts                                         修改
backend/server.ts                                               修改
backend/__tests__/live-session-broker.test.js                   新增
backend/__tests__/live-session-routes.test.js                   新增
frontend/src/api/client.ts                                      修改
frontend/src/hooks/useWebSocket.ts                              修改或拆分专用 hook
frontend/src/store/index.ts                                     修改
frontend/src/store/liveSessionsSlice.ts                         新增
frontend/src/features/live-sessions/LiveSessionsList.tsx        新增
frontend/src/features/live-sessions/LiveSessionPage.tsx         新增
frontend/src/features/live-sessions/LiveSessionHeader.tsx       新增
frontend/src/features/live-sessions/LiveSessionComposer.tsx     新增
frontend/src/features/live-sessions/useLiveSession.ts           新增
frontend/src/test/liveSessionsSlice.test.ts                     新增
```

### `pi-tsien-extension`

```text
extensions/live-session.ts                                      新增
extensions/live-session/client.ts                               新增
extensions/live-session/protocol.ts                             新增
extensions/live-session/projector.ts                            新增
extensions/live-session/lease.ts                                新增
test/live-session-client.test.ts                                新增
test/live-session-lease.test.ts                                 新增
```

## 21. 部署与迁移

1. 发布/加载新的集成版 `pi-tsien-extension`；
2. 更新 `~/.pi/dashboard.json` 的 `liveSessions` 配置；
3. 重启 Dashboard；
4. 查看 `live-control-token` 文件并在 Dashboard Settings 中认证；
5. 对已经运行的 Pi 执行一次 `/reload`；如果当前 Pi 版本 reload 后未重放 `session_start`，则重启该 Pi；
6. 之后所有新 Pi session 自动注册；
7. 验证 `/dashboard-release` 后再开启远程 prompt 控制。

回滚：

- 将 `liveSessions.enabled` 设置为 `false` 并重启 Dashboard；
- Extension 连接失败时自动 fail-open，不影响 Pi；
- 无需修改或迁移任何 session JSONL。

## 22. 验收标准

1. 在两个不同 `/mnt/workspace/lilong/repos/worktree/**` 目录运行 Pi，Dashboard 在 30 秒内自动显示两者。
2. Dashboard 晚于 Pi 启动时仍能发现已有进程。
3. 每个 session 的 cwd、PID、sessionId、模型和状态正确，不跨进程串线。
4. 助手流式消息和工具 update 在 Dashboard 中实时更新。
5. 第一条 Browser 消息成功 claim 后才注入 Pi。
6. claim 期间 TUI 普通输入被阻止，Extension 注入消息不被阻止。
7. `/dashboard-release` 在任何 claimed 状态下都能立即恢复 TUI。
8. Browser 断开或 Dashboard 退出后，最多 15 秒恢复 TUI。
9. 未认证 Browser 不能读取 Live Session transcript 或发送命令。
10. 越出授权 root 的 session 不出现在列表中，也不能通过猜测 ID 控制。
11. Dashboard 自己创建的 SDK/RPC slot 不出现在 Live Session 列表中。
12. 不修改 Pi Core，不直接写 session JSONL，不增加 TCP 控制端口。
13. backend/frontend/extension 单元测试、真实多 session 冒烟和生产构建全部通过。
14. 测试结束后无残留 Pi fixture、socket、lock、token 临时文件或 Dashboard slot。

## 23. 已确定的关键决策

1. **使用主动 Extension 注册，不使用 OS 进程扫描接管。** OS 扫描只能发现 PID，不能安全控制 Pi。
2. **使用固定私有 Unix Socket，不使用 TCP。** 所有 Pi 与 Dashboard 位于同一台机器。
3. **Pi 是事实来源。** Dashboard 不写 JSONL，不拥有外部进程生命周期。
4. **Live Session 与 Dashboard slot 分离。** 避免错误的 kill/restart/restore 语义。
5. **自动发现、首次输入接管。** 仅查看页面不会锁定 TUI。
6. **租约 fail-open。** 任何控制通道故障最终恢复本地 TUI。
7. **本地 release 永远优先。** 不提供第一版远程 force-claim。
8. **默认只允许 `/mnt/workspace/lilong/repos/worktree`。** 其他目录必须显式配置。
9. **控制接口单独认证。** 不把敏感 transcript 发到当前未认证的全局 WebSocket。
10. **第一版仅文本控制。** 不开放 template expansion、任意工具调用、shell 或 session/model 管理。

## 24. 实施与验证结果

已完成：

- 集成版 `pi-tsien-extension` Live Session 客户端、快照投影、自动重连、租约、TUI 输入门禁和 `/dashboard-release`；
- Dashboard 固定私有 Unix Socket Broker、canonical path policy、Git 元数据、心跳 watchdog、Registry 和 fail-open；
- Live Session 专用 Browser token/cookie 认证、REST 和独立 WebSocket；
- Live Pi 页面、同 cwd 多进程列表、实时 timeline、首次输入 claim、续租、release 和 abort；
- Dashboard-owned SDK/RPC session 排除，浏览器不能扩展 prompt template 或直接调用任意工具；
- token 普通文件/所有者/硬链接检查，以及 socket/lock 所有权清理。

验证证据：

- Dashboard backend：16 个测试文件通过，246 项通过，1 项跳过；
- Dashboard frontend：173 个测试单元通过，584 项测试通过；
- frontend TypeScript 与 Vite production build 通过；
- `pi-tsien-extension` 完整 `npm run check` 通过，其中 Node test 67 项、集成 Vitest 212 项；
- 两个真实 Worktree Pi RPC 进程在 Dashboard 后启动时自动发现并保持 identity/cwd 隔离；
- 真实链路完成 Browser 认证、claim、idle abort、release，以及一个 Pi 退出后只 detach 对应 session；
- 首次真实 snapshot 包含 Git branch；无 Origin 认证请求返回 403；
- 冒烟结束后没有残留 fixture Pi、临时 Dashboard、Unix Socket 或 lock。

启用要求：

1. 重启 Dashboard，使固定 Broker 开始监听；
2. 对本功能实施前已经运行的 Pi 执行一次 `/reload` 或重启；
3. 打开 Dashboard 的 **Live Pi**，输入 `/home/tsien/.pi/agent/run/pi-dashboard/live-control-token` 文件内容完成认证。
