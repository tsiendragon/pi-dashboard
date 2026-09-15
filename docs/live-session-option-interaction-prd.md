# PRD — pi-dashboard LiveSession 用户选择交互（选项 / 审批）支持

> ⚠️ **方案已升级**：本文第 4 节的「最小改动方案（只覆盖 dashboard 自启 RPC 进程）」已被实测否定——
> 真实需求是「外部 TUI 进程的 option 也能投影到 web livesession，且 TUI 与 web 为平行渠道」。
> 正确方案为 **Extension UI 请求多通道**，详见：
> `docs/extension-ui-request-multi-channel-tech-design.md`。本文背景/根因仍有效，实施请以该 tech design 为准。

- 状态：已实现并验证（方案升级为多通道，见上；实施与实测记录以该 tech design 的 §8/§11/§12 为准）
- 所属仓库：`/mnt/workspace/lilong/repos/pi-dashboard`
- 依赖版本：`@earendil-works/pi-coding-agent >= 0.84.2`

## 1. 背景与问题

Agent 在对话中会触达「需要用户选择 / 应答」的交互，例如 extension UI 的
`confirm` / `select` / `input` / `editor`，以及工具审批 `tool_approval`。

这类交互当前的表现：

| 界面 | 是否显示选项 | 说明 |
|---|---|---|
| TUI | ✅ | pi 原生终端界面，select-list / 确认弹窗直接绘制并处理按键 |
| Web 普通 Chat（RPC） | ✅ | pi-dashboard 已实现 `extension_ui_request` / `tool_approval_request` 两条交互通道 |
| Web LiveSession | ❌ | 页面只渲染消息与工具 timeline，选项不显示、也无法应答 |

用户诉求：在 Web LiveSession 页面查看一个会话时，Agent 弹出的「选项」应与 TUI / 普通 Chat
一致地显示，并允许用户在页面上直接选择 / 应答，而不是只能回到 TUI 操作。

## 2. 根因分析（四层，已求证）

1. **投影层（pi-tsien-extension）**：`extensions/live-session.ts` 的事件监听白名单
   （session / agent / turn / message / tool_execution / model / thinking / input）中**不含**
   `extension_ui` 与 `tool_approval`，因此选项事件最上游就没进入 livesession 事件流。
2. **协议层（pi-dashboard）**：`shared/src/live-sessions.ts` 的 `LiveSessionCommand`
   白名单（input / abort / claim / renew / release / set_session_name / get_models /
   set_model / compact / reload / feature_command）中**没有「应答选项 / 批准工具」命令**，
   无法回传用户选择。
3. **后端接线层（pi-dashboard）**：livesession 的 pi 进程（`LivePiLauncher` 启动，
   `runtime: live`, `transport: rpc`）底层是 `PiSdkSession`，本身**会** emit
   `extension_ui` / `tool_approval`；但普通 Chat 的 `_wireSlotEvents` 只绑定在主
   `PiManager` 的 slot 上，live slot 没有接线，事件被丢弃。
4. **前端渲染层（pi-dashboard) **：`LiveSessionPage` 只做消息 + 工具 timeline，
   没有挂 `ExtensionUiModal` / `ToolApprovalModal`（这两个组件已存在，订阅全局 chatSlice）。

### 关键约束（决定改动边界）

`@earendil-works/pi-coding-agent` 的 `ExtensionAPI.on()` 事件全集
（`dist/core/extensions/types.d.ts` 872–900 行）**没有** `extension_ui` 事件；
`ExtensionUIContext.select/confirm/input` 是 extension *主动调用* 的 UI 请求，其他
extension 无法监听。因此：

- **外部 worktree 启动的 TUI 进程**（livesession 只读观察的典型场景）的选项是 TUI 原生
  overlay，pi 架构上未暴露给 dashboard，**无法用最小改动打通**。
- **dashboard 自启的 live 进程**（`POST /api/live-sessions/start`）底层是 dashboard 拥有的
  `PiSdkSession`，已注入自定义 uiContext，`extension_ui` / `tool_approval` 事件天然可接。

## 3. 目标与非目标

### 目标

1. dashboard 自启的 live 会话中，Agent 触发的 extension UI（confirm / select / input /
   editor）在 LiveSession 页面弹出并可应答，选择结果正确回传，Agent 继续执行。
2. （可选）同场景下工具审批 `tool_approval` 弹出并支持 approve / deny / edit。

### 非目标（第一版）

- 不支持「外部 worktree TUI 进程」的选项显示与应答（架构不可达，需动 pi 本体，另行评估）。
- 不改 livesession 协议、不加新的应答命令类型（回传复用 chat 已有 HTTP 端点）。
- 不改 `pi-tsien-extension` 的投影白名单。
- 不改变普通 Chat 的交互行为（零回归）。

## 4. 方案（最小改动，复用已有机制）

核心：live 进程本质仍是 `PiManager` + `PiSdkSession` slot，`extension_ui` /
`tool_approval` 事件与「回传端点」都已存在，只是没接线。方案是**接线 + 挂组件**，不新造协议。

### 改动 A（后端接线）

位置：`backend/live-sessions/launcher.ts`（或 `backend/routes/live-sessions.ts` 的 start 端点）。

在 `ensureRunning` 之后，给 live slot 的 `pi` 绑定：

- `pi.on('extension_ui', e => broadcast('extension_ui_request', { slot: slotKey, ...e }))`
- `pi.on('tool_approval', e => broadcast('tool_approval_request', { slot: slotKey, ...e }))`

复用 `backend/server.ts` 682–743 行已有 broadcast 逻辑，抽成可跨 manager 复用的
`wireLiveInteractionEvents(pi, slotKey)`，避免复制粘贴。

回传端点零改动：`/api/chat/slots/:key/extension-ui-response` 与
`/tool-approval-response` 已存在，live slot 是合法 slotKey，天然可回传。

### 改动 B（前端渲染）

位置：`frontend/src/features/live-sessions/LiveSessionPage.tsx`。

在页面根部挂已有、零修改的两个组件：

```tsx
<ExtensionUiModal />
<ToolApprovalModal />
```

两者订阅全局 `chatSlice`，按 `req.slot`（= live slotKey）自动工作；全局 WS
（`useWebSocket` 在 App 层常驻）把 A 广播的 frame 写入 `chatSlice`，modal 即弹出。

### 改动 C（可选，工具审批开关）

位置：`backend/live-sessions/launcher.ts`。

`createSlot` 补 `toolApproval: resolveToolApproval(...)`；不补则保持现状（默认 OFF），
第一版只覆盖 extension UI，进一步收窄改动面。

## 5. 文件级变更清单

```text
backend/live-sessions/launcher.ts                修改（接线 extension_ui / tool_approval）
backend/server.ts                                 修改（抽取 wireLiveInteractionEvents，可选）
frontend/src/features/live-sessions/LiveSessionPage.tsx  修改（挂两个 modal）
docs/live-session-option-interaction-prd.md      新增（本 PRD）
```

## 6. 验收标准

1. `POST /api/live-sessions/start` 起 live 会话，触发表单/选择类交互，LiveSession 页面弹出
   `ExtensionUiModal`，点选项后 Agent 收到值并继续，无 60s 超时。
2. （若做 C）触达需审批工具，弹出 `ToolApprovalModal`，approve / deny / edit 均生效。
3. 普通 ChatPage 的 modal 行为零回归（同一全局 store，slot 隔离）。
4. 前端 TypeScript / Vite build、后端相关测试通过。

## 7. 风险与待验证假设

- 假设 live slot 底层 uiContext 注入对其生效（launcher 已用 `transport: 'rpc'`，符合预期，
  但需在改动 A 前用最小 log 验证 `extension_ui` 确实 emit）。
- live slot 可能同时以 `PI_RUNTIME=live` 注册进 livesession registry，需实测确认 A 的全局
  WS 广播不会与 livesession WS 重复渲染（两个通道、两个页面，预计不冲突）。
- 如需覆盖「外部 TUI 进程」的选项，须 pi 本体暴露 `extension_ui` 事件或另做 uiContext 桥接，
  本 PRD 明确不纳入。