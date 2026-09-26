# Web 共享终端（tmux 中继）— Tech Design

- **状态**：Proposed（待评审）
- **主仓库**：`<pi-dashboard repo>`
- **PRD**：`docs/web-terminal-tmux-prd.md`
- **运行环境**：与本机 Pi TUI 同一 Linux 用户、同一台机器
- **依赖**：`tmux >= 3.2`、`node-pty`（根 `package.json` 已装）、`ws`（已装）、`@xterm/xterm@6` + `addon-fit/unicode11/web-fonts/web-links`（`frontend/package.json` 已装）

## 1. 背景

当前 Dashboard 的 slot 全部通过 `pi --mode rpc` 以 headless 方式运行（`backend/pi-manager.ts`），没有屏幕；本机 TUI 是一个独立派生的 `pi` 进程。两者 stdin/stdout 互不相通，因此「Web 输入 → 本机 TUI 实时显示」无法实现。

`backend/pty-manager.ts` 已有一段基于 `node-pty` 的终端实现，但 `handlePtyConnection` 未被任何模块 import/调用，属于孤儿代码；`server.ts` 的 WebSocket upgrade 也只放行 `/api/ws` 和 live-session 路径，其余一律 `socket.destroy()`。前端 `@xterm` 已安装但无任何组件接线。

## 2. 目标

1. Web 提供真实终端渲染与输入（xterm.js）。
2. Web 与本机 `tmux attach` 看到/操作的是**同一个 tmux pane**，即同一个 Pi TUI 进程。
3. Web 断开只 detach，不杀会话；Dashboard 重启不杀会话。
4. 复用 live-session 认证，不裸暴露 `/api/pty`。
5. 不修改 Pi Core。

## 3. 非目标

- 不改 slot 的 `--mode rpc` 语义，不把 headless slot 变成 TUI。
- 不做任意机器远程 shell，不自动发现/接管 `pi-dash-*` 之外的 tmux session。
- 不做多用户协作锁 / 只读旁观（v1 单用户信任模型）。
- 不做 tmux copy-mode 历史与浏览器滚动缓冲的打通。

## 4. 方案选型

| 方案 | 机制 | 结论 |
|---|---|---|
| **A. tmux 中继** | 真实 TUI 跑在 tmux；本机 `tmux attach`、Web 通过 node-pty spawn `tmux attach` 转发字节流 | ✅ 采用 |
| B. Dashboard 当 PTY 宿主 + 本机反向 attach（ttyd/ssh 形态） | node-pty 直接起 TUI，本机反连 | 本机退化为 attach 客户端，违背「本机为主」体验，弃用 |
| C. 语义层同步（Extension 注入） | Web 通过 RPC 发消息，TUI 订阅 feed 渲染 | 侵入 Pi Core，且无法逐字节同屏，弃用 |

**选 A 的理由**：Pi Core 零改动；逐字节同屏；复用成熟工具（tmux 3.2a 已装）；代码全部落在 pi-dashboard 仓库内。

## 5. 语义澄清（重要）

tmux pane 里跑什么，Web 敲的键就是什么：

- pane 里是 `pi`（TUI）→ Web 敲的键进入 Pi 的输入队列（对话消息、Pi 命令，如 `/compact`、`/clear`）。
- pane 里是 `/bin/bash` → Web 敲的是 shell 命令。

本设计**只做「终端字节流镜像 + stdin 注入」**，不关心也不解析 pane 里是什么程序。是否「能跑 shell 命令」完全取决于该 tmux session 里启动的是什么，与 Dashboard 无关。

## 6. 总体架构

```text
 本机终端 (iTerm2/kitty)                  浏览器 (xterm.js)
        │  tmux attach -t <name>                │  WebSocket /api/pty?session=<name>
        │                                       │
        └──────────────┬────────────────────────┘
                       ▼
        ┌──────────────────────────────────────────┐
        │             tmux server                     │
        │  session: pi-dash-<name>                    │
        │    └─ pane: pi  (唯一事实来源 / 真实 TUI)     │
        └──────────────────────────────────────────┘
                       ▲
                       │  node-pty spawn "tmux attach -t <name>"
        ┌──────────────┴──────────────────────────┐
        │  pi-dashboard backend                     │
        │  pty-manager (改造)  ── stdout/onData ──▶ WS │
        │  WS stdin ──▶ proc.write()                 │
        └──────────────────────────────────────────┘
```

- 唯一的「真实会话」是 tmux 里的 `pi` pane。
- 本机终端与 Web 都是该 pane 的 attach 客户端；tmux 原生支持多客户端共享同一 pane。
- Dashboard 与 tmux 解耦：Dashboard 挂掉，tmux session 与 TUI 不受影响。

## 7. 组件设计

### 7.1 `backend/pty-manager.ts`（改造）

现有 `handlePtyConnection` 改为「tmux attach 转发」，核心变化：

```ts
// 旧：pty.spawn(shell, ['-l'], { cwd })
// 新：
const name = sanitizeTmuxSession(params.get('session') || '')
const proc = pty.spawn('tmux', ['attach', '-t', name], {
  name: 'xterm-256color',
  cols, rows,
  env: { ...process.env, TERM: 'xterm-256color' },
})
```

语义要求：

1. `session` 参数必须匹配 `^pi-dash-[A-Za-z0-9_-]{1,64}$`，否则拒绝（防路径注入/scope 越界）。
2. `proc.onData` → `ws.send(data)`（原始终端字节，推荐二进制 frame，见 §8）。
3. `proc.onExit` → 只清理 `shells` map + 关闭 ws；**不得 kill tmux session**（session 独立存活）。
4. `ws.on('close')` → `proc.kill()`（杀掉 `tmux attach` 客户端进程 = detach，不杀 session）。
5. `resize` 仍走 JSON `{ type: 'resize', cols, rows }` → `proc.resize`，tmux 会同步 pane 最小尺寸。

> **detach 语义**：`tmux attach` 是客户端进程；kill 该进程即「本客户端脱离」，tmux server/session/pane 继续存活。这是本方案的基石，任何时刻都不能 kill tmux server 或 session 本身。

### 7.2 `backend/server.ts`（接线）

在 `upgrade` handler（当前 `backend/server.ts` L896 附近）中，于 `liveSessionRoutes?.handleUpgrade(...)` 之后、`/api/ws` 分支之前/并列增加：

```ts
if (wsPath === '/api/pty') {
  if (!ptyAuth.isOriginAllowed(req, true) || !ptyAuth.getIdentity(req)) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, ws => handlePtyConnection(ws, req))
  return
}
```

> 注意：不能复用 `handlePtyConnection` 现有的 `req.url` 解析为 `http:` 的旧写法；改用 `new URL(req.url, 'http://localhost')` 取 `searchParams`。

### 7.3 认证（复用 live-session 认证）

`backend/live-sessions/auth.ts` 已有 `LiveSessionBrowserAuth`：

- token 文件 `~/.pi/agent/run/pi-dashboard/live-control-token`（mode 0600）；
- HttpOnly cookie `pi_live_session`（`SameSite=Strict`，HTTPS 下 `Secure`）；
- `isOriginAllowed(request, requireOrigin, identity)` 含 DSW gateway origin 判定；
- `getIdentity(request)` 校验 cookie 返回浏览器身份。

`/api/pty` upgrade 前必须同时满足 origin 允许且存在有效 identity，否则 `socket.destroy()`。不需要新增第二套 token；沿用 live-session 已建立的认证面。

**影响**：若用户从未在 Settings 输入 `live-control-token`，则终端不可用。这是 v1 有意的安全取舍（认证门，见 PRD NFR-1）。

### 7.4 tmux 会话生命周期管理

新增 `backend/tmux-sessions.ts`（薄封装，shell out `tmux`）：

- `create(name)`：`tmux new-session -d -s pi-dash-<name> pi`（可选 `--tui-mode` / 指定 cwd）。
- `has(name)`：`tmux has-session -t pi-dash-<name>`。
- `list()`：`tmux list-sessions -F '#{session_name}'`，只返回 `pi-dash-*`。
- `kill(name)`：`tmux kill-session -t pi-dash-<name>`（显式二次确认入口）。

REST 端点（复用 live-session 认证）：

```text
GET  /api/pty/sessions                     列出 pi-dash-* 会话
POST /api/pty/sessions  {name}             创建（不存在才建，存在则幂等返回 200）
DELETE /api/pty/sessions/:name              终止（二次确认由前端做）
```

命名空间硬约束：所有操作只接受 `pi-dash-*` 且经过 `sanitize`，杜绝 `tmux` 命令/参数注入（session 名不进 shell 字符串拼接，用 spawn argv）。

### 7.5 前端

新增文件（建议 `frontend/src/features/terminal/`）：

```text
frontend/src/features/terminal/TerminalPanel.tsx
frontend/src/features/terminal/usePtySocket.ts
frontend/src/features/terminal/api.ts
```

- `TerminalPanel.tsx`：创建 `@xterm/xterm` Terminal，加载 `addon-fit`、`addon-unicode11`、`addon-web-fonts`、`addon-web-links`；`Terminal.open()` 挂到容器；`onData` 把按键 write 到 WS；WS `onmessage` 把字节 `term.write()`。
- `usePtySocket.ts`：维护 `ws(s)://host/api/pty?session=<name>`，含断线重连（指数退避）、`binaryType` 设置、resize 防抖回调。
- `api.ts`：封装创建/列表/终止 REST。

接入点 `frontend/src/pages/ChatPage.tsx`：

- Panels 下拉（当前 L1139–1154 只渲染 Tree/Refs/Files）新增「🖥️ Terminal」项与 `showTerminal` state；
- 渲染 `<TerminalPanel />` 面板（与 Tree/Refs/Files 同布局体系）。

## 8. 协议

`/api/pty` WS 采用「二进制原始终端字节 + 少量 JSON 控制帧」：

- 服务端 → 客户端：`tmux attach` 的输出字节，`proc.onData` 原样转发（`BinaryType 'arraybuffer'`），保证含 8-bit/OSC 序列不乱码。
- 客户端 → 服务端：
  - 汉字/按键/粘贴等：原始字节（UTF-8 / 终端输入），直接 `proc.write(bytes)`；
  - resize：`{ "type": "resize", "cols": N, "rows": N }`（首字节 `{` 判定为 JSON）。

不设计额外的 RRPC 信封；控制类操作（创建/列表/终止会话）走 REST，不混入终端字节流。

## 9. 安全边界

1. `/api/pty` 与 `/api/pty/sessions` 全部走 live-session 认证（token + HttpOnly cookie + origin 校验）。
2. tmux session 名严格 `^pi-dash-[A-Za-z0-9_-]{1,64}$`；**spawn 一律用 argv 数组，禁止 shell 字符串拼接**。
3. 只 attach/kill `pi-dash-*` 命名空间，绝不触及其他 tmux session。
4. 终端输出与输入在日志中**不落盘**（不记录按键与屏幕字节，参照 live-session 的可观测性约束）。
5. 明确文档化「Web 终端 = 本机 TUI 的远程控制权」，未认证状态下面板不可用。

## 10. 重连与故障

- **Web 断线**：前端重连退避（500ms → 1s → 2s → 5s，上限 15s）；后端每次 upgrade 都是新 attach，旧 attach 由 `ws.on('close') → proc.kill()` detach。
- **Dashboard 重启**：tmux session 存活（独立于 Dashboard）；重连后 `has()` 校验，存在则重新 attach，否则前端提示会话已不存在。
- **tmux 崩溃 / session 被杀**：`proc.onExit` 关闭 ws，前端显示「会话已结束」，不自动重建（避免误起）。
- **多端 resize 冲突**：tmux 取所有 attach 客户端的最小 cols/rows；v1 接受，未来可评估独立大小。

## 11. 测试设计

### 后端单元

1. `sanitizeTmuxSession` 接受合法 `pi-dash-*`，拒绝 `..`、`;`、`|`、空格、`$(...)`、非 `pi-dash-` 前缀。
2. `tmux attach` 进程 kill ≠ kill session（`has()` 仍为 true）。
3. `/api/pty` 无身份/无 origin 时 `socket.destroy()`，不进入 `handlePtyConnection`。
4. 创建幂等：已存在时不报错。
5. `list()` 只返回 `pi-dash-*`，过滤用户自己的其他 tmux session。
6. `kill` 仅在 `pi-dash-*` 上生效。

### 前端单元

1. `usePtySocket` 正确发起 `/api/pty?session=` 连接并设置 `binaryType`。
2. `TerminalPanel` 的 `onData` → WS，WS 字节 → `term.write`。
3. resize 防抖后发送 JSON `{type:'resize'}`。
4. 断线重连状态与面板提示正确。

### 真实集成（mock，不发模型推理）

1. 创建 `pi-dash-test` 会话（pane 跑 `/bin/bash`，非 pi），本机 `tmux attach` 与 Web 同时 attach。
2. 本机敲 `echo hello`，Web 屏同步出现；Web 敲 `pwd`，本机屏同步出现。
3. Web 关闭面板后，本机 `tmux attach` 仍存活且可输入。
4. 杀 `pi-dash-test`，Web 显示「会话已结束」。
5. 换 pane 跑 `pi`（fixture，不触发模型），验证 TUI 字节流镜像（颜色/退格）正确。

## 12. 实施阶段

- **M1 安全门 + 管道**：认证/Origin 校验接入 `/api/pty`；改造 `pty-manager` 为 `tmux attach`；最小 `TerminalPanel` 打通回显闭环。**退出条件**：本机 `tmux attach` 与 Web 同屏双向实时。
- **M2 会话生命周期**：`tmux-sessions.ts` + REST 创建/列表/终止；前端会话选择与二次确认。**退出条件**：可建/附/离/停，隔离 `pi-dash-*`。
- **M3 体验**：resize 同步、重连恢复、滚动缓冲、空态/错误态。**退出条件**：PRD AC 全部满足。
- **M4 回归与文档**：README 操作说明、测试补齐、生产构建通过。

## 13. 文件级变更清单

```text
backend/pty-manager.ts                修改（spawn tmux attach、sanitize、detach 语义）
backend/tmux-sessions.ts              新增
backend/routes/pty.ts                 新增（REST 创建/列表/终止，复用认证）
backend/routes/index.ts               修改（挂载 pty 路由）
backend/server.ts                     修改（upgrade 放行 /api/pty + 认证）
backend/__tests__/pty-manager.test.js 新增
backend/__tests__/pty-routes.test.js  新增
frontend/src/features/terminal/TerminalPanel.tsx   新增
frontend/src/features/terminal/usePtySocket.ts     新增
frontend/src/features/terminal/api.ts              新增
frontend/src/pages/ChatPage.tsx       修改（Panels 增加 Terminal 项并渲染面板）
```

## 14. 验收标准

1. Web Panel 与 `tmux attach` 同屏，字节级一致（颜色、退格、滚动）。
2. Web 输入实时达 TUI、TUI 输出实时达 Web。
3. Web 断开/重连不杀 tmux session，重连回到当前屏幕。
4. 未认证浏览器无法连 `/api/pty`。
5. resize 同步且不错乱。
6. 只操作 `pi-dash-*` 命名空间，不触碰用户其他 tmux session。
7. Pi Core 零改动，现有 slot 回归通过。

## 15. 关键决策

1. **tmux 中继**：tmux pane 是唯一事实来源，本机与 Web 都是 attach 客户端。
2. **detach ≠ kill**：Web 断开只断客户端，永不杀 tmux session。
3. **Pi Core 零改动**：全部改动在 pi-dashboard，Pi 只作为 pane 内普通程序运行。
4. **复用 live-control-token 认证**：不为终端另造一套认证面。
5. **只管理 `pi-dash-*` 命名空间**：杜绝误接管用户其他 tmux。
6. **二进制原始终端字节**：不解析、不 JSON 包装输出，保证终端字节兼容。
7. **v1 单用户信任模型**：不做多人协作锁 / 只读旁观。
8. **创建与附加都支持**：Dashboard 既能 `tmux new` 一键创建 `pi-dash-*`（默认入口），也能 attach 用户已手动创建的同命名空间 session。
9. **Terminal 是独立入口**：不属于任何 headless slot，避免与 slot 的 kill/restart/restore 生命周期混淆。