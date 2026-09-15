# Extension UI 请求多通道（Multi-Channel UI Request）— Tech Design

- **状态**：已实现并完成端到端验证（commit 映射见 §8，实测 follow-on 问题见 §11，部署交接见 §12）
- **涉及仓库**：`/mnt/workspace/lilong/repos/pi-upstream`（L0）、`/mnt/workspace/lilong/repos/pi-tsien-extension`（L1）、`/mnt/workspace/lilong/repos/pi-dashboard`（L2）
- **依赖版本**：`@earendil-works/pi-coding-agent >= 0.84.2`（L0 需新版本）
- **关联设计**：`live-session-multi-endpoint-tech-design.md`（统一输入模型）；本文是其「UI 输出/应答侧」的补充，同时修正输入侧的 activeInput 缺陷。

## 1. 第一性原理

### 1.1 选项是「会话级事务」，不是「模式私产」

`ctx.ui.select/confirm/input/editor` 只做一件事：**agent 需要从有限集合里取一个值**（请求 → 应答）。

这个事务现今被错误地归「模式」所有：

| 模式 | 现状实现 | 位置 |
|---|---|---|
| TUI | `showExtensionSelector/Confirm/Input/Editor` 私有 overlay | `interactive-mode.ts` |
| RPC | `createDialogPromise` → `extension_ui_request/response` | `rpc-mode.ts` |

因此，一个 TUI 进程里的选项，web live session / 其他 channel 既看不到、也答不了——这是问题 1 的根因。

**正确归属**：选项事务属于**会话（runner）**；TUI / RPC / live-session 只是「能看到并回答」的**平级渠道**。

### 1.2 与「统一输入模型」的关系

`live-session-multi-endpoint-tech-design.md` 已确立输入侧第一性原理：**Pi 只有一种输入（文本），`expandPromptTemplates` 恒 true，不做「命令 vs 消息」分层**。

本文确立输出/应答侧的对称原理：**Pi 的 UI 请求也只有一种（带 id 的请求），应答走「第一个应答者胜出」，不做「按模式分流」**。

两者合起来，就是「会话级多渠道 I/O 总线」的两半：输入收敛为一种 text，UI 请求收敛为一种 request。

## 2. 目标 / 非目标

### 目标
1. 任何 extension 发起的 UI 请求（confirm/select/input/editor），能被任意数量的 channel（TUI overlay、RPC、live-session extension）同时看到。
2. 任一 channel 应答（`respondUi(id, value)`）即 resolve 该请求，其余 channel 收到「已关闭」并撤销渲染。
3. 不破坏现有 RPC extension UI 语义（dashboard 已实现的 `extension_ui_request/response`）。

### 非目标
1. 不做 channel 优先级 / 责任链——不做「谁优先答」，只做「第一个答的赢」。
2. 不改 tool approval（仍 SDK-only，与本设计正交）。
3. 不改输入侧的「统一 input 文本」模型（那是 multi-endpoint 的事，本文只修其 activeInput 缺陷）。

## 3. 总体架构

```
extension 调 ctx.ui.select(title, options)
        │
        ▼
┌────────────────────────────────────────────────────────┐
│ ExtensionRunner（会话级 UI 请求总线）                     │
│  requestUi(method, params) → id                          │
│  · emit "extension_ui" 事件（可被 extension 监听）        │
│  · 挂起 Promise<value|undefined>                          │
│  · respondUi(id, value/cancelled) → resolve + 广播取消    │
└───────┬──────────────────┬───────────────┬───────────────┘
        │                  │               │
   [TUI overlay]      [RPC transport]  [live-session extension]
   渲染 → 应答         渲染 → 应答       投影 → web 渲染 → 应答
```

## 4. L0 — pi 核心（pi-upstream）

### 4.1 事件与 API

`packages/coding-agent/src/core/extensions/types.ts`：

```ts
// ExtensionEvent union 增加：
export interface ExtensionUiRequestEvent {
  type: "extension_ui";
  id: string;
  method: "confirm" | "select" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  prefill?: string;
  placeholder?: string;
}

// ExtensionAPI 增加：
on(event: "extension_ui", handler: ExtensionHandler<ExtensionUiRequestEvent>): void;
respondExtensionUi(id: string, response: { value?: any; cancelled?: boolean }): boolean;
```

### 4.2 Runner 挂起表

`packages/coding-agent/src/core/extensions/runner.ts`：

```ts
private pendingUi = new Map<string, {
  resolve: (v: any) => void;
  // emit 之后由各 channel 渲染；首个 respondUi 胜出
}>();

requestUi(method, params): Promise<any>  // 生成 id → emit "extension_ui" → 挂起
respondUi(id, response): boolean         // resolve + 从 pendingUi 删除 + emit "extension_ui_cancelled"(或复用同事件 closed 标记)
```

不变量（单测锚点）：
1. 一个 id 只 resolve 一次。
2. 首个 `respondUi` 生效，后续 respond 返回 `false`。
3. 超时 / `opts.signal.abort` → resolve 默认值（confirm=false，其余 undefined）。
4. 所有 channel 在 resolve 后收到关闭通知。

### 4.3 TUI 通道改造

`interactive-mode.ts`：`showExtensionSelector/Confirm/Input/Editor` 不再「自己起 Promise」，改为：

- 监听 runner 的 `extension_ui` 事件 → 渲染 overlay
- 用户选择/取消 → 调 `respondUi(id, ...)`

这样 TUI overlay 从「唯一渲染者」退化为「渠道之一」。

### 4.4 RPC 通道改造

`rpc-mode.ts`：`createDialogPromise` 改为复用 `/ 兼容` runner.requestUi，RPC 的 `extension_ui_request/response` 作为 RPC 通道继续工作（保持 dashboard 现有行为不变）。

## 5. L1 — live-session 桥接（pi-tsien-extension）

`extensions/live-session.ts`：

1. 监听 `pi.on("extension_ui")` → `publish("extension_ui", { id, method, title, message, options, ... }, ctx)`，把 UI 请求投影进 livesession event 流。
2. 新增命令处理 `answer_ui`（来自 broker/browser）→ `pi.respondExtensionUi(id, { value/cancelled })`。
3. `extension_ui` 的关闭（首答胜出）也投影成一个「closed」事件，让 web 端点掉尚在渲染的 option。

## 6. L2 — 协议 + 前端（pi-dashboard）

### 6.1 协议

`shared/src/live-sessions.ts` + `backend/live-sessions/protocol.ts`：

```ts
// event 流新增（由 L1 投影）：
//   { type: "extension_ui", data: { id, method, title, message, options, prefill, placeholder } }
//   { type: "extension_ui_closed", data: { id } }

// LiveSessionCommand 新增：
export type LiveSessionCommand =
  | ...现有...
  | { type: "answer_ui"; id: string; value?: string; cancelled?: boolean }
```

### 6.2 前端

`LiveSessionPage.tsx`：新增 option 渲染组件（复用 `ExtensionUiModal` 的视觉/交互），订阅 livesession event 流中的 `extension_ui`，用户选择后 `POST .../commands { type:"answer_ui", id, value|cancelled }`。

## 7. 问题 2 修复（输入侧 activeInput 缺陷）

### 7.1 根因

`extensions/live-session.ts` 的 `drainInputQueue` 用 `activeInput` 阻塞，且只在 `message_end` 且 `role === "user"` 时释放。slash command（`/effort`）经 `expandPromptTemplates: true` 派发后**不产生 user 角色 `message_end`**，导致 `activeInput` 永不释放，后续 TUI 输入被 `if (activeInput) return` 卡死；reload 触发 `clearInputQueue` 才恢复。

### 7.2 最终修复（已实施，方向 B 的修正形态）

实施时发现根因有两层递进：

1. 第一版修复（`123edac`）把释放信号换成 `agent_end`——但实测仍卡死：pi 的 `prompt()` 对扩展命令（`text.startsWith("/")` 且命中 runner `getCommand`）在 `_tryExecuteExtensionCommand` 后**直接 return，不产生任何 agent turn / `agent_end`**（`agent-session.ts` prompt 开头）。即「纯命令输入」没有任何 turn 事件可挂钩。
2. 最终修复（`81eb249`）：释放信号改为**本次 `sendUserMessage` 的 promise settle**——模型路径下 `_runAgentPrompt` 会 `await agent.prompt()` 到整轮结束；命令路径在命令 handler（含其 await 的 UI 对话框，web/TUI 应答后才返回）完成后即 resolve。两种路径都恰好对应「这次派发真正结束」。`agent_end` 仅保留为 publish 投影，不再承担队列释放。

> 方向 A（移除 activeInput、全靠 pi deliverAs 串行）未采用：`prompt()` 在设置 `isStreaming` 前有多个 await（输入处理/模板展开/鉴权），背靠背 `sendUserMessage` 可能双双进入 direct 路径并发起跑 turn，不满足串行语义。

## 8. 实施阶段

```text
L0  pi 核心 UI 请求总线 + TUI/RPC 通道改造 + 单测（首答胜出 / 超时 / abort / 多通道关闭）
L1  live-session extension：监听 extension_ui + answer_ui 命令 + closed 投影
L2  pi-dashboard：协议 answer_ui/closed + LiveSession 渲染 + 应答回传
M-输入  问题 2 修复（activeInput）——可与 L0 并行，单仓库、可先止血
```

**实施结果（全部完成，单测 + 用户 E2E 验证通过）**：

| 层 | 仓库 / 分支 | commit | 内容 |
|---|---|---|---|
| L0 | pi-upstream `feat/tsien` | `451342e` `2e88f08` | 多通道 UI 请求总线 + `extension_ui_notify` 单向通知事件 |
| L1 | pi-tsien-extension `main` | `24928b9` `4e5f38b` `81eb249` | notify 投影、`answer_ui` 协议解析、队列按「派发结束」释放 |
| L2 | pi-dashboard `master` | `244a6e0` `e445046` `d429c82` `f95ac94` `6d1863e` | 协议+弹窗、通知横幅、`answer_ui` 白名单、会话持久化、快捷键崩溃防御 |
| M-输入 | pi-tsien-extension `main` | `123edac` → 被 `81eb249` 取代 | 问题 2 修复（最终形态见 §7.2） |

## 9. 验收标准

1. TUI 进程里 extension 弹 select/confirm，dashboard LiveSession 页面实时看到同一 option。
2. 在 web 点选 → TUI overlay 关闭、extension 收到值、后续输入不再卡死；在 TUI 点选 → web option 关闭。
3. 同一请求只被 resolve 一次，双端竞态下「首个应答胜出」成立。
4. 现有 dashboard RPC `extension_ui_request/response` 行为零回归。
5. 问题 2 修复后：TUI 连续输入（含 `/effort`）不再需要 reload。
6. pi 本体 L0 单测 + pi-tsien-extension + pi-dashboard 三仓测试通过。

> **验收结果**：全部通过。L1 `test/live-session.test.ts` 13/13、L2 后端 `backend/__tests__/live-session.test.js` 15/15；用户实测「TUI 弹选项 → web 应答 → 双端关闭 → 后续输入正常」。

## 10. 关键决策与风险

1. **首个应答胜出，无优先级**：UI 请求是「一请求一应答」事务，不引入 channel 优先级概念。
2. **L0 需 pi 包发布**：`pi-upstream` 改动必须发新版 `@earendil-works/pi-coding-agent`，pi-dashboard / pi-tsien-extension 才能用；这是唯一强外部依赖。
3. **TUI 通道改造有回归面**：`interactive-mode` 的 overlay 有较复杂生命周期（focus/editorContainer/abort），改造需配套现有 TUI 测试。
4. **activeInput 方向 A 依赖 pi 串行语义**：需在实施前用连续输入冒烟证明 pi 会按序 deliver；若否，退回方向 B。

## 11. 实测发现并修复的 follow-on 问题

L0-L2 首版上线后实测依次暴露以下问题，均已修复：

1. **notify 不投影**：`/goal` 等命令用 `ctx.ui.notify`（单向、无应答）打印选项/状态，根本不在 UI 请求总线上 → web 看不到。修复：L0 新增 `extension_ui_notify` 事件（`451342e`），L1 投影（`24928b9`），L2 渲染「扩展通知」横幅（`e445046`）。
2. **web 应答 400**：`answer_ui` 漏加进 `backend/live-sessions/registry.ts` 的浏览器指令白名单（`d429c82`）。
3. **web 应答 500**：L1 `live-session/protocol.ts` 的 `parseCommand` 没有 `answer_ui` 分支 → 无法解析 → client 销毁 socket（`client.ts` 对任何无法解析的 broker 消息都断连）→ pending dispatch 以传输错误 reject → 路由兜底 500。修复 `4e5f38b`。**遗留加固点**：无法解析的命令应回 `failure(unsupported_command)` 而不是断连（版本漂移时断连会把整个会话拖死）。
4. **应答后输入卡死**：即 §7.2 的最终根因（`81eb249`）。
5. **401 反复登出挡输入**：live-session 浏览器会话是内存 Map，dashboard 后端一重启即失效 → cookie 不再解析 → 所有 `/api/live-sessions/*` 401 → 前端弹登录框挡输入。修复：会话持久化到 `<tokenPath>.sessions.json`（0o600，与 token 同级安全），重启时重新加载（`f95ac94`）。
6. **`toLowerCase` 崩溃**：全局快捷键监听收到无 `key` 的 keydown（代理/自动化层发的非标准事件），`matchEvent` 防御性跳过（`6d1863e`）。该崩溃在 bubble 阶段，不挡输入，属噪音。

## 12. 部署与交接

- **TUI 加载方式**：`~/.pi/agent/settings.json` 直接引用仓库路径 `/mnt/workspace/lilong/repos/pi-tsien-extension/extensions/live-session.ts`，改完**重启 TUI（或 `/reload`）即生效**，无需拷贝。
- **pi 本体**：L0 改动在 pi-upstream `feat/tsien` 分支（**不推远端**），本地发布 tarball 在 `~/pi-lical-dist/`；pi-dashboard 通过 `package.json` 的 `file:` + `overrides` 引用这些 tarball（**package.json/lock 是本地链接，不提交**）。上游同步流程：`git fetch` → `feat/tsien` rebase `origin/main` → `release:local --skip-check --skip-test` 重打 tarball → 消费方重装。
- **dashboard 生效方式**：`./run.sh`（构建前端 + 重启后端；由用户执行）。
- **测试入口**：L1 `node --import tsx --test test/live-session.test.ts`；L2 后端 `npx vitest run --config vitest.backend.config.js`。