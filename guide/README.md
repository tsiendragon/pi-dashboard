# Pi 工作台部署总览（guide 主文档）

面向「在另一台机器上从零装出一套可用的 Pi 工作台」。
本目录是**唯一权威入口**；`docs/` 下是专题设计文档，细节问题再点进去。

| 模块文档 | 讲什么 |
|---|---|
| [pi-runtime.md](pi-runtime.md) | ① pi 宿主 CLI（**我们用 tsiendragon/pi 的 fork**） |
| [extensions.md](extensions.md) | ② pi-tsien-extension 扩展集合（npm / git / 本地三种装法） |
| [dashboard.md](dashboard.md) | ③ pi-dashboard Web 服务（端口、环境变量、远程访问） |
| [standalone-install.md](standalone-install.md) | 手动逐步安装版（前置、逐条命令、systemd、排障、卸载） |
| [config.md](config.md) | 配置总览（四层地图、每个 config 谁读、怎么改） |

> 维护规则见 [§7](#7-维护规则必须遵守)：任何影响安装/配置的改动，必须同步更新本目录。

---

## 1. 系统由三层组成

```
┌─────────────────────────────────────────────┐
│  ③ pi-dashboard   Web 服务 (Express+WS, :7777) │  为每个会话 slot 起一个 pi 子进程
│      └─ 依赖 → ② pi-tsien-extension 提供的扩展   │
│              └─ 依赖 → ① pi 宿主 CLI (fork 构建)  │
└─────────────────────────────────────────────┘
```

| 层 | 是什么 | 本机参考位置 | 默认来源 |
|---|---|---|---|
| **① pi 宿主** | 真正跑 agent 的 `pi` 可执行文件 | `/home/tsien/local-pi/bin/pi` | `github.com/tsiendragon/pi` 的 GitHub Release（10 个 tgz） |
| **② 扩展** | `pi-tsien-extension` 仓库（26 个包 / 25 个扩展入口） | `/mnt/workspace/lilong/repos/pi-tsien-extension` | `github.com/tsiendragon/pi-tsien-extension` |
| **③ dashboard** | Web + iOS 前端 + 后端 | 当前仓库 | `github.com/tsiendragon/pi-dashboard` |

**最关键的一条认知：pi 用的是 fork，不是上游官方版。** 官方 `@earendil-works/pi-coding-agent`
缺 `executeTool` / `extension_ui` 等扩展 API，会让 `run_code`、live session、子 Agent 全屏降级或报错。
详见 [pi-runtime.md](pi-runtime.md)。

**不包含**：内部 marketplace（eagleeye-ai-dev）及其业务插件/规则/技能
（`task-pilot` / `taskspace` / `security-guard` / `remote-notifications` / `pi-knowledge`）。
需要它们时按各自流程单独装。

---

## 2. 前置要求

- Linux 或 macOS，能访问 GitHub 与 npm registry
- **Node.js 22+**、npm、git
- 编译 `node-pty` 的构建工具（Debian/Ubuntu：`sudo apt install -y build-essential python3`）
- 至少一种模型凭证：`pi` 里 `/login`，或环境变量（`DASHSCOPE_API_KEY` / `ANTHROPIC_API_KEY` 等）

不需要 GPU，不需要 conda。

---

## 3. 一键安装（推荐）

```bash
git clone https://github.com/tsiendragon/pi-dashboard.git
cd pi-dashboard
bash scripts/install-standalone.sh              # 交互式；加 -y 免确认
```

常用变体：

```bash
bash scripts/install-standalone.sh -y --start    # 装完后台启动
bash scripts/install-standalone.sh -y --service  # 装成 systemd 服务（需 sudo）
bash scripts/install-standalone.sh --dry-run     # 只打印将执行的动作
bash scripts/install-standalone.sh --dir ~/tools --port 8899
bash scripts/install-standalone.sh --ext-dir ~/src/pi-tsien-extension   # 复用已有扩展 checkout
bash scripts/install-standalone.sh --pi-release tsiendragon/pi@v0.85.1-tsien.1
bash scripts/install-standalone.sh --official-pi # 改装官方版（功能会降级）
bash scripts/install-standalone.sh --skip-pi --pi-prefix ~/pi/bin       # 自备 pi
```

脚本按顺序做：检查依赖 → 取扩展仓库（默认克隆到 `~/pi-stack/pi-tsien-extension`）→ 装扩展依赖 →
写 standalone 装载清单并同步到 `~/.pi/agent/settings.json` → 装 dashboard 依赖并构建前端 →
从 Release 装 fork 版 pi 到 `<安装根>/pi` 并写 `PI_SCRIPT` → 可选 systemd / 后台启动。

全部参数见 `bash scripts/install-standalone.sh --help`，逐步手动版本见 [standalone-install.md](standalone-install.md)。

---

## 4. 手动安装（按模块）

三条命令即可（详见各模块文档）：

```bash
# ① pi 宿主 —— fork 构建
bash scripts/install-standalone.sh --skip-extension-sync --dry-run   # 看它怎么装 pi，或按 pi-runtime.md 手动 curl

# ② 扩展 —— 推荐从 npm 或 git 伞形包装
pi install git:github.com/tsiendragon/pi-tsien-extension

# ③ dashboard
npm install --no-audit --no-fund && npm run build-frontend
```

- pi 安装/切换：见 [pi-runtime.md](pi-runtime.md)
- 扩展三种装法与 standalone 配置：见 [extensions.md](extensions.md)
- dashboard 构建/启动：见 [dashboard.md](dashboard.md)

---

## 5. 配置

**完整配置地图与变量表见 [config.md](config.md)**（四层结构、每个文件谁读、所有环境变量）。
一键安装后只需关注：

| 配置 | 位置 |
|---|---|
| 模型凭证 | `<agent dir>/dashboard.env`（或 `pi` 里 `/login`） |
| 用哪个 pi | `PI_SCRIPT`（安装脚本自动写入 `dashboard.env`） |
| 端口 / 监听地址 | `PI_DASH_PORT` / `PI_DASH_HOST` |
| dashboard 自身（live session） | `~/.pi/dashboard.json` |

环境文件加载顺序（先到先得，shell 里已有的同名变量优先）：
`$PI_DASH_ENV_FILE` → `<仓库>/.env` → `<agent dir>/dashboard.env`。模板见仓库根 `.env.example`。

---

## 6. 验证清单

1. `node -v` ≥ v22
2. `node ~/pi-stack/pi-tsien-extension/scripts/pi-extension-sync.mjs` 输出 `Pi extensions already match the ordered user config.`
3. `~/.pi/agent/settings.json` 的 `packages` / `extensions` 数量与 `extensions.config.json` 一致（standalone 当前为 **25 packages + 25 extensions**），且不指向 marketplace
4. `curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:7777/` 返回 `200`
5. 在 dashboard 发一条消息，能正常流式返回（凭证正确）
6. 终端 `pi` 能启动，且 `/sidebar`、`/effort`、`/schedule` 等命令存在
7. 打开 `http://localhost:7777/extensions`，条目数与 `settings.json` 一致

---

## 7. 维护规则（必须遵守）

> **本节是硬性约定：凡是影响安装、配置、组件关系、依赖版本的改动，同一次提交里必须更新本 `guide/` 目录。**

- 新增/删除/重命名环境变量 → 更新 [§5 配置总表](#5-配置总表) 和对应模块文档。
- 新增/删除扩展包、改变装载方式或 npm 发布状态 → 更新 [extensions.md](extensions.md)。
- 更换 pi fork 版本 / 补丁 API 集合 → 更新 [pi-runtime.md](pi-runtime.md)。
- 改动安装脚本（`scripts/install-standalone.sh`）行为或参数 → 更新 [§3](#3-一键安装推荐) 与 [dashboard.md](dashboard.md)。
- 影响端口、监听地址、认证、远程访问 → 更新 [dashboard.md](dashboard.md)。
- 找不到该更新的位置时，先补到本文件，再决定是否需要新拆一份模块文档。

---

## 8. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 会话报找不到 pi | 确认 `node_modules/.bin/pi` 存在，或 `PI_SCRIPT` 指向有效路径 |
| `run_code` 报 `Code Mode requires executeTool` | 用的不是 fork 版 pi，见 [pi-runtime.md](pi-runtime.md) |
| node-pty 编译失败 | 缺 `python3` / `make` / `g++`，装 `build-essential` 后重跑 `npm install` |
| 同步器报 `Cannot resolve ${EAGLEEYE_AI_DEV_ROOT}` | 配置引用了 marketplace 包；独立安装请用 `config/extensions.standalone.json` |
| 扩展命令/面板没生效 | 在 pi 里 `/reload`；live session 等页面需重开会话进程 |
| 端口被占用 | `--port` 换端口，或 `lsof -i :7777` 找占用进程 |

**安全提醒**：dashboard 的 `/api/*` 与 WS **默认无认证**，安全模型是「网络不可达」。
用 Tailscale 直连或 SSH 隧道；**不要把 7777 直接暴露公网**，公网必须加 nginx + HTTPS + 认证。
详见 [dashboard.md](dashboard.md) 与 `guide/remote-access-deployment.md`。