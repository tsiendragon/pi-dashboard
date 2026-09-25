# 独立安装指南（pi-dashboard + 配套扩展）

目标：在**一台干净的机器**上装出一套可用的 pi coding agent Web 工作台，只包含通用能力，
不引入任何内部业务内容（task-pilot / taskspace / eagleeye-kyc-llm / kyc-tables / security-guard 等）。

适用对象：想自己搭一套、或给外部同事/朋友一份可复现安装步骤的人。

---

## 1. 这套系统由什么组成

| 组件 | 作用 | 来源 |
|---|---|---|
| **pi CLI** | agent 运行时，负责模型调用、会话、工具 | `@earendil-works/pi-coding-agent`（npm） |
| **pi-dashboard** | Web/iOS 前端 + 后端，管理多会话、文件、终端 | `github.com/tsiendragon/pi-dashboard` |
| **pi-tsien-extension** | 一批配套 Pi 扩展（sidebar / schedule / subagent / live session / 后台命令 / goal / memory / git-graph …） | `github.com/tsiendragon/pi-tsien-extension` |
| **pi-web-tools** | 网页抓取工具扩展，已 vendored 在 pi-tsien-extension 内 | 同上 `vendor/pi-web-tools` |

**不包含**：内部 marketplace（eagleeye-ai-dev）及其业务插件、规则、技能；
`task-pilot` / `taskspace` / `security-guard` / `remote-notifications` / `pi-knowledge` 默认都不装。

扩展的安装机制：pi-tsien-extension 提供同步器 `scripts/pi-extension-sync.mjs`，
读取 `~/.pi/agent/extensions.config.json`，把有序的 `packages` / `extensions` 写进 Pi 的
`~/.pi/agent/settings.json`。独立安装用的配置是仓库内的
`config/extensions.standalone.json`（2 个 package、25 个 extension）。

每个扩展具体做什么，见 [§6 扩展清单](#6-扩展清单)。

---

## 2. 前置要求

- Linux 或 macOS，能访问 GitHub 与 npm registry
- **Node.js 22+**、npm、git
- 编译 `node-pty` 需要的构建工具（Debian/Ubuntu：`sudo apt install -y build-essential python3`）
- 模型凭证之一：`pi` 里 `/login`，或对应的环境变量（如 `DASHSCOPE_API_KEY` / `ANTHROPIC_API_KEY`）

不需要 GPU，不需要 conda，不需要 Tailscale（远程访问另见 §8）。

---

## 3. 一键安装

```bash
git clone https://github.com/tsiendragon/pi-dashboard.git
cd pi-dashboard
bash scripts/install-standalone.sh            # 交互式；加 -y 免确认
```

常用变体：

```bash
bash scripts/install-standalone.sh -y --start          # 装完后台启动
bash scripts/install-standalone.sh -y --service        # 装成 systemd 服务（需 sudo）
bash scripts/install-standalone.sh --dry-run           # 只打印将要执行的动作
bash scripts/install-standalone.sh --dir ~/tools --port 8899
bash scripts/install-standalone.sh --ext-dir ~/src/pi-tsien-extension   # 复用已有 checkout
```

全部参数见 `bash scripts/install-standalone.sh --help`。

### 脚本做了什么

1. 检查 git / node(≥22) / npm，缺失构建工具时给出提示
2. 取扩展仓库（默认克隆到 `~/pi-stack/pi-tsien-extension`）
3. `npm install` 扩展依赖
4. 备份 `~/.pi/agent/extensions.config.json` → 写入 standalone 配置 → 先 dry-run 预览，再 `--apply` 同步到 Pi 设置
5. `npm install` dashboard 依赖，构建前端（`npm run build-frontend`）
6. 可选：全局安装 `pi` CLI / 安装 systemd 服务 / 后台启动

> 安全提示：同步器是**严格模式**——不在配置里的 package/extension 会从 Pi 设置移除，
> `~/.pi/agent/extensions/` 下未托管的单文件扩展会被移入 `extension-quarantine/`。
> 原 `settings.json` 会备份到 `~/.pi/agent/extension-sync-backups/<时间戳>/`。
> 如果机器上已有引用 marketplace 的配置，脚本会先告警并要求确认。

---

## 4. 手动等价步骤（排障用）

```bash
EXT=~/pi-stack/pi-tsien-extension
git clone https://github.com/tsiendragon/pi-tsien-extension.git "$EXT"
npm --prefix "$EXT" install --no-audit --no-fund

mkdir -p ~/.pi/agent
cp "$EXT/config/extensions.standalone.json" ~/.pi/agent/extensions.config.json
node "$EXT/scripts/pi-extension-sync.mjs"                 # 预览
node "$EXT/scripts/pi-extension-sync.mjs" --apply         # 应用

cd ~/pi-stack/pi-dashboard            # 或你 clone pi-dashboard 的位置
npm install --no-audit --no-fund
npm run build-frontend
```

预期结果：同步器最后一行是 `Reload or restart Pi to use the ordered extension set.`，
再次运行会输出 `Pi extensions already match the ordered user config.`。

---

## 5. 启动与访问

```bash
cd <pi-dashboard 目录>
PI_DASH_PORT=7777 ./run.sh     # 构建前端并前台启动
```

浏览器打开 `http://localhost:7777`。

- 后端会用**仓库内自带的 pi**（`node_modules/.bin/pi`）；找不到时回退到 `which pi`。
- 因此不必全局装 pi CLI 也能用 dashboard；想在自己终端里用 pi，再执行
  `npm install -g @earendil-works/pi-coding-agent`。
- 扩展配置改动后需要让 Pi 生效：在 pi 里执行 `/reload`，或重启 dashboard 的会话进程。

### 模型凭证

```bash
pi            # 首次运行后执行 /login，或按提示写入 auth.json
# 或者
export DASHSCOPE_API_KEY=...   # 必须在启动 ./run.sh 的那个 shell 里导出
```

dashboard 派生的 pi 子进程继承 `run.sh` 所在 shell 的环境，所以环境变量方式要在启动前设置。

### 开机自启（systemd）

```bash
bash scripts/install-standalone.sh -y --service
sudo systemctl status pi-dashboard
sudo journalctl -u pi-dashboard -f
```

服务文件写到 `/etc/systemd/system/pi-dashboard.service`，`User`/`WorkingDirectory`/`PATH`
按当前安装位置生成。卸载：

```bash
sudo systemctl disable --now pi-dashboard
sudo rm /etc/systemd/system/pi-dashboard.service && sudo systemctl daemon-reload
```

---

## 6. 扩展清单

standalone 配置一共加载 **25 个扩展**（1 个 web-tools + 24 个 pi-tsien-extension）。加载顺序有语义：
`web-tools` 最前，`tool-result-pipeline` 必须紧跟其后（它是 `tool_result` 钩子的唯一入口，
内部再按 `rtk → bash-digest` 有序执行），`trajectory-recorder` 与 `capability` 放在最后。

### 6.1 与 dashboard 直接联动

| 扩展 | 做什么 | 入口 |
|---|---|---|
| `live-session.ts` | 把 Pi 会话作为可远程接管的 live session 暴露给 dashboard：接管/释放、会话树导航、分叉、触发 reload；会话标题由 agent 设置 | dashboard `/live-sessions`、`set_session_title` 工具、`/dashboard-release`、`/live-session-reload`、`/ls-navigate`、`/ls-fork` |
| `running-commands.ts` | 前台命令与后台任务统一列表；`Ctrl+B` 把原进程转后台（不重启）；dashboard 的 Background commands 面板与 live session 命令条复用同一套语义 | 四个工具 `background_command_start/status/output/cancel`、`↑` 聚焦命令列表 |
| `subagent-workbench.ts` | 进程隔离的子代理与可恢复 Workflow，可由 dashboard 的 Workbench 面板查看 | `subagent_start`、`subagent_workflow`、`subagent_workflow_control`、`subagent_results`、`subagent_cancel`、`/subagent-workbench` |

### 6.2 上下文与成本控制

| 扩展 | 做什么 | 入口 |
|---|---|---|
| `tool-result-pipeline.ts` | `tool_result` 钩子的唯一入口；RTK 过滤与 bash-digest 是有序 stage（前一个的输出喂给下一个），任一 stage 出错只退化为「不改写」 | 8 个 `rtk-*` 命令、`rtk_configure` 工具 |
| `auto-compact-target.ts` | 把自动压缩触发点统一到 `min(270000, 0.75 × contextWindow)`，而不是按各模型 50% 窗口 | 无命令；可选 `~/.pi/agent/auto-compact-target.json` |
| `compact-continue.ts` | 自动压缩完成后补一条隐藏 follow-up，提示 agent 基于摘要继续当前任务，避免长任务在压缩点停住 | 无命令 |
| `observation-pack.ts` | 把超大工具结果换成「头 + 尾 + observation id」占位符，全文归档，需要时按 offset 精确取回 | `obs_recall` 工具、`/obs-prune`；**默认关闭** |
| `context-powerline.ts` | footer 显示当前模型、推理等级、上下文用量、自动压缩阈值、本机 CPU/内存 | 无命令（Powerline 项） |
| `metrics-sidebar.ts` | 逐轮指标浮层：token、prompt cache 读写、耗时 | `/metrics-sidebar [show\|hide\|toggle]` |

### 6.3 TUI 体验

| 扩展 | 做什么 | 入口 |
|---|---|---|
| `00-zero.ts`（pi-zero） | Powerline 宿主、主题、工作状态消息、Claude Code 风格工具渲染、`/transcript`；`running-commands` 依赖它的 `pre-powerline` 插槽 | `/powerline`、`/vibe`、`/context`、`/ccstyle`、`/transcript` |
| `sidebar.ts` | 当前会话信息侧栏：模型、上下文组成、用量、缓存（不展示子代理/子会话） | `/sidebar [show\|hide\|toggle\|close]`、`Ctrl+Alt+S` |
| `btw.ts` | 与主任务隔离的只读侧聊浮窗（不能写文件/执行命令），用来临时问一句不污染主会话 | `/btw` |
| `git-graph.ts` | 当前仓库提交概览浮层，含本地/远端引用 | `/git-graph [1-2000]` |
| `session-aliases.ts` | 补上 `/clear`（新会话）与 `/exit`（退出）两个别名 | `/clear`、`/exit` |
| `prompt-inspector.ts` | 把「模型实际收到的最终 payload」可视化：优先用 `before_provider_request` 落盘的真实载荷，没有时实时重建一份近似视图 | `/prompt [raw\|path]` |
| `effort.ts` | 直接调整当前模型的 thinking level | `/effort [off\|minimal\|low\|medium\|high\|xhigh\|max]` |
| `default-system-prompt.ts` | 用 `~/.pi/agent/DefaultSystemPrompt.md` 覆盖系统提示开头并调整 Guidelines 段落 | 无命令；缺该文件时静默跳过 |

### 6.4 记忆与目标

| 扩展 | 做什么 | 入口 |
|---|---|---|
| `memory.ts` | 本地 SQLite/FTS5 长期记忆、自动召回、候选审核、遗忘与撤销 | `memory_search`、`memory_remember`、`memory_update`、`memory_forget`、`/memory ...`；数据在 `~/.pi/tsien-memory/` |
| `goal.ts` | 持久化目标 + 验收标准 + 进度/阻塞项、每 20 分钟自动 continuation、可说明原因的暂停 | `get_goal`、`create_goal`、`propose_goal_draft`、`complete_goal`、`pause_goal`、`update_goal_graph`、`update_goal_progress`、`/goal ...` |

### 6.5 工具与可观测性

| 扩展 | 做什么 | 入口 |
|---|---|---|
| `ptc.ts`（Code Mode） | 用一个模型生成的 TypeScript 程序编排多个已有工具，把中间结果留在程序里而不是上下文里，减少往返 | `run_code` 工具 |
| `capability.ts` | 注册工作区里可复用的「能力」，区分 draft/trusted，并作为技能暴露给 agent | `capability_ls`、`capability_run`、`/capability [ls\|promote\|demote]` |
| `vendor/pi-web-tools` | 联网检索与网页正文抓取；没有搜索 provider key 时回退到 DuckDuckGo lite | `WebSearch`、`WebFetch` 工具 |
| `schedule.ts` | 当前会话内的定时/周期任务，用于长任务跟进与轮询 | `schedule` 工具、`/schedule` |
| `usage-analytics.ts` | 本地统计工具与技能使用频率（不上传提示词/参数/输出，也不自动卸载） | `/usage [tools\|skills\|unused\|export\|reset]`；数据在 `~/.pi/agent/usage-analytics.json` |
| `trajectory-recorder.ts` | 记录可复现的 agent 轨迹，并额外写一份紧凑计时账本供 dashboard 时间分析 | 无命令；`PI_TRACE_DIR` / `PI_TIMING_DIR` 可覆盖路径 |

> - 默认关闭或需要配置才能生效的：`observation-pack`（`~/.pi/agent/observation-pack.json`）、
>   bash-digest stage（`~/.pi/agent/bash-digest.json`）。
> - 两个扩展的默认落盘目录是开发机路径（`trajectory-recorder` → `/mnt/workspace/lilong/agent/pi-traces`，
>   `observation-pack` → `/mnt/workspace/lilong/agent/archiv`）。在新机器上建议用 `PI_TRACE_DIR` /
>   `PI_TIMING_DIR` / `PI_OBSERVATION_DIR` 指向本机目录；不设也不会拖垮 Pi（写失败只告警），但会丢对应数据。
> - 它们都与业务无关，保留在清单里；只想减少加载量时，从 `config/extensions.standalone.json` 的
>   `loadOrder` 删除对应行即可（同步器会把它从 Pi 设置里移除）。

---

## 7. 可选组件

| 想要的功能 | 加装方式 |
|---|---|
| 网页搜索/抓取工具 | 默认已含（`vendor/pi-web-tools`） |
| 知识库检索（knowledge_search） | 克隆 `github.com/nczz/pi-knowledge`，在 `extensions.config.json` 的 `packages` 加一条该路径、`loadOrder` 加 `{"package":"knowledge","path":"extension.js"}`，再 `--apply` |
| Slack / Outlook / Lark 通道 | pi-dashboard 的 `channels/`、`plugins/pi-slack`、`plugins/pi-outlook`，按各自 README 配置；Lark 网关在没有账号配置时自动跳过 |
| iOS App / Electron 桌面端 | `apple/`（Xcode 构建）、`desktop/`（见 README） |
| 组织内部的 marketplace 包 | 本指南刻意不覆盖；需要时按该 marketplace 自己的安装流程走 |

---

## 8. 远程访问

详见 `docs/remote-access-deployment.md`。要点：pi-dashboard 的 API 默认**没有认证**，
安全模型是「网络不可达」，所以：

```bash
# Tailscale（推荐）
http://<tailscale-ip>:7777

# 或 SSH 隧道
PI_DASH_HOST=your-server PI_DASH_USER=you ./pi-dash-connect.sh
```

**不要把 7777 直接暴露到公网**，需要公网访问时在前面加 nginx + HTTPS + basic auth。

---

## 9. 验证清单

装完后按顺序确认：

1. `node -v` ≥ v22
2. `node ~/pi-stack/pi-tsien-extension/scripts/pi-extension-sync.mjs` 输出
   `Pi extensions already match the ordered user config.`
3. `~/.pi/agent/settings.json` 的 `packages` 有 2 项、`extensions` 有 25 项，且都不指向 marketplace
4. `curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:7777/` 返回 `200`
5. 在 dashboard 里发一条消息，能正常流式返回（说明模型凭证正确）
6. 终端里 `pi` 能启动，且 `/sidebar`、`/effort`、`/schedule` 等命令存在（说明扩展已加载）

---

## 10. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `node 版本过低` | 需要 22+；用 nvm/fnm 切换后再跑脚本 |
| `node-pty` 编译失败 | 缺 `python3` / `make` / `g++`，装 `build-essential` 后重跑 `npm install` |
| 同步器报 `Cannot resolve ${EAGLEEYE_AI_DEV_ROOT}` | 你用的配置引用了 marketplace 包；independent 安装请用 `config/extensions.standalone.json` |
| 同步器报某 extension 不存在 | 扩展仓库版本过旧，`git pull` 后重试 |
| dashboard 起来但会话报找不到 pi | 确认 `node_modules/.bin/pi` 存在（重跑 `npm install`），或全局安装 pi CLI |
| 扩展命令/面板没生效 | 在 pi 里 `/reload`；live session 等页面需要重开会话进程 |
| 端口被占用 | `--port` 指定别的端口，或 `lsof -i :7777` 找占用进程 |
| 想让 Pi 配置回滚 | `~/.pi/agent/extension-sync-backups/<时间戳>/settings.json` |

---

## 11. 卸载

```bash
# 1. 停服务（若装了）
sudo systemctl disable --now pi-dashboard 2>/dev/null || true

# 2. 清 Pi 侧扩展配置（保留备份即可）
#    删掉 records 前先确认没有别的机器/项目在共用这些路径
mv ~/.pi/agent/extensions.config.json ~/.pi/agent/extensions.config.json.unused
#    再手动移除 settings.json 里的 packages/extensions，或恢复备份

# 3. 删代码目录
rm -rf ~/pi-stack
```

业务数据（会话记录、内存、日志）在 `~/.pi/` 下，与代码目录分离，按需保留或清理。