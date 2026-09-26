# 配置总览（改哪生效）

> 本文件是配置的**权威说明**。配置分「四层」，绝大多数「改了没生效」都是**改错了层**。
> 先看 §1 地图，再按需跳到对应小节。

相关模块文档：[README.md](README.md)（总览）、[dashboard.md](dashboard.md)（环境变量落地）、
[extensions.md](extensions.md)（扩展装载）。

---

## 0. 快速索引：我要改 X → 去哪

| 我要改… | 去哪 |
|---|---|
| 模型凭证 / provider key | `<agent dir>/dashboard.env`（或 `pi` 里 `/login`） |
| 默认模型 / 主题 / 启停模型 | pi 的 `settings.json`（dashboard Settings，整份读写） |
| dashboard 端口 / 监听地址 | 环境变量 `PI_DASH_PORT` / `PI_DASH_HOST` |
| 用哪个 pi | `PI_SCRIPT`（`dashboard.env`） |
| live session 可见目录 / 启动命令 | `~/.pi/dashboard.json` 的 `liveSessions` |
| 装哪些扩展 / 加载顺序 | `<agent dir>/extensions.config.json`（同步器）+ dashboard **Extensions** 页 |
| 某扩展的开关（bash-digest 等） | `<agent dir>/<name>.json`（**Settings → Extension config**） |
| 某项目的记忆 / rtk 配置 | `<cwd>/.pi/<name>.json` |
| 扩展/pi 的数据落盘目录 | 环境变量 `PI_TRACE_DIR` / `PI_DASH_*_DIR`（见 §2） |

---

## 1. 配置地图（四层）

### ① 宿主 pi —— `<agent dir>`（默认 `~/.pi/agent/`）

| 文件 | 谁读 | 必须？ | dashboard 能改？ |
|---|---|---|---|
| `settings.json` | pi（默认模型、`enabledModels`、主题、`powerline`、`compaction`、`extensions`/`packages` 列表） | 是 | ✅ `/api/pi/settings`（**整份读写**，PUT 覆盖） |
| `auth.json` | pi（provider 凭证） | 是（或用环境变量） | ❌（`/login` 或 `dashboard.env`） |
| `models.json` / `models-store.json` | pi（模型清单、自建模型） | 是（自动维护） | ❌ |
| `AGENTS.md` / `DefaultSystemPrompt.md` | pi（系统提示） | 否 | ❌ |
| `keybindings.json` / `trust.json` | pi | 否 | ❌ |
| `sessions/`、`skills/`、`bin/`、`local/` | pi | 混合 | ❌ |
| `extensions.config.json` | 同步器（声明装载清单） | 是（standalone 安装用它） | ⚠️ 间接（`/api/pi/packages/*` 落到 settings.json） |
| `dashboard.env` | dashboard + 它派生的所有 pi | 部分 | ❌（但**唯一**环境入口） |

### ② 扩展（每个扩展一份 JSON，在 `<agent dir>/`）

| 文件 | 状态 | 说明 |
|---|---|---|
| `bash-digest.json` | 可选 | 摘要模型与凭证 |
| `observation-pack.json` | 可选（默认关闭） | 大结果归档目录 `archiveDir` |
| `auto-compact-target.json` | 可选 | 自动压缩阈值覆盖 |
| `compact-thinking.json` | 可选 | 压缩思考展示细节 |
| `capability.json` | 可选 | capability 工作区路径 |
| `claude-code-style.json` | 可选 | Claude Code 风格渲染开关 |
| `theme.json` | 可选 | 主题覆盖（`<agent dir>/theme.json` 或 `<agent dir>/extensions/powerline-footer/theme.json`） |
| `large-read-pack.json` | 可选（**已否决，默认关闭**） | 大文件读取打包；代码保留，需要时在 Extension config 点「创建并保存」恢复 |
| `tsien-memory.json` | 可选 | **按项目解析**（`<cwd>/.pi/`） |
| `rtk-config.json` | 可选 | **按项目解析**（`<cwd>/.pi/`） |

缺失即用扩展内置默认值；多数可在 dashboard 的 **Settings → general → Extension config** 改（见 §3）。

### ③ 进程环境变量 —— `<agent dir>/dashboard.env`

dashboard 启动时加载，并传给它派生的**每个** pi 子进程（`backend/pi-manager.ts` 用 `...process.env`）。
已收敛成**唯一**入口，见 §2。

### ④ dashboard 自己

| 文件 | 谁读 | 必须？ | dashboard 能改？ |
|---|---|---|---|
| `~/.pi/dashboard.json`（`liveSessions.roots/launch/unsetEnv/disconnectGraceMs`） | dashboard 后端 | 是（live session 靠它） | ✅ `/api/dash/config` |
| `<agent dir>/pi-web-sessions.json`（slot 元数据） | `backend/session-store.ts` | 自动 | 自动维护 |

### 其它（按项目 / 仓库）

| 位置 | 内容 |
|---|---|
| `<cwd>/.pi/settings.json`、`tsien-memory.json`、`rtk-config.json` | 项目级覆盖（不是机器级） |
| `<仓库根>/.env` | 本地环境覆盖（已在 `.gitignore`），可选 |

---

## 2. 环境变量（唯一入口：环境文件）

dashboard 不是自己跑 agent，而是为每个会话 slot 起一个 `pi --mode rpc` 子进程。
**只要变量进了 dashboard 进程，它就被所有 pi slot 继承**，扩展也能读到 —— 所以不需要给每个扩展单独写配置，
也不用改 systemd unit / launchd plist。

### 2.1 加载顺序（先到先得）

`backend/env-file.ts` 在启动最早时刻加载，**shell 里已有的同名变量优先**：

| 顺序 | 路径 | 说明 |
|---|---|---|
| 1 | `$PI_DASH_ENV_FILE` | 显式指定；**文件不存在会报错** |
| 2 | `<pi-dashboard 仓库根>/.env` | 本地 checkout 常用（不看 cwd） |
| 3 | `<PI_CODING_AGENT_DIR \| ~/.pi/agent>/dashboard.env` | 机器级；systemd / launchd / Docker 用 |

规则：与 dotenv 一致，已存在的 shell 变量不被覆盖；后面的文件只补前面没给到的。启动日志会打印
`[env] loaded env file(s): …`。语法支持 `KEY=VALUE`、`#` 注释、空行、`export KEY=…`、引号值。

模板见仓库根 [`.env.example`](../.env.example)。

### 2.2 完整变量表

| 变量 | 作用 | 默认 |
|---|---|---|
| `PI_SCRIPT` | 用哪个 pi 可执行文件（指向 fork 构建） | 仓库内 `node_modules/.bin/pi` → `which pi` |
| `PI_CODING_AGENT_DIR` | pi 的 agent 目录（决定上面所有 `<agent dir>`） | `~/.pi/agent` |
| `PI_DASH_PORT` | 服务端口 | `7777` |
| `PI_DASH_HOST` | 监听地址；设 `127.0.0.1` 收敛暴露面 | `0.0.0.0` |
| `PI_DASH_ENV_FILE` | 显式指定环境文件 | 无 |
| `PI_DASH_ALLOWED_ORIGIN` | 允许的跨域来源 | 无 |
| `PI_DASH_SESSIONS_DIR` | 会话目录 | pi 默认 |
| `PI_DASH_TIMEZONE` | 时区 | 系统 |
| `PI_DASH_TIMING_DIR` | dashboard 计时账本目录 | 默认 `<agent dir>/pi-timing`（可移植，无需设置） |
| `PI_DASH_USAGE_DIR` | dashboard 用量账本目录 | 默认 `<agent dir>/token-usage` |
| `PI_DASH_LIVE_SESSION_GROUPS` / `_META` / `_ORDER` | live session 分组/元数据/排序文件 | 默认 `<agent dir>/pi/live-session-*.json` |
| `PI_TASK_JOURNAL_ROOT` | 任务日志仓库根（可选，覆盖 `tasks.journal.roots`） | 默认空：**纯配置驱动**，不探测固定路径 |
| `PI_DASH_TIMING_REFRESH_MS` | 计时账本刷新间隔 | 内置默认 |
| `PI_DASH_TOOL_APPROVAL` | 工具审批策略 | 内置默认 |
| `PI_DASH_LIVE_*` | live session 其它项（groups/meta/order/start timeout） | 内置默认 |
| `PI_DASH_BRIDGE_SOCKET` / `PI_DASH_BRIDGE_TOKEN` | 与 live session 桥接 | 无 |
| `PI_DASH_TRANSPORT` | 传输方式 | 内置默认 |
| `PI_TRACE_DIR` | `trajectory-recorder` trace 落点 | `<agent dir>/pi-traces`（可移植） |
| `PI_TIMING_DIR` | `trajectory-recorder` 计时账本 | `<agent dir>/pi-timing`（可移植） |
| `PI_OBSERVATION_DIR` | `observation-pack` 大结果归档 | `<agent dir>/archiv`（可移植） |
| `DASHSCOPE_API_KEY` / `ANTHROPIC_API_KEY` 等 | 模型 provider 凭证 | 无 |
| `DASHSCOPE_BASE_URL` / `DASHSCOPE_TTS_BASE_URL` | DashScope 端点覆盖（TTS 等） | 官方端点 |
| `PI_BEDROCK_PROFILE` / `AWS_PROFILE` | Bedrock profile（未设 `AWS_PROFILE` 时回退） | 无 |

> 本表只列**部署相关**变量；代码内部还有少量实现用变量（如 `PI_RUNTIME`、`LILONG_TASK_ROOT`、
> `TAILSCALE_IP` 等），不要依赖它们做配置。以 `backend/` 代码为准；新增对外变量必须同步本表。

> ⚠️ **已知不一致**：多数地方用 `PI_CODING_AGENT_DIR`，但 `backend/routes/chat.ts` 读的是
> `PI_AGENT_DIR`。要改 agent 目录时两个都设上，否则该路径会回退到 `~/.pi/agent`。

> `install-standalone.sh` 会自动把 `PI_SCRIPT` 与上面 5 个 `PI_DASH_*` 可移植数据目录写进
> `<agent dir>/dashboard.env`（已存在的键不覆盖）。

### 2.3 三种用法

```bash
# 1) 本地手动
cp .env.example .env        # 填 PI_SCRIPT 和 provider key
./run.sh

# 2) systemd（脚本 --service 会装）：unit 只写 agent 目录，其余交给环境文件
#    Environment=PI_CODING_AGENT_DIR=/home/you/.pi/agent

# 3) 纯命令行用 pi（不经过 dashboard）：环境文件不会被加载，由 shell 自己给
export ANTHROPIC_API_KEY=sk-ant-...
```

### 2.4 排查

| 现象 | 检查 |
|---|---|
| `[env] PI_DASH_ENV_FILE=… does not exist` | 显式路径写错；改用默认位置或不设 |
| 启动日志没有 `[env] loaded …` | 三个候选位置都不存在 |
| 设了变量但 pi 里看不到 | 变量是在 dashboard **启动之后**才 export 的；重启 dashboard |
| 想换回官方 pi | `.env` 去掉 `PI_SCRIPT`，或改成官方路径 |

---

## 3. 每扩展一份 JSON（怎么改）

- **位置**：`<agent dir>/<name>.json`（少数按项目：`<cwd>/.pi/<name>.json`）。
- **命名**：每个扩展包自带 `CONFIG_FILE_NAME`；缺失即用内置默认。
- **推荐改法**：dashboard **Settings → general → Extension config** 卡片（`backend/routes/ext-config.ts`）：
  - 只允许白名单文件名；
  - 解析后的路径必须留在 agent dir 内（防目录穿越）；
  - 保存前有校验，可「创建并保存」。
- **例外（按项目）**：`tsien-memory.json`、`rtk-config.json` 从 `<cwd>/.pi/` 解析，不按机器。
- 扩展详情与每个文件的作用见 [extensions.md](extensions.md) 与扩展仓库 README。

---

## 4. dashboard 自身：`~/.pi/dashboard.json`

```json
{
  "liveSessions": {
    "enabled": true,
    "roots": ["/home/you", "/path/to/repos"],
    "launch": { "command": "/home/you/.local/bin/pi-clean", "args": [], "unsetEnv": [] },
    "disconnectGraceMs": 60000
  }
}
```

| 字段 | 作用 |
|---|---|
| `roots` | live session 可发现的目录范围（默认写死开发机 worktree，新机器要改） |
| `launch.command` | live session 用哪个 pi（可指向自己的包装脚本） |
| `unsetEnv` | 启动前从环境剔除的变量 |
| `disconnectGraceMs` | 断连宽限时间 |

改法：Settings 页（`PUT /api/dash/config`），或直接编辑该文件。

---

## 5. 为什么配置仍「分散」（统一策略）

每个扩展一份 JSON 是**扩展包的设计**，不是历史遗留。已收敛的三处：

1. 环境变量 → 只留 `dashboard.env`
2. 配置目录 → 统一 `~/.pi/agent/`
3. 需要人改的开关 → Extension config 区块

**不做的合并**：把十余个扩展 JSON 合成一个大文件 —— 要动十余处扩展代码，且**失去单扩展回滚能力**。

**`pi-web-sessions.json` 不并入 `dashboard.json`**：写入语义冲突。前者是运行时状态（`session-store.ts` 频繁写），
后者是用户配置（Settings 用 PUT **整份覆盖**）；同文件会导致保存配置冲掉 slot 状态，或反之。

---

## 6. 排障：改了没生效

| 症状 | 大概率原因 |
|---|---|
| 改了 `settings.json` 但行为没变 | pi 进程没重载：在 pi 里 `/reload`，或重启 dashboard 会话进程 |
| 改了扩展 JSON 没变 | 改错了层（项目级 vs 机器级）；或扩展缓存了配置，需重开会话 |
| 设了环境变量没生效 | dashboard 启动后才 export；重启 dashboard |
| 改了默认模型没变 | `settings.json` 与 `models-store.json` 都可能影响；用 dashboard 整份读写避免手改冲突 |
| 装/卸扩展没生效 | 写操作需在浏览器认证一次（见 `guide/extensions-page.md`），且需 `/reload` |

---

## 7. 相关文档

- 扩展装载与 npm/git 装法：[extensions.md](extensions.md)、`guide/extensions-page.md`
- 环境变量落地与远程访问：[dashboard.md](dashboard.md)、`guide/remote-access-deployment.md`
- 一键安装 / 手动安装：[README.md](README.md)、[standalone-install.md](standalone-install.md)