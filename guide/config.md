# 配置总览（改哪生效）

> 本文件是配置的**权威说明**。配置分「四层」，绝大多数「改了没生效」都是**改错了层**。
> 先看 §1 地图，再按需跳到对应小节。

相关模块文档：[README.md](README.md)（总览）、[dashboard.md](dashboard.md)（环境变量落地）、
[extensions.md](extensions.md)（扩展装载）。

---

## ⚠️ 最小必配（装完只做这一件）

**只有模型凭证是必须的**：在 `<agent dir>/dashboard.env` 写一条 provider key（或在 `pi` 里 `/login`），
例如 `DASHSCOPE_API_KEY=...` / `ANTHROPIC_API_KEY=...`。不配则任何会话都发不出去。

其它都有可用默认值；唯一「默认关、想用要开」的是 live session（要填 `~/.pi/dashboard.json` 的
`liveSessions.roots`）。完整分档见 §2。

---

## 0. 快速索引：我要改 X → 去哪

| 我要改… | 去哪 |
|---|---|
| 模型凭证 / provider key | `<agent dir>/dashboard.env`（或 `pi` 里 `/login`） |
| 默认模型 / 主题 / 启停模型 | pi 的 `settings.json`（dashboard Settings，整份读写） |
| dashboard 端口 / 监听地址 | 环境变量 `PI_DASH_PORT` / `PI_DASH_HOST` |
| 用哪个 pi | `PI_SCRIPT`（`dashboard.env`） |
| live session 可见目录 / 启动命令 | `~/.pi/dashboard.json` 的 `liveSessions`（§4.0） |
| 常用仓库清单（路径、标签、Git Graph） | `~/.pi/dashboard.json` 的 `repos`（dashboard **Repos** 页可增删，§4.1） |
| 任务从哪来 / 对外显示的任务源 / Jira 链接前缀 | `~/.pi/dashboard.json` 的 `tasks`（含 `journal` / `providers` / `jiraBaseUrl`，§4.2） |
| 泳道（长期/短期/临时）怎么分 | `~/.pi/dashboard.json` 的 `tasks.lanes`（§4.2） |
| Obsidian 笔记目录（System 页统计与日常笔记） | `~/.pi/dashboard.json` 的 `vault`（§4.4） |
| 主 Agent 工作监督（可选） | `~/.pi/dashboard.json` 的 `supervisor`（§4.5） |
| 服务面板登记哪些服务、怎么启停 | `~/.pi/services.json`（独立文件，见 [services.md](services.md)） |
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
| `subagent-models.json` | 推荐 | 子任务模型档位（light/medium/heavy/ultra）与候选顺序，由 `pi-tsien-subagent-workbench` 读取；可用 `PI_SUBAGENT_MODEL_CONFIG` 指向别处。缺失时退回旧变量 `PI_SUBAGENT_EXECUTION_MODEL`，两者都没有则子任务直接报错，不再有内置默认模型。可在 **Settings → Subagent Models / 子任务模型** 编辑 |

缺失即用扩展内置默认值；多数可在 dashboard 的 **Settings → general → Extension config** 改（见 §3）。

### ③ 进程环境变量 —— `<agent dir>/dashboard.env`

dashboard 启动时加载，并传给它派生的**每个** pi 子进程（`backend/pi-manager.ts` 用 `...process.env`）。
已收敛成**唯一**入口，见 §2。

### ④ dashboard 自己

| 文件 | 谁读 | 必须？ | dashboard 能改？ |
|---|---|---|---|
| `~/.pi/dashboard.json`（`liveSessions` / `repos` / `tasks` / `vault` / `supervisor`，每段都有示例，整份模板见仓库根 `dashboard.json.example`） | dashboard 后端 | 是（live session 靠它） | ✅ `/api/dash/config`（需认证，**整份覆盖**：在 Settings 保存前先确认文件里有你手写的段） |
| `<agent dir>/pi-web-sessions.json`（slot 元数据） | `backend/session-store.ts` | 自动 | 自动维护 |
| `<agent dir>/machine-connector.json`（私有 WSS 出站会话索引与受限控制） | dashboard 后端启动时读取 | 否，缺失即禁用 | ❌；仅手动创建 0600 文件 |
| `$HOME/.pi-dashboard-private/machine-input-replay.json`（远程输入持久防重放）及 `.lock` | dashboard 后端自动创建/读取 | 仅启用机器出站控制时必须安全可用 | ❌；不可通过 HTTP 访问或手动清空 |

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
| `CODEX_HOME` | Token Cost 读取 Codex 额度时使用的 Codex CLI 配置/登录目录 | Codex CLI 默认目录（通常 `~/.codex`） |
| `CLAUDE_CONFIG_DIR` | Token Cost 读取 Claude Code 额度时查找 OAuth 登录文件的目录 | `~/.claude` |
| `PI_DASH_LIVE_SESSION_GROUPS` / `PI_DASH_LIVE_SESSION_META` / `PI_DASH_LIVE_SESSION_ORDER` | live session 分组/元数据/排序文件 | 默认 `<agent dir>/pi/live-session-*.json` |
| `PI_TASK_JOURNAL_ROOT` | 任务日志仓库根（可选，覆盖 `tasks.journal.roots`） | 默认空：**纯配置驱动**，不探测固定路径 |
| `PI_DASH_TIMING_REFRESH_MS` | 计时账本刷新间隔 | 内置默认 |
| `PI_DASH_TOOL_APPROVAL` | 工具审批策略 | 内置默认 |
| `PI_DASH_LIVE_START_TIMEOUT_MS` | live session 启动超时 | 内置默认 |
| `PI_DASH_BRIDGE_SOCKET` / `PI_DASH_BRIDGE_TOKEN` | 与 live session 桥接 | 无 |
| `PI_DASH_TRANSPORT` | 传输方式 | 内置默认 |
| `PI_TRACE_DIR` | `trajectory-recorder` trace 落点 | `<agent dir>/pi-traces`（可移植） |
| `PI_TIMING_DIR` | `trajectory-recorder` 计时账本 | `<agent dir>/pi-timing`（可移植） |
| `PI_OBSERVATION_DIR` | `observation-pack` 大结果归档 | `<agent dir>/archiv`（可移植） |
| `PI_TSIEN_MEMORY_DIR` | `pi-tsien-memory` 扩展的记忆数据目录；dashboard 的 `/memory` 页面只读同一路径下的 `memory.db`，两端读同一个变量名 | `~/.pi/tsien-memory` |
| `PI_MEMORY_DRAFT_DIR` / `PI_MEMORY_PUBLISHED_DIR` | 夜间记忆草稿与批准后发布稿的落盘目录 | 记忆数据目录下的 `drafts` / `published` |
| `PI_MEMORY_AGENTS_FILE` / `PI_MEMORY_SKILL_DIR` | 发布记忆时写入的 `AGENTS.md` 与 skills 目录 | `<agent dir>/AGENTS.md` / `<agent dir>/skills` |
| `DASHSCOPE_API_KEY` / `ANTHROPIC_API_KEY` 等 | 模型 provider 凭证 | 无 |
| `DASHSCOPE_BASE_URL` / `DASHSCOPE_TTS_BASE_URL` | DashScope 端点覆盖（ASR/TTS） | 官方端点 |
| `DASHSCOPE_IMAGE_ENDPOINT` | 表情包图片生成/编辑的完整 HTTPS 地址，不复用语音端点 | `https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation` |
| `DASHSCOPE_IMAGE_MODEL` / `DASHSCOPE_IMAGE_EDIT_MODEL` | 表情包无参考图/有参考图模型；使用 `DASHSCOPE_API_KEY` | `qwen-image-3.0` / `qwen-image-3.0` |
| `AZURE_OPENAI_IMAGE_API_KEY` / `AZURE_OPENAI_IMAGE_ENDPOINT` | Azure 图片服务密钥与 HTTPS 基础地址，不带 deployment 路径 | 无；均配置后启用 |
| `AZURE_OPENAI_IMAGE_DEPLOYMENT` | 同时支持生成和编辑的 GPT Image 部署名（不支持 DALL-E） | `gpt-image-2.5-sunburst` |
| `AZURE_OPENAI_IMAGE_API_VERSION` | Azure 图片生成/编辑接口版本 | `2025-04-01-preview` |
| `AZURE_OPENAI_IMAGE_AUTH` | `bearer` 沿用 Toolkit 网关认证；原生 Azure API key 选 `api-key` | `bearer` |
| `AZURE_FLUX2_API_KEY` / `AZURE_FLUX2_ENDPOINT` | 可选 FLUX.2 独立密钥与完整生成/参考图编辑 URL；不配置时沿用 Azure 图片密钥，从图片基础地址派生 `/providers/blackforestlabs/v1/flux-2-pro?api-version=preview`。参考图通过 `input_image` base64 提交。FLUX 1.1 Pro 独立沿用 `AZURE_OPENAI_IMAGE_API_KEY` 与图片基础地址，派生同前缀的 `/flux-pro-1.1?api-version=preview`，不使用此 FLUX.2 专用覆盖项 | 沿用/派生 |
| `AZURE_MAI_IMAGE_API_KEY` / `AZURE_MAI_IMAGE_ENDPOINT` | 可选 MAI 独立密钥与基础地址；不配置时沿用 Azure 图片密钥，基础域名将 `.cognitiveservices.azure.com` 换成 `.services.ai.azure.com`；调用 `/mai/v1/images/generations?api-version=preview`，固定使用 `api-key` 认证 | 沿用/派生 |
| `MEME_OUTPUT_DIR` | 表情包工坊的生成图片与历史索引保存目录；支持 `~/` 前缀，不存在时自动创建 | `~/.pi/dashboard/memes` |
| `PI_BEDROCK_PROFILE` / `AWS_PROFILE` | Bedrock profile（未设 `AWS_PROFILE` 时回退） | 无 |

> 语音输入使用 `DASHSCOPE_API_KEY` 和上述 DashScope 端点：浏览器通过同源 WebSocket 将 16 kHz 音频流交给 dashboard 后端，再调用 `qwen3-asr-flash-realtime`；录音停止后接收最终文本。它不需要新增环境变量。批量识别接口 `/api/asr/transcribe` 仍保留给非实时调用方。

> Token Cost 的额度卡片可选读取本机 Codex / Claude Code 账户：Codex CLI 需可从 dashboard 进程的 `PATH` 启动；Claude Code 使用 `${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json` 中的 OAuth 凭证。凭证只在后端读取，不会返回给浏览器。该查询只显示账户接口实际提供的百分比与重置时间；Claude Code 目前只支持 OAuth 订阅用量，API key、Bedrock/Vertex、仅 keychain 存储等情况可能没有数据。没有对应 CLI 登录时页面会显示未提供，不影响 Token Cost 原有统计。
>
> 本表只列**部署相关**变量；代码内部还有少量实现用变量（如 `PI_RUNTIME`、`TAILSCALE_IP` 等），不要依赖它们做配置。以 `backend/` 代码为准；新增对外变量必须同步本表。

> ℹ️ **agent 目录**：统一读 `PI_CODING_AGENT_DIR`（`PI_AGENT_DIR` 作为兼容别名仍被接受），
> 默认 `~/.pi/agent`。相关路由：`backend/routes/{chat,system,pi-ext-list}.ts`、`backend/settings-store.ts`、
> `backend/live-sessions/ext-config.ts`。

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

**整份可直接复制的模板：[`dashboard.json.example`](../dashboard.json.example)**。复制成 `~/.pi/dashboard.json` 后把 `/home/you/…` 换成真实路径；用不到的段整段删掉，删掉即回到内置默认。JSON 不支持注释，所以字段解释都在本节。

本节按段讲，每段都有示例：`liveSessions`（这个文件里唯一需要手填才能用起来的一段）、`repos`、`tasks`（含外部任务源）、`vault`、`supervisor`。默认值分别来自 `backend/pi-env.ts`、`backend/live-sessions/config.ts`、`backend/repos/store.ts`、`backend/supervisor/config.ts`。

### 4.0 `liveSessions`：live session 扫描与启动

```json
{
  "liveSessions": {
    "roots": ["/home/you", "/home/you/repos"],
    "repoRoots": ["/home/you/repos"],
    "disconnectGraceMs": 60000,
    "launch": { "command": "/home/you/pi-stack/pi/bin/pi", "args": [], "unsetEnv": [], "approve": true }
  }
}
```

| 字段 | 作用 |
|---|---|
| `roots` | live session 可发现的目录范围。**这就是开关**：空数组（默认）＝关闭，填了才启用。**必须写绝对路径**：写 `~/repos` 会让路径校验直接报 `live session root must be absolute`，所有 live session 都启动不了 |
| `repoRoots` | 「启动 Live Pi」目录框关键词搜索的仓库根目录：只取每个目录的**下一级**子目录（不递归、跳过隐藏目录与 `node_modules`，最多 400 个）。默认空＝不搜索；它只影响输入建议，能不能启动仍由 `roots` 决定。同样要绝对路径（写 `~/` 不会报错，但会静默搜不到） |
| `launch.command` | live session 用哪个 pi（可指向自己的包装脚本；不写则用 `PATH` 里的 `pi`） |
| `launch.args` | 追加在 dashboard 自己参数**之前**的参数（默认空），留给包装脚本以外的固定参数 |
| `unsetEnv` / `launch.unsetEnv` | 启动前真正从 pane 环境删除的变量（`env -u`，不是置空）。**写在 `launch` 里面**，顶部写不会生效 |
| `launch.approve` | `true` 给 pane 追加 `--approve`（信任工程内的 `.pi` 扩展/skills/settings），`false` 追加 `--no-approve`；不写则保留 pi 自己的行为——会弹「是否信任该目录」的交互提问，而 pane 里没人能回答，启动就会卡住 |
| `disconnectGraceMs` | 断连宽限时间（默认 15000 毫秒） |

`enabled` 是派生值：实际是否启用看 `enabled && roots.length > 0`，所以**开关是 `roots`**；写 `"enabled": false` 可以强制关闭，写 `true` 不会把空 `roots` 变成开启。

> `includeOutsideRoots`、`claimMode`、`leaseMs`、`snapshotEntryLimit` 这 4 个字段当前版本会解析并校验范围，但**没有任何代码读取它们**（已按代码核实），不要依赖它们调行为。

### 4.1 `repos`：常用仓库清单

```json
{
  "repos": [
    { "id": "pi-dashboard", "path": "/home/you/repos/pi-dashboard", "tags": ["pi"], "pinned": true },
    { "id": "sample", "name": "sample-app", "path": "/home/you/repos/sample-app", "defaultBranch": "main" }
  ]
}
```

- 每个仓库各自一个**绝对路径**，不要求在同一父目录下；没有 `roots` 之类的扫描字段。
- `id` 是其他地方引用该仓库的稳定键（小写字母/数字/`. _ -`，登记后不可改）；`name` / `tags` / `pinned` / `defaultBranch` 均可选。`defaultBranch` 写了之后，当前分支不一致会在 Repos 页标「≠ main」。
- 手改文件与在 **Repos** 页点添加/删除效果一致；页面「移除」只删登记，不动磁盘目录。
- git 状态（分支、ahead/behind、改动数）用只读 git 命令查询，**不写入配置**。结果缓存到 `~/.pi/repos-status-cache.json`（重启后仍在）：打开页面时立刻显示缓存，超过 24 小时的会在后台自动更新（页面上写着读取时间，想看最新状态点「刷新状态」）；页面右上「刷新状态」强制全部重读。`/mnt` 这类网络盘上大仓库的 `git status` 可能要几十秒，所以列表从不等它；45 秒仍没读完的仓库标「git status 超时」，且不会覆盖之前读到的好结果。Git Graph 页 `#/repos/<id>/graph` 也只读；只有「Fetch」按钮会执行 `git fetch --prune`。
- 清单里的仓库会并入「启动 Live Pi」目录框的关键词建议（与 `repoRoots` 扫描结果合并去重）；能否真正启动仍由 `liveSessions.roots` 决定。
- 写操作（添加/编辑/移除/Fetch）需要浏览器已通过 Live Session 令牌认证，未认证会返回 401 并提示。

**启动卡在「Trust project folder?」**：工程目录里出现 `.pi/settings.json`、`.pi/extensions`、`.pi/skills`、`.pi/prompts`、`.pi/themes`、`.pi/SYSTEM.md` 等资源，而 `~/.pi/agent/trust.json` 里没有该目录（或某个父目录）的决定时，pi 会先问一次。dashboard 的 pane 没有键盘，于是永不注册；旧版本会等满超时，浏览器侧先被网关掐断，只显示 `HTTP 504`。三种改法任选：在终端里对该目录跑一次 `pi` 并选 Trust（写进 `trust.json`）；手工把该目录或其父目录写进 `~/.pi/agent/trust.json`；或直接在该机器的 `dashboard.json` 里设 `"launch": { "approve": true }`（启动即自动信任，仅在 `liveSessions.roots` 内的目录生效，第三方克隆仓库慎用）。

改法：Settings 页（`PUT /api/dash/config`），或直接编辑该文件。

---

### 4.2 `tasks`：任务来源、Jira 与外部任务源

```json
{
  "tasks": {
    "enabled": true,
    "defaultView": "execute",
    "journal": { "autoDetect": true, "roots": ["/home/you/repos/my-taskspace"], "enabled": true },
    "jiraBaseUrl": "https://example.atlassian.net/browse/",
    "lanes": [
      { "id": "long", "label": "长期", "match": { "kind": ["epic"] } },
      { "id": "short", "label": "短期", "match": { "kind": ["task"] } },
      { "id": "adhoc", "label": "临时", "match": { "kind": ["todo", "item"] } }
    ],
    "providers": [
      { "kind": "file", "id": "extra-tasks", "label": "额外任务清单", "file": "/home/you/.pi/tasks/extra-tasks.json" },
      { "kind": "command", "id": "my-tracker", "label": "我的看板", "command": ["/home/you/bin/my-tracker-tasks", "--json"], "cwd": "/home/you/repos/my-tracker", "timeoutMs": 20000 }
    ]
  }
}
```

| 字段 | 作用 |
|---|---|
| `journal.roots` | Task Journal（`tasks/DOMAINS.yaml` + `epic.yaml` + `task.yaml`）仓库根；空数组且 `autoDetect` 关掉就没有该来源 |
| `journal.autoDetect` | 默认 `true`：从 `roots` 里挑第一个结构完整的仓库；关掉后只用 `roots[0]` |
| `lanes` / `defaultView` | 泳道定义与默认视图，省略即用内置的三条泳道。`lanes` 结构见下；`defaultView` 取 `execute`（默认）或 `survey` |
| `providers` | 配置声明的外部任务源（`command` 或 `file`，只读），见下面的「外部任务源」 |
| `jiraBaseUrl` | **Jira 链接前缀**，默认 `https://example.atlassian.net/browse/`。任务页把「任务的身份」拼在它后面生成可点链接；换成别的 Jira 站点只改这一处，不需要改代码。必须是 `http(s)://` 开头的绝对地址，否则回落到默认值 |

**泳道 `lanes`**：`match` 里三个条件任一命中就归入该泳道，按数组顺序取第一个命中的，都没命中归「未分类」。

| 条件 | 例子 |
|---|---|
| `kind` | `{"kind": ["epic"]}` — 任务类型，取 `epic` / `task` / `todo` / `item` |
| `tag` | `{"tag": "infra"}` — 任务带这个标签 |
| `pathPrefix` | `{"pathPrefix": "/home/you/repos/"}` — 执行目录以它开头 |

任务详情里的「泳道」选择会写进本地规划的覆盖值，优先级高于这里的匹配规则。

**外部任务源 `providers`**：让不在这台机器 journal 里的任务（Jira 导出、自建看板、表格导出等）也出现在任务清单里。**全部只读**——状态只能在原系统里改，任务页不会回写。加一个源不需要改代码。

```json
{
  "providers": [
    { "kind": "file", "id": "extra", "label": "额外任务清单", "file": "~/.pi/tasks/extra.json" },
    { "kind": "command", "id": "tracker", "label": "我的看板", "command": ["/path/to/tasks", "--json"], "cwd": "/path/to/repo", "timeoutMs": 20000 }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `kind` | `file` 读一个 JSON 文件；`command` 跑一个程序读它的 stdout（argv 直传，不经 shell） |
| `file` | `kind: file` 时必填，支持 `~/` |
| `command` | `kind: command` 时必填，**argv 数组**：第一个是程序，其余是参数 |
| `cwd` / `timeoutMs` | 只对 `command` 生效：工作目录、超时（默认 20000 毫秒；stdout 上限 8 MB） |
| `id` / `label` | `id` 必填且各源之间唯一，任务 uid 是 `<id>:<任务 id>`；`label` 是界面上显示的来源名，省略就用 `id` |
| `enabled` | 写 `false` 可临时停用该源，不用删配置 |

两种源的数据格式相同（`file` 是文件内容，`command` 是 stdout）：**JSON 数组，或 `{"tasks": [...]}`**。每一项：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 源内的唯一 id |
| `title` / `description` | 否 | 不写标题就用 `id` |
| `status` | 否 | 自由文本，按关键词归并：`to_do`/`todo`/`open`/`pending`/`backlog`/`planned` → 未开始；`in_progress`/`doing`/`active`/`wip`/`started` → 进行中；`done`/`complete`/`completed`/`closed`/`archived` → 已完成；`paused`/`blocked`/`on_hold`/`suspended` → 暂停。空格和连字符都当 `_`（`In Progress` 等于 `in_progress`）；其它文本按未开始处理并在界面上保留原文。完整映射见 `backend/tasks/mapping.ts` |
| `kind` | 否 | `epic` / `task` / `todo` / `item`，默认 `task` |
| `archived` | 否 | `true` 的条目不进默认的「活跃」筛选，只在「归档」里出现 |
| `plannable` | 否 | 默认 `true`；`false` 表示不参与规划 |
| `path` | 否 | 执行目录，支持 `~/`，用来关联会话 |
| `progress` | 否 | `{"done": 3, "total": 5}` |
| `tags` | 否 | 字符串数组 |
| `updatedAt` | 否 | ISO 时间，界面显示「多久前」 |
| `jiraKey` | 否 | 写了就显示 Jira 链接与状态（取号规则见下） |

最小可用内容（文件内容或命令输出都一样）：

```json
[{ "id": "PROJ-105", "title": "开户流程改造", "status": "In Progress", "jiraKey": "PROJ-105" }]
```

读失败（文件不存在、命令非零退出、JSON 格式不对）只会让这一个来源在任务页显示一条警告，其它来源照常显示；任务页不会因此报错。

**任务从哪里拿到 Jira 号**（顺序固定）：
1. `epic.yaml` / `task.yaml` 里显式写的 `jira_key`（例如 `jira_key: PROJ-102`）优先；
2. 没写时，如果 `key` 本身就是 Jira 号（`^[A-Z][A-Z0-9]*-\d+$`，例如 `PROJ-104`）就直接用它；
3. 都没有（例如 `task-key-jira-decoupling-v1` 这种本地 key）就**不显示链接**——「未绑定 Jira」是正常状态，不是同步失败；`jira_key: null` 同理。

本地任务（`~/.pi/tasks/tasks.json`）里可选 `jiraKey` 字段，写了就同样渲染链接；不写就没有。

**Jira 真实状态（可选，显式刷新）**：任务页可以显示每张单在 Jira 上的真实状态（`Development` / `Feasibility` / `Done` 等）、负责人和优先级，并据此标出「本地已完成但 Jira 未关」/「Jira 已 Done 但本地还没关」这两种不一致。

- 读取走 `acli`（`example.atlassian.net`，本机已登录），命令是
  `acli jira workitem search -j "key in (PROJ-103, …)" --fields "key,status,assignee,priority" --json`，
  一次批量读多张单（每 50 个 key 一批）。**这是外部请求，只在用户点「刷新 Jira」时发生**，页面渲染永远只读缓存。
- **刷新只读「还开着」的单**：已完成（done）和已归档（含归档 Epic 的子任务）的 key 不重复读——它们不会再变，界面继续显示上次缓存值。点刷新时按钮旁会写明本次读了几张、跳过了多少。
- 缓存文件：`~/.pi/dashboard/jira-status.json`（0600）。30 分钟（`JIRA_TTL_MS`）后视为过期，界面标「· 过期」但不自动重读。
- `acli` 不可用、未登录、单子被删或没权限时：界面保留旧缓存并显示原因，任务列表照常渲染，不会因为 Jira 失败而报错。
- 实测规模（2026-10-28）：全量 278 个 Jira 号时约 19 秒；收窄到未完成的 47 个 key 后约 3.3 秒，跳过 34 张已完成 + 197 条归档；界面仍能显示 274 个已知状态。
- 已知限制：这版 `acli` 的 `--fields` 不接受 `duedate`（报 `field 'duedate' is not allowed`），Sprint/故事点同样需要另找字段名，所以截止日、Sprint、故事点暂不显示。

### 4.3 服务面板：`~/.pi/services.json`

和服务页面（`/services`）配套的清单，**不在 `dashboard.json` 里**：它是一个独立文件，按机器维护「有哪些服务、怎么启停、探哪个地址」。字段与语义见 [services.md](services.md)。

只改这个文件就能增删服务，刷新页面即生效，不需要重启 dashboard。

### 4.4 `vault`：Obsidian 笔记目录（可选）

System 页的「Vault / 日常笔记」卡片从这里读：只统计各子目录里的 `.md` 文件数，按天读 `daily/<日期>.md`，**不建索引、不写入**。

```json
{
  "vault": {
    "path": "/home/you/notes",
    "dirs": {
      "daily": "Daily",
      "tasks": "TaskNotes/Tasks",
      "meetings": "Meeting Notes",
      "people": "People",
      "recipes": "Recipes"
    }
  }
}
```

| 字段 | 作用 |
|---|---|
| `path` | vault 根目录，**必须写绝对路径**：`~/` 在这里不会展开（写 `~/notes` 会当成字面目录，统计全是 0）。空着或目录不存在时这些卡片显示 0，不报错、不影响其它页面 |
| `dirs` | 子目录名，**相对 `path`**；省略则用上面示例里那组默认值。五个键含义：`daily` 日常笔记、`tasks` 任务笔记、`meetings` 会议、`people` 人物、`recipes` 菜谱 |
| `dirs.daily` | 除了统计条数，「日常笔记」每天的内容也从这里读（`<dirs.daily>/YYYY-MM-DD.md`） |

### 4.5 主 Agent 工作监督（可选，默认关闭）

`dashboard.json` 的 `supervisor` 段控制专用主会话。它不是全局 Pi 扩展安装配置；普通会话不会加载这些资源。保留已有配置，只合并此段：

```json
{
  "supervisor": {
    "enabled": true,
    "name": "ts",
    "cwd": "~/repos/pi-dashboard",
    "pollIntervalMs": 120000,
    "staleAfterMs": 900000,
    "allowedObjects": ["*"],
    "allowedSessionIds": ["*"],
    "allowedRoots": ["~/repos/pi-dashboard"],
    "eventTypes": ["progress", "reply", "blocked", "resumed", "decision", "result"],
    "agentResources": {
      "rolePath": "~/repos/pi-dashboard/agent/supervisor/role.md",
      "skillPaths": ["~/repos/pi-dashboard/agent/supervisor/skills/dashboard-supervisor"],
      "extensionPaths": [
        "~/repos/pi-tsien-extension/extensions/supervisor/index.ts",
        "~/repos/pi-tsien-extension/packages/pi-tsien-live-session/src/index.ts",
        "~/repos/pi-tsien-extension/packages/pi-tsien-goal/src/index.ts"
      ],
      "mode": "observe",
      "subagents": true
    }
  }
}
```

路径是当前开发机示例，其他机器填写各仓库的真实绝对路径。`cwd` 必须位于 `liveSessions.roots` 内，LiveSession broker 必须启用，并使用支持 `--no-context-files` 等隔离参数的当前 Pi fork。

**资源路径可以省略，省略时按仓库位置推导**：`cwd`、`rolePath`、`skillPaths` 取面板仓库自身（`agent/supervisor/…`），`extensionPaths` 取与面板仓库同级的 `pi-tsien-extension`。因此整个仓库搬到新位置后不需要改这一段配置；只有资源放在非常规位置时才显式写绝对路径。保存配置（`PUT /api/supervisor/config`）时只写与这些默认值不同的路径项，不会把推导出来的机器绝对路径写回 `~/.pi/dashboard.json`。

- `name`：界面上怎么称呼这个主会话（弹窗标题、会话标题），同时写进它的系统提示，用户可以直接用这个名字指代它。不填或不合规（1–16 个字母/数字/下划线/连字符，支持中文）时回落到 `ts`。改名算配置变更，正在跑的主会话需要结束后重启才生效。
- `agentResources.subagents`：开启后给主会话加上子 Agent 工具（`subagent_start` 等）并自动加载 `pi-tsien-subagent-workbench` 扩展。子 Agent 只读：流水账整理和会话巡查在子 Agent 里跑，档案写入、待办和通知仍由主会话用 `supervisor_*` 完成。默认关闭。
- **清空 ≠ 换配置**：主会话里的 `/supervisor-clear`（或界面「清空并重新加载」）只重建会话运行时。它会重新读取角色文件、Skill 文件和扩展**代码**，所以改这些内容清空后即生效；但扩展清单（`extensionPaths`）、系统提示文本（含 `name`）和工具白名单来自进程启动参数，清空不会更新，也不和后端重新握手。改名或开关 `subagents` 后必须结束旧主会话进程再启动；配置指纹不一致时后端也会直接拒绝清空。
- `allowedObjects`：空数组不授权任何任务；`*` 才显式授权全部可用任务，可限制为具体 UID 或 `local:*`。限制范围时创建本地任务需包含允许本地创建的范围。
- **截图怎么进档案**：用户在弹窗里上传的截图由页面存档并把 `attachmentIds` 写进消息；用户在会话面板里直接粘贴的截图由扩展在回合开始时自动存档（`attachment_put`，仅用户轮允许），随后把 id 作为本轮提示交给主 Agent，记录时带进 `attachmentIds`。日志只记录真实 id；正文不落 base64。
- **写入授权只看回合来源，不再有确认弹窗**：自动巡查轮由服务在提示前加机器标签 `[supervisor-auto-patrol]`，扩展据此把该轮标为 `userTurn: false`，其中的创建/修改一律被网关拒绝；其余提示（用户在弹窗、会话页或面板里直接说的话）都算真实用户轮，主 Agent 直接写入，**不弹确认、也不需要用户回「确认」**。弹窗消息额外带 `[supervisor-user-grant:…]`，只用于把用户原话写成事件的审计引用。可选的界面确认（`supervisor-confirm` 卡片、侧栏「待确认」角标）已不再产生，相关代码保留但处于休眠状态。代价：主 Agent 可以在用户没点名的情况下自行落库，审计仍记录 `actor=主 Agent` 与来源会话。
- `allowedSessionIds`：空数组不授权任何会话；`*` 才显式授权全部已接入会话（仅观察）。协调仍必须逐个列出目标 sessionId，不能用 `*` 代替。不会以 processInstanceId 作为长期授权身份。
- `allowedRoots`：仅这些目录可读文本/单层目录检查；空数组禁止文件检查。不得把凭证、档案目录放入检查范围。
- `pollIntervalMs`：最短 60 秒，默认 120 秒；只在主 Agent 空闲且目标状态/最后回复发生变化时发起检查，不自动启动未运行的主会话。
- `staleAfterMs`：默认 15 分钟，只是无活动提示，不证明失败或真实工时。
- `eventTypes`：事件类别词表，默认 `progress`、`reply`、`blocked`、`resumed`、`decision`、`result`。写入不在词表内的事件 `type` 会被拒绝（`invalid_event_type`），避免自由文本导致年末按类别汇总漏项；`working_state`、`suggestion` 是系统专用类型，始终可用且不必（也不能）写进词表。留空或省略即用默认词表；自定义类别在此列出，最多 32 个、小写标识符（字母开头，可含数字、`_`、`-`，最长 32 字符）。这是给主 Agent 记录用的，不影响已有历史事件。
- `agentResources.allowedTools`：省略时使用专用监督工具白名单；不支持任意 Bash、编辑工具。Skill 的判断规则不替代后端权限。
- 主会话启动固定使用 `--no-extensions` + 显式 `--extension`，并且用 **`--no-builtin-tools`**（不要用 `--tools` 清空工具，那会连扩展工具一起禁用，监督扩展会直接报“可用工具缺失”而退出）。
- **资源指纹只做提示，不再拦任何调用**：主会话启动时把当时的三个指纹（启动形状 `revision`、角色/Skill 文本 `contentRevision`、扩展源码 `extensionsRevision`）写进凭据，之后每次 `supervisor_context` 比对一次，落后就返回 `resourceNotice` 让人知道“重启才生效”，**读写通道都照常可用**。历史原因：早期版本拿指纹做门禁，改一段提示词就把在跑的主会话整条 403，属于自找麻烦，已去掉（用户决定）。监督台的 `extensionsStale` 只覆盖扩展代码这一种落后。
- **启动命令追加的 flag 必须由已加载扩展提供**：因为主会话关闭了扩展自动发现，launcher 脚本（如 `pi-clean`）硬编码的 `--goal-continuation` 需要把 `packages/pi-tsien-goal/src/index.ts` 加进 `extensionPaths`，否则 pi 会以“Unknown option”直接退出，表现为 `live_pi_registration_timeout`（且启动输出为空）。换 launcher 或加自定义 flag 时同理。- `mode`：默认 `observe`；`coordinate` 允许向明确授权且空闲、未被用户占用的会话发送有证据的协调建议。不会自动回答敏感确认、重启会话或执行发布操作。

先在 LiveSession 认证面板完成浏览器认证。若尚无任何范围，监督台提供明确标注“授权全部已接入任务和会话”的启用按钮；已有范围则沿用配置，不隐式扩大。启用不会自动启动模型，需再从全局“主 Agent”弹窗启动专用会话。启动参数关闭普通资源/上下文自动发现，显式加载本段指定资源和必需的 LiveSession 桥。新增资源不写入全局 `~/.pi/agent`。

配置经受保护的 `/api/supervisor/config` 更新；保存时省略与默认推导一致的资源路径（见上），只保留用户的显式偏离项。手动编辑文件后需要用户按自己的启动方式重启服务，避免内存缓存仍使用旧配置。运行中改配置或资源文件都不会拒绝旧授权（不再 403）：正在跑的主会话继续按启动时的配置工作，只是 `supervisor_context` 会提示“重启后生效”。要让新配置真正生效仍需用户手动结束旧主会话再启动，Dashboard 不自动中断它。

档案保存在 `~/.pi/dashboard/supervisor/`，目录 0700、文件 0600；Unix 工具通道和凭证也在此目录，不分享凭证。截图持久保存而非临时目录，JPEG/PNG/WebP 每张最多 3 MiB，事件关联最多 4 张/共 6 MiB。第一版不自动删除历史；启用前确认备份/保留和敏感信息处理要求，不上传未经脱敏的凭证或私人截图。

### 4.6 私有机器连接（可选，实验性）

不通过环境变量传密钥。手动在 `<agent dir>/machine-connector.json` 创建权限严格为 `0600` 的普通文件（不可为符号链接），内容仅允许：

```json
{"endpoint":"wss://your-hub.example/machine/v1","machineId":"machine_1","key":"<32-byte-random-key-in-canonical-base64url>"}
```

`endpoint` 必须通过 WireGuard 私网路由到入口机、使用与域名匹配的有效证书的 `wss://`，路径固定 `/machine/v1`，无用户信息、查询或 fragment；`machineId` 只允许 1–64 位 ASCII 字母、数字、`_`、`-`。密钥须由可信的私有 hub 单独发放；示例并非真实端点或凭证。缺文件默认禁用；权限、字段或地址无效则禁用并仅打印通用错误，不输出密钥。修改后由用户自行重启服务生效；不可在 dashboard Settings/API 中编辑此文件，也不要提交到 git 或放进 `dashboard.env`（环境变量会传给 pi 子进程）。

启用控制前，后端必须在 `$HOME/.pi-dashboard-private/`（当前用户所有、严格 `0700`、家目录不得被组/其他用户写入）初始化 `machine-input-replay.json`；它与独占运行锁 `.lock` 均为当前用户所有的 `0600` 普通文件。文件仅保存 clientId + UUID 的 SHA-256 摘要，不保存输入文本、原始标识或凭证。每次输入在交给 Pi 之前，先写临时文件并 fsync、原子替换且 fsync 父目录；同一 ID（即使修改内容）永远视为不确定，不自动重试或清理。最多 100000 条，不淘汰；满额、文件损坏、权限/所有者不安全、符号链接或磁盘错误均拒绝新输入（启动时无法初始化则关闭出站连接）。崩溃留下的 `.lock` 需要管理员确认进程已退出并检查文件后手动处理；不要删除 replay 文件或把它暴露给 HTTP/日志。备份/迁移必须保留该文件及其权限，否则旧 ID 可能再次执行。

连接接受已认证 hub 的 `list_sessions` 请求，只返回最多 50 条来自 live-session registry 的 `processInstanceId`、`sessionId`、`status`（idle/running/reconnecting），不传 cwd、pid、文件名、模型、claim 或消息。认证完成后还允许固定结构的远程会话声明、释放和短文本输入；机器侧验证目标及租约，输入超时或重复请求不自动重试，断链时尽可能释放该连接的远程租约。仅可读取选中会话最近最多 8 条已完成用户/助手纯文本的受限预览，不提供完整 transcript、工具输出、路径/图片，也不会代理 HTTP 或执行任意 Pi 命令。WSS 证书验证保持启用；连接失败会持续按最多 30 秒的有界退避重连；关闭 dashboard 会停止重连。配置文件存在时，服务启动前强制要求 `PI_DASH_HOST=127.0.0.1`，否则拒绝启动，避免工作机暴露 Dashboard 入站端口。参见 [dashboard.md](dashboard.md)。

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