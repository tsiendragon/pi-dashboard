# Plan: Live session 改为 tmux-first（web 与终端同一个 Pi）

- **状态**：Implemented（待人工验收拖动/attach）
- **主仓库**：`/mnt/workspace/lilong/repos/pi-dashboard`

用户拍板（2026-09）：
1. 新建 live session **默认 tmux-first**。
2. 复用 `pi-dash-` 命名空间前缀（这样 web 终端页面能直接列出来）。
3. 「关闭 session」= **kill tmux**。
4. 已存在的 RPC live session **不迁移**。

## 问题（改之前）

- `LivePiLauncher.start()` 走 `PiManager.ensureRunning()` → `spawn(node, pi, ['--mode','rpc', …])`，
  即 **live session 是 dashboard 的子进程**，而且 `persistSlots()` 只持久化 `manager.slots`、不含 `livePiManager.slots`。
  → dashboard 一重启，live session 直接消失，连 resume 都没有；终端也没有任何入口。
- 已有两块现成积木没用上：
  - 外部 Pi 自动注册：`pi-tsien-extension/extensions/live-session.ts:382` 只跳过 `PI_RUNTIME=dashboard` 与 print/json 模式，
    其余任何 Pi（含 tmux 里的 TUI）都会连 `~/.pi/agent/run/pi-dashboard/live-sessions.sock` 自动上 Live Pi 列表；
  - web 共享终端：`backend/tmux-sessions.ts` + `backend/routes/pty.ts` + `pty-manager.ts` + `features/terminal/`，
    按 `?session=<pi-dash-*>` attach，detach 不杀会话。

## 方案（已实现）

新建 live session = 在 tmux 里起一个真实 TUI Pi，dashboard 只是客户端：

```
tmux new-session -d -s pi-dash-live-<8hex> -c <canonicalCwd> \
  -e PI_RUNTIME=live -e TERM=xterm-256color -e PI_SLOT_KEY= … \
  <pi> [--model provider/id] [--thinking L] --name <title>
```

- 该 Pi 通过既有 bridge 自动注册 → Live Pi 列表/详情/输入/abort/rename/model/compact/answer_ui 全部复用现成链路。
- 终端 `tmux attach -t pi-dash-live-xxxx` 进的是同一个进程；web 终端页面按 `pi-dash-` 前缀直接列出它。
- dashboard 重启不动它（tmux server 持有）。
- 启动时等注册（默认 30s，可用 options 覆盖）；超时则 kill tmux 并报错，不留半启动的孤儿。
- tmux 名写进 live-session meta（key = pi `sessionId`，**只有 launcher 能写**，浏览器 PATCH 不接受该字段）。

## 顺带修掉的坑

1. `server.ts` 常驻 `process.env.PI_RUNTIME='dashboard'`，而 `createTmuxSession` 从 dashboard 起 tmux；
   tmux 已有 server 时新会话继承 **server 的环境**，没有 server 时继承 client 环境 —— 两种情况都可能让 pane 里的 Pi
   **跳过注册**。现在改为显式 `-e PI_RUNTIME=live`（并清空 `PI_SLOT_KEY` / `PI_DASH_BRIDGE_*`）。
2. `resolvePiCommand()` 新增并优先用 PATH 上的 `pi`：`PI_SCRIPT` 是 dashboard 自己的 `.js` 入口，pane shell 不能直接执行。
3. tmux 的 `new-session` 命令改为 **argv 逐参传递**（已实测 tmux 不做 shell 解析），标题含空格不再需要引号，也无法注入命令。

## 文件

- `backend/tmux-sessions.ts` — `createTmuxSession(name, {command,args,cwd,env})`、`tmuxPanePid()`、`resolvePiCommand()`。
- `backend/live-sessions/launcher.ts` — 重写为 tmux-first（可注入 create/kill/panePid/sleep，便于测试）。
- `backend/routes/live-sessions.ts` — `start` 成功后把 `tmux` 写入 meta。
- `backend/live-sessions/meta.ts` + `shared/src/live-sessions.ts` — `LiveSessionMeta.tmux?`。
- `backend/server.ts` — launcher 用 options 构造；删除已无用的 `_wireLiveInteraction`（RPC live slot 专线）。
- `frontend/src/features/live-sessions/LiveSessionsList.tsx` — 行上「🖥 终端」标记、`⋯ → ⧉ 复制终端命令`、`⋯ → ⏻ 关闭 session（kill tmux，两步确认）`。
- `frontend/src/features/live-sessions/api.ts` — `closeTmuxSession()`（复用 `DELETE /api/pty/sessions/:name`）。

## Verification

1. `cd frontend && npx vitest run src/test/liveSessionsSidebar.test.tsx`；后端 `npx vitest run --config vitest.backend.config.js`
2. `npm run typecheck` + `cd frontend && npx tsc --noEmit`
3. 冒烟：手工在 tmux 里起 `pi`（`PI_RUNTIME=live`），确认它出现在 Live Pi 列表
4. 浏览器人工验收：由用户执行 `./run.sh`（agent 不重启服务）

---

# As-built (2026-09)

已实现并实测。

## 结果

- 新建 live session = 在 `pi-dash-live-<8hex>` tmux 里跑真实 TUI Pi；dashboard 只是客户端。
- dashboard 重启/停止不再影响它（tmux server 持有）；终端 `tmux attach -t …` 与 web 看到的是同一个进程。
- 行上显示「🖥 终端」+ `⋯ → ⧉ 复制终端命令`；`⋯ →  关闭 session（kill tmux，两步确认）` → `DELETE /api/pty/sessions/<name>`。
- web 终端页面按 `pi-dash-` 前缀直接列出这些会话，不需新 UI。

## 实测证据（真实环境，非 mock）

在运行的 dashboard（broker + 既有 extension 未动）上，用与 launcher 完全相同的命令起了一次性 tmux 会话：

```
tmux new-session -d -s pi-dash-smoke1 -c <repo> -e PI_RUNTIME=live -e TERM=xterm-256color \
  -e PI_SLOT_KEY= -e PI_DASH_BRIDGE_SOCKET= -e PI_DASH_BRIDGE_TOKEN= -- /home/tsien/.local/bin/pi --name "smoke tmux-first"
```

- 15s 后 `/api/live-sessions` 从 11 条变 12 条，新增项：`pid 479897 | mode tui | sessionName "smoke tmux-first"`。
- `pid 479897` 与 `tmux list-panes -F '#{pane_pid}'` **完全一致**，且 `--name` 生效 → 注册匹配（pane pid 优先）按预期工作。
- `tmux kill-session` 后列表回到 11 条、该进程消失 → 「关闭 = kill tmux」的端到端行为成立。
- 演练会话及临时 cookie 已清理；本次演练在 session store 里留下一个空的 pi session 文件（未被引用）。

## 测试

- 后端全量：23 文件 / 307 passed / 1 skipped / 0 failed（新增 `live-session-launcher.test.js` 11 条 + meta 路由 1 条）。
- 前端全量：660 passed / 7 failed —— 这 7 条已在 HEAD 的干净 worktree 里复现（App branding、LiveSessionFeatures、ToolCallBlock、ToolGroup、ToolSummary、liveToolEntries），属既有文案漂移，与本次改动无关；`liveSessionsSidebar.test.tsx` 19/19 通过。
- 类型检查：`npm run typecheck`（backend）与 `npx tsc --noEmit`（frontend）均 0 错。
- **`npm run lint` 当前不可用**：仓库里没有 `eslint.config.*`（ESLint 9 必需），属既有配置缺口，与本次改动无关；本次以 typecheck + 测试代替。

## 还没验的（需人工）

- 真实 `./run.sh` 重启后的完整验收：web 新建 → 终端 attach → dashboard 重启 → 会话仍在（需用户执行重启）。
- 逐字节 TUI 渲染/输入在 web 终端面板上的体验。

## 已知边界

- 触屏/移动端仍用 `⋯` 菜单（无拖动/无终端面板）。
- 思考等级只能创建时定（live 协议没有运行时改 thinking 的命令）。
- 外部（非 dashboard 启动）的 live session 没有 `tmux`，因此不显示终端与关闭入口。
- live 页的「新建」串行一次一个；同一目录并发新建时，注册匹配按 pane pid 优先、其次新 + cwd + 最新 startedAt。

## 后续修补（用户实测反馈：`启动失败：cwd cannot be resolved`）

实测确认：只有「**绝对路径但不存在**」才会给这条泛指报错（存在的目录、`~`、`~/x` 都正常；相对路径给另一种提示）。
同时用真实服务端到端跑通了创建链路（见上方实测），所以不是功能坏了，是输入与报错文案的问题：

- `path-policy.ts` 报错分类：`cwd does not exist: <path>` / `cwd is not a directory: <path>` /
  `cwd is not readable by the dashboard process: <path>` / `cwd cannot be resolved (<code>): <path>`；
  越界与相对路径的提示里现在会附带**白名单根目录**。
- 启动表单：cwd 输入框支持 **Tab 目录补全**（复用 `PathCompleteMenu`，与 chat 输入框同一手势），
  并在下方常驻一行提示「必须是已存在的绝对目录（或 `~/…`），且在白名单根目录内」。

## 后续修补 2（用户反馈：新建 session 的模型选项和其他 session 不一样）

实测（在跑着的服务上直接调 `get_models` 比对两个真实 session）：

| session | 模型数 | 多出来的 provider |
|---|---|---|
| dashboard 新建（tmux-first） | 134 | huggingface 75、azure-openai-responses 39 |
| terminal 启动 | 31 | dashscope 8、azure-okx 3 |

原因不是 flags，也不是 shell alias（`pi-clean` 在本机不存在，且 tmux 直接 exec 二进制、**不会经过 shell，任何 alias 都不会生效**），
而是**环境变量**：tmux 给 pane 的是 **tmux server 的环境**（server 是之前某个进程起的，已经陈旧），
不是 dashboard 进程的、也不是当前 shell 的。provider 可用性由凭据环境决定，所以两边的模型集合不同。
实测三份环境互不相同：dashboard 进程有 `DASHSCOPE_API_KEY`/`AZURE_OPENAI_API_KEY`/`HF_TOKEN`/`CLAUDE_CODE_OAUTH_TOKEN`，
terminal session 有 `DASHSCOPE_API_KEY`/`ANTHROPIC_*`，而 pane 两者都缺一部分。

修法（`backend/tmux-sessions.ts`）：

- `panePassthroughEnv()` 选出要传递的变量名（排除 dashboard 自身接线：`PI_RUNTIME`/`PI_SLOT_KEY`/`PI_SCRIPT`/`PI_DASH_*`、
  易混淆的 `PI_SESSION_FILE`/`PI_SESSION_ID`、`TMUX*`/`BASH_*`/`npm_*`/`CONDA*` 噪声、`PATH`/`HOME` 等）；
- `ensureUpdateEnvironment()` 用 tmux 的 **`update-environment`** 把名单与现有值取并集（保留 tmux 自带的
  `DISPLAY`/`SSH_AUTH_SOCK` 等），值通过 tmux 客户端 socket 传递、**不进命令行**（不泄到 `ps`）；
  server 不存在时直接跳过（我们自己起 server 时 pane 本来就继承我们的环境），任何失败只告警不阻断建会话；
- `createTmuxSession()` 默认钉住 `-e PI_RUNTIME=live` 并清空 slot/bridge 变量（dashboard 自己起 server 时 pane 不会拿到 `PI_RUNTIME=dashboard`）。

实测（隔离 tmux server，模拟“已有陈旧 server”的生产场景）：改动前 server 环境无 PROBE 变量 → 改动后新 pane 拿到 2/2，
tmux 默认项保留，密钥未出现在任何进程 argv。

仍不能自动对齐的：只存在于你**某个终端 shell** 里的变量（如 `ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL`/`ANTHROPIC_AUTH_TOKEN`）
不会进 pane；要一致就用带这些变量的 shell 重启 dashboard，或写进 `~/.bashrc`。
另外 tmux 的 `update-environment` 是**全局选项**，这次会被扩展（默认项保留），属于对 tmux server 的可见副作用。