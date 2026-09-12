# Live Session 多端对齐（统一输入模型）— Tech Design

- **状态**：Proposed（已按 review 重写）
- **涉及仓库**：`/mnt/workspace/lilong/repos/pi-dashboard`、`/mnt/workspace/lilong/repos/pi-tsien-extension`、移动端（新增）
- **信任模型**：内网；**不对多端做端口级权限分级**，能力对齐优先。
- **核心结论**：多端同步的骨架（事件广播 + FIFO）已存在，唯一要做的本质改动是把「输入」收敛成**一种**，和 TUI 完全等价。

## 1. 第一性原理

Pi 处理输入只有一种形式（SDK `agent-session.d.ts` L408–412）：

> `sendUserMessage(text, { expandPromptTemplates, deliverAs })`
> `expandPromptTemplates` = **dispatch extension commands + expand skill commands + expand prompt templates**。默认 `false`。

`/clear`、`/goal`、skill 名、"帮我重构代码"……对 Pi 来说**都是「一段文本」**，由 `expandPromptTemplates` 决定是否展开成命令/skill。TUI 和 Web 的区别只是「谁在界面」，不是「输入的不同种类」。

因此多端对齐的**最直接实现**是：让所有端口都只发原始文本，`expandPromptTemplates` 恒为 `true`，与 TUI 输入逐字等价。**不做「命令 vs 消息」分层。**

## 2. 目标 / 非目标

### 目标
1. 输入能力完全等价：TUI 能敲的任何文本（消息、`/命令`、skill、template），Web/手机都能发，进同一 FIFO，行为一致。
2. 输出内容一致、显示适配：同一事件流广播给所有端口，各自渲染。
3. `mobile` 输入通道 + 手机 app 接入协议。

### 非目标
1. 不做多端「各自独立输入队列」——保持单一 FIFO（这是「同一个 session」的语义）。
2. 不做像素级同屏（那是 tmux 字节层，无关）。
3. 不重做认证体系——沿用 broker token + 浏览器 cookie，手机另加 app-token（§7）。
4. 本阶段不完成手机 app 全功能，只定接入协议与渲染契约。

## 3. 统一输入模型（核心）

### 3.1 命令收敛

现有多套「文本输入」命令收敛为一个 `input`：

| 移除（现状） | 收敛为（统一后） |
|---|---|
| `prompt`（`expandPromptTemplates: false` 硬编码） | `input`（等价 TUI，恒 `true`） |
| `compact`（需 lease） | `input { text: "/compact" }` |
| `clear`（需 lease） | `input { text: "/clear" }` |
| `reload` | `input { text: "/reload" }` |
| `set_model` | `input { text: "/model <provider>/<id>" }` |
| `set_thinking_level` | `input { text: "/thinking <level>" }` |

保留（非「文本输入」，属并发协调 / UI 元数据）：

```text
claim / renew / release / abort / get_models / set_session_name / feature_command / resync
```

### 3.2 协议变更

`shared/src/live-sessions.ts` + `pi-tsien-extension/extensions/live-session/protocol.ts`：

```ts
export type LiveSessionInputChannel = 'web' | 'terminal' | 'chatapp' | 'mobile'

export type LiveSessionCommand =
  | { type: 'resync' }
  | { type: 'claim'; browserClientId: string; requestedLeaseMs: number }
  | { type: 'renew'; leaseId: string }
  | { type: 'release'; leaseId: string }
  | {
      type: 'input'
      text: string
      images?: LiveSessionImage[]
      channel: LiveSessionInputChannel
      /** running 时缺省 = followUp，等价 TUI 运行中继续输入会排队 */
      deliverAs?: 'steer' | 'followUp'
    }
  | { type: 'abort'; leaseId: string }
  | { type: 'get_models' }
  | { type: 'set_session_name'; name: string }
  | { type: 'feature_command'; leaseId: string; feature: 'btw'; command: { type: 'open' | 'close' } }

// 不再出现 expandPromptTemplates 字段：extension 端对 input 恒按 true 处理。
```

删掉的 `prompt/compact/clear/reload/set_model/set_thinking_level` 不再作为命令类型存在。

### 3.3 Extension 侧变化

`extensions/live-session.ts` dispatch（原 L277–342）：

```ts
// 旧：prompt 硬编码 expandPromptTemplates: false；compact/clear/reload/… 各自分支
// 新：统一 enqueueInput，展开命令恒 true
if (command.type === 'input') {
  // running 且未显式指定交付方式时，默认 followUp 排队（等价 TUI 运行中继续输入）
  const deliverAs = command.deliverAs ?? (!ctx.isIdle() ? 'followUp' : undefined)
  enqueueInput({
    channel: command.channel,
    text: command.text,
    ...(command.images?.length ? { images: ... } : {}),
    ...(deliverAs ? { deliverAs } : {}),
    expandPromptTemplates: true,          // 对齐 TUI
  })
  return { ok: true, result: { accepted: true } }
}
```

- `drainInputQueue` 里 `pi.sendUserMessage(content, { deliverAs, expandPromptTemplates })` 不变。
- TUI 的 `pi.on("input")`（L473）已经 `expandPromptTemplates: true`，**无需改动**。
- removed 分支里 `compact/clear` 的 `lease.assertLease` 不再需要——因为 `/clear` 现在和 TUI 一样只是文本输入，TUI 敲 `/clear` 也不需要 lease（见 §4）。

### 3.4 关键语义（review 修正）

1. **命令/skill 直接派发，绕过 tool approval**：`expandPromptTemplates: true` 会直接 dispatch extension commands + expand skill/template，**不经 agent 的 tool approval**。这是对齐 TUI 的本意（TUI 敲命令同样直接执行），多端协议**不再额外加权限闸门**。安全归口 =「能连上这个内网 session 的端，就是可信操作方」。
2. **running 交付**：`input` 缺省 `deliverAs` 时不报错，而按 `followUp` 排队（等价 TUI 运行中继续输入）；需要打断则显式 `deliverAs: 'steer'`。
3. **无兼容性回归**：统一后 Web 端获得与 TUI 完全一致的输入能力；普通消息正常发，`/xxx` 即命令——和 TUI 一样，无需指令/命令二分。

## 4. 并发协调（多端共存机制）

这是「同一串行输入点」的自然约束，**不是权限分级**：

1. **单一 FIFO**：所有端共享 `inputQueue`，同一时刻一个 `activeInput`。
2. **claim 租约**：多端同时「独占打字」时用 claim 归因「谁正在控制」；任何端都能 claim，claim 不影响能力。
3. **abort 保留 lease 语义**：`abort` 仍需 lease（中断当前执行是强操作，需明确归属）。
4. **channel 归因**：`input.channel` 用于输出侧标注来源并对审计可见。

## 5. 多端输出：事件流 + 渲染契约

输出层无需大改：broker 已广播 `snapshot + events`。各端只是同一数据的渲染器：

| 端口 | 渲染 |
|---|---|
| TUI | 原生字符（现状） |
| Web | `LiveSessionPage` 组件树（现状） |
| 手机 app | 原生 UI 消费同一 `LiveSessionBrowserEvent` |

### 5.1 channel 归因补字段（review 修正）

现状 `channel` 只在 `input` 命令（输入侧）。要在输出侧体现「这条来自 web/mobile」，需在扩展投影用户输入事件时附带 `channel`：

```text
改动：pi-tsien-extension projector / event → 用户 message 事件带上 channel 字段
```

前端/手机据此显示来源标签（`[web]` / `[mobile]`）。

## 6. 手机 app 接入

手机 app = 又一个输出端口 + 输入通道：

1. **认证（独立新增）**：浏览器用 HttpOnly cookie + SameSite 不适用于原生 app。手机端新增 **app-token**：用 `live-control-token` 换取一个长期 app 凭证，存入 Keychain/Keystore，后续请求携带。
2. **订阅输出**：连 `wss://<host>/api/live-sessions/ws`，接收 `snapshot + events`，原生渲染。
3. **发送输入**：`POST /api/live-sessions/:processInstanceId/commands`，`{ type: "input", text, channel: "mobile" }`。
4. **控制**：`claim/renew/release`、`abort` 照常。

渲染契约 = 现有 browser 事件类型，各端按自己 UI 映射（消息气泡 / thinking 折叠 / tool 卡片）。

## 7. 改动清单

### `pi-tsien-extension`

```text
extensions/live-session/protocol.ts   修改（input 命令、mobile channel、删 prompt/compact/clear/reload/set_model/set_thinking）
extensions/live-session.ts            修改（dispatch 统一 input，expandPromptTemplates 恒 true，running 兜底 followUp）
extensions/live-session/projector.ts  修改（用户输入事件附带 channel）
```

### `pi-dashboard`

```text
shared/src/live-sessions.ts            修改（命令类型 + mobile channel）
backend/live-sessions/protocol.ts      修改（parse input + 删除旧命令 schema）
backend/routes/live-sessions.ts        修改（commands 入口放行 input）
backend/live-sessions/auth.ts          修改/新增（app-token 认证路径，可选）
frontend/src/features/live-sessions/*  修改（输入框直接发 input 文本；常用命令快捷按钮）
```

### 移动端（新增）

```text
mobile/...                             新增（app-token 认证、WS 订阅、事件渲染、input 发送）
```

## 8. 实施阶段

- **M1 统一输入（核心）**：协议 + extension 收敛 `input`、`expandPromptTemplates` 恒 true、删旧命令、`mobile` channel。**退出条件**：Web 发 `input "/goal"` / `"/clear"` / skill 名，行为与 TUI 逐字一致。
- **M2 dashboard 前端**：输入框对齐（`input` 文本）+ 常用命令按钮（自动敲 `/compact` `/clear` `/goal` `/reload` 文本）。
- **M3 channel 归因 + 手机骨架**：projector 带 channel；手机 app-token 认证、WS 订阅、最小渲染、input 发送。
- **M4 验证**：三端同 session 冒烟、写/提交/发布对齐验证、README。

## 9. 验收标准

1. 同一 session，TUI 输 `/clear` `/goal` skill 名，Web/手机收到对应**内容事件**并各自渲染。
2. Web/手机发相同文本/命令，TUI 与其它端实时可见，行为与 TUI 输入一致。
3. agent 执行写/提交/发布时，多端看到同一工具事件，tool approval / 命令派发行为一致。
4. running 时 `input` 缺省 followUp 排队，不报 `deliver_as_required`。
5. `mobile` channel 输入在输出侧正确归因。
6. 不破坏 `abort/claim/renew/release` 语义与租约。
7. 现有 backend / extension 测试 + 三端冒烟通过。

## 10. 关键决策

1. **统一输入模型**：一个 `input` 文本流，`expandPromptTemplates` 恒 true，等价 TUI；废弃结构化文本命令。
2. **命令/skill 直接派发，不经 tool approval**：如实接受这是「对齐 TUI」的语义，不再额外加权限闸门。
3. **只保留非文本命令**：`claim/renew/release`、`abort`、`get_models`、`set_session_name`、`feature_command`。
4. **单一 FIFO + claim 并发协调**：claim 是「谁在打字」的防打架机制，不是权限分级。
5. **手机认证独立新增**：app-token + 安全存储，不复用浏览器 cookie 语义。
6. **输出按端口渲染，协议零新增**（除 channel 归因字段）。

## 11. review 修正对照

| review 问题 | 处置 |
|---|---|
| P0-1「安全归口 tool approval」表述错误 | §3.4 如实写「命令/skill 直接派发，不经 tool approval」 |
| P0-2 lease 绕过冲突 | §3.1/§3.3 删掉 compact/clear 等显式命令，冲突消除 |
| P1-1 running deliverAs 未设计 | §3.2/§3.4 缺省 followUp 排队 |
| P1-2 手机认证不复用 cookie | §6.1 明确新增 app-token |
| P2-1 输出 channel 归因缺失 | §5.1 补 projector 带 channel |
| P2-2 缺省 true 兼容性回归 | §3.4 说明无回归，Web 获得完整输入能力 |