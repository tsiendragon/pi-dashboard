# Web 共享终端（tmux 中继）— PRD

- **状态**：Proposed（待评审）
- **主仓库**：`<pi-dashboard repo>`
- **依赖**：`tmux >= 3.2`、`node-pty`（已安装）、`@xterm/*`（已安装但未接线）
- **技术设计**：`docs/web-terminal-tmux-tech-design.md`

## 1. 概述

在 pi-dashboard 的 Web UI 中增加一个「共享终端（Shared Terminal）」面板：用户在浏览器里输入的按键，会实时作用于本机正在运行的 Pi TUI 会话，并且该 TUI 的屏幕（颜色、光标、动画、逐字节输出）会实时镜像回浏览器。本机终端与本机 TUI、浏览器三者看到/操作的是**同一个终端会话**。

一句话：**Web 变成本机 Pi TUI 的实时镜像与输入远端。**

## 2. 背景与问题

现状（已核实代码）：

- Dashboard 的每个 chat slot 用 `pi --mode rpc` 启动 **headless 进程**（`backend/pi-manager.ts`），它没有 TUI 屏幕，输出是 JSONL 事件流。
- 用户在本机终端里跑的 `pi` 是 **另一个独立进程**，拥有真正的交互式 TUI。
- 两者不共享 stdin/stdout，会话也不共享 —— 因此「在 web 里输入，本机 TUI 同步显示」目前无法实现。
- `backend/pty-manager.ts` 里有一段基于 `node-pty` 的终端实现，但 `handlePtyConnection` **没有被任何代码 import 或调用**（孤儿模块）；`server.ts` 的 WebSocket upgrade 对非 `/api/ws`、非 live-session 的路径一律 `socket.destroy()`。
- 前端虽安装了 `@xterm/*`，但源码里没有任何 Terminal 组件；「Panels」下拉菜单注释里写了 Terminal，实际只渲染 Tree/Refs/Files。

结论：**当前 Web 端没有可用的终端，也没有任何接线。**

## 3. 目标

1. Web UI 提供一个可交互的终端面板（xterm.js），能看到一个「真实终端会话」的实时输出。
2. 浏览器键盘输入实时注入该会话，屏幕回显逐字节同步（含 ANSI 颜色、退格、方向键、Tab、Ctrl-C 等）。
3. 该会话与**本机 TUI 是同一个**：本机 `tmux attach` 进去看到的、浏览器看到的、以及实际执行的，是同一份屏幕和同一份输入。
4. 支持会话的创建、附加（attach）与脱离（detach），脱离不杀会话。
5. 复用现有认证体系，不裸暴露终端控制面。
6. 不修改 Pi Core（`@earendil-works/pi-coding-agent` 本体零改动）。

## 4. 非目标（v1）

1. 不把 Dashboard 现有的 headless slot 改造成 TUI（slot 保持 `--mode rpc`）。
2. 不做「任意机器远程 shell」；仅镜像与当前 Dashboard 同机的 Pi TUI 会话。
3. 不做多用户协作 / 抢锁 / 只读旁观多端（v1 单用户信任模型，见 §9）。
4. 不做移动端 / iOS 原生的终端渲染（v1 仅 Web）。
5. 不自动发现并接管任意 tmux session（v1 只管理 `pi-dash-*` 命名空间内的会话）。
6. 不做屏幕录制 / 回放 / 历史滚动持久化（浏览器内滚动缓冲除外）。

## 5. 用户故事

- **US-1（远程续作）**：我本机在 tmux 里开着 Pi TUI，人离开工位。我打开手机/另一台设备的 Dashboard，进入「共享终端」，看到的就是那个 TUI 的当前屏幕，能继续打字对话。
- **US-2（双屏同看）**：我在本机终端和浏览器同时打开同一个 TUI，两处屏幕实时一致；我在浏览器敲命令，本机终端立刻出现；我在本机敲，浏览器立刻更新。
- **US-3（断线不丢话）**：浏览器网络抖动断开后重连，重新 attach 到原会话，屏幕回到当前状态，会话没有被杀掉。
- **US-4（一键起会话）**：Dashboard 里点「新建共享终端」即可在后台 tmux 里启动一个 `pi` TUI；我在本机 `tmux attach -t <name>` 也能接进去。

## 6. 功能需求（FR）

### FR-1 共享终端面板
- 在 Chat 视图的 Panels 下拉中提供可用的「Terminal」项（当前只有 Tree/Refs/Files）。
- 面板使用 xterm.js 渲染，支持真实终端语义：ANSI/SGR 颜色、粗体/下划线、清屏、光标定位、Unicode、IME 输入。

### FR-2 会话模型
- 会话 = 一个 tmux session，命名空间 `pi-dash-*`。
- 支持：创建（`tmux new -d -s <name> pi`，可选 `--tui-mode`）、附加（`tmux attach -t <name>`）、列表、脱离。
- 脱离 ≠ 终止：Web 断开时 detach，tmux session 与本机 attach 不受影响。

### FR-3 输入与回显
- 浏览器按键 → WebSocket → node-pty stdio → tmux → TUI 的 stdin。
- TUI 输出 → tmux → node-pty 的 onData → WebSocket → xterm.js 写屏。
- 支持 resize：面板尺寸变化 → `proc.resize(cols, rows)` → 同步到 tmux pane。

### FR-4 生命周期
- 一个 tmux session 可同时被本机 `tmux attach` 和 Web attach（tmux 原生多客户端）。
- Web 关闭面板只 detach 自己的附加，不 kill session；「终止会话」是显式操作，需二次确认。

## 7. 非功能需求（NFR）

### NFR-1 安全（v1 硬门槛）
- 终端暴露的是本机 TUI 的 stdin/控制权，等价于「远程接管」，**必须复用 live-session 已有的浏览器认证**（`~/.pi/agent/run/pi-dashboard/live-control-token` + HttpOnly cookie），不对 `/api/pty` 做裸同源放行。
- WebSocket upgrade 必须做 Origin 校验（沿用 DSW gateway origin 判定），拒绝跨站。
- 不允许通过终端路径注入任意命令绕过 auth；终端的「任意性」由已认证用户 + tmux session 边界约束。

### NFR-2 延迟
- 按键 → 回显的端到端延迟目标 < 150ms（本机/局域网；跨 SSH 隧道时尽力而为）。

### NFR-3 断线与恢复
- WebSocket 断开时 detach，不杀 tmux session；重连后可重新 attach 恢复同屏。
- Dashboard server 重启不杀掉已存在的 tmux session（会话由 tmux 持有，独立于 Dashboard 进程）。

### NFR-4 尺寸
- 多端尺寸不一致时，交由 tmux 的最小尺寸策略处理（v1 接受折中，见技术设计）。

## 8. 验收标准（AC）

1. Dashboard「Panels」中能打开 Terminal 面板，看到真实终端的输出。
2. 在 tmux 中启动 `pi`，Web attach 后屏幕与本机终端逐字节一致（含颜色、提示符号、滚动）。
3. Web 键盘输入实时到达 TUI（本机终端立即可见），TUI 输出实时到达 Web。
4. 关闭 Web 面板 / 断开 WebSocket 后，本机 tmux 里的 TUI 继续存活且输入恢复。
5. 重连后能重新 attach 到原会话并回到当前屏幕。
6. 未认证的浏览器（无 cookie/token）无法连接 `/api/pty`。
7. `resize` 后面板与 tmux pane 尺寸同步，内容不错乱。
8. 不修改 Pi Core；`node-pty`、`@xterm` 复用已完成依赖，无新增重型依赖。
9. 现有 Dashboard slot（`--mode rpc`）行为不受影响，回归通过。

## 9. 风险与开放问题

| # | 风险/问题 | 影响 | 处置 |
|---|---|---|---|
| R1 | Web 终端 = 远程接管 TUI，误暴露是严重安全问题 | 高 | 复用 live-control-token 认证 + Origin 校验，作为 v1 首个切片落地 |
| R2 | 本机 TUI 需迁移到 tmux 里跑，改变用户习惯 | 中 | 提供「一键启动会话」，文档说明 `tmux new -s …` 与 `tmux attach` |
| R3 | 多端尺寸不同，全屏 TUI 渲染会被最小尺寸折中 | 中 | v1 接受；技术设计记录 resize 策略，未来可做虚拟尺寸 |
| R4 | tmux 多客户端同时输入无锁，理论上会「打架」 | 低 | v1 单用户信任模型，不做协作锁（见非目标 3） |

**已确认决策**：

- D1：**两者都支持**。Dashboard 既能一键创建 `pi-dash-*` 会话（`tmux new -d -s <name> pi`，作为默认入口），也能附加用户已手动创建的同命名空间会话（`tmux attach -t <name>`）。
- D2：**Terminal 面板为独立入口**。语义上不属于任何 headless slot，不参与 slot 的 kill/restart/restore 生命周期。

## 10. 里程碑

- **M1（管道打通 / 安全门）**：认证 + Origin 校验 + 最小可用的终端镜像与输入闭环（先验证「web 输入 → tmux → TUI 回显」可行）。
- **M2（会话生命周期）**：创建/附加/列表/脱离/终止，多会话命名与管理。
- **M3（体验）**：resize 同步、重连恢复、滚动缓冲、错误态与空态。
- **M4（文档与回归）**：README 操作说明、测试补齐、正式验收。