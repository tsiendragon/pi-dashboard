# 配置盘点：有哪些 config、谁在读、哪些能在 dashboard 里改

生成于 2026-09-25（本机 `tsien@DSW`）。用途：加新扩展或排查「改了没生效」时先照这张表对位置。

## 1. 四层结构

| 层 | 位置 | 谁读 | 必须？ | dashboard 能改？ |
|---|---|---|---|---|
| **宿主 pi** | `~/.pi/agent/settings.json` | pi（默认模型、`enabledModels`、主题、`powerline`、`compaction`、`extensions`/`packages` 列表） | 是 | ✅ `/api/pi/settings`（**整份读写**，PUT 覆盖） |
| | `auth.json` | pi（provider 凭证） | 是（或用环境变量） | ❌（`/login` 或 `dashboard.env`） |
| | `models.json` / `models-store.json` | pi（模型清单、自建模型） | 是（自动维护） | ❌ |
| | `AGENTS.md` / `DefaultSystemPrompt.md` | pi（系统提示） | 否 | ❌ |
| | `keybindings.json` / `trust.json` | pi | 否 | ❌ |
| | `sessions/`、`skills/`、`bin/`、`local/` | pi | 混合 | ❌ |
| | `extensions.config.json` | 同步器（声明装载清单） | 是（standalone 安装用它） | ⚠️ 间接（Extensions 页装卸 package 落到 settings.json；`/api/pi/packages/*` 仍保留为 API 面） |
| **扩展（每个一份 JSON）** | `bash-digest.json`、`observation-pack.json`、`large-read-pack.json`、`auto-compact-target.json`、`compact-thinking.json`、`capability.json`、`claude-code-style.json` | 各扩展自己（缺失即用内置默认值） | 只有你在用的 | ✅ Settings → general → **Extension config** |
| | `theme.json`、`tsien-memory.json`、`rtk-config.json` | 各自的扩展 | 否 | ❌（前一个是可选覆盖文件，后两个按项目 `<cwd>/.pi/` 解析） |
| **进程环境变量** | `~/.pi/agent/dashboard.env`（dashboard 启动时加载，并传给每个 pi 子进程） | dashboard + 它派生的所有 pi | 部分（`PI_SCRIPT`、凭证、数据目录） | ❌（但已收敛成**唯一**入口） |
| **dashboard 自己** | `~/.pi/dashboard.json`（`liveSessions.roots/launch/unsetEnv/disconnectGraceMs`） | dashboard 后端 | 是（live session 靠它） | ✅ `/api/dash/config` |
| | `~/.pi/agent/pi-web-sessions.json`（slot 元数据） | `backend/session-store.ts` | 自动 | 自动维护 |
| **启动器** | `~/.local/bin/pi-clean` → `~/.local/bin/pi` → `/home/tsien/local-pi/bin/pi` | live session 进程 | 否 | ❌ 脚本 |

## 2. 环境文件（唯一入口）

`~/.pi/agent/dashboard.env` 现在承载：`PI_TRACE_DIR`、`PI_TIMING_DIR`、`PI_SCRIPT`。
加载顺序（先到先得，已存在的 shell 变量优先）：`$PI_DASH_ENV_FILE` → `<repo>/.env` → `<agent dir>/dashboard.env`。
细节见 [env-configuration.md](env-configuration.md)。

## 3. 扩展配置文件一览（本机现状）

| 文件 | 状态 | 说明 |
|---|---|---|
| `bash-digest.json` | 已建 | 启用，摘要模型 `dashscope/qwen3.8-flash` |
| `observation-pack.json` | 已建 | 启用，`archiveDir=/mnt/workspace/lilong/agent/archiv`（显式钉住旧位置） |
| `compact-thinking.json` | 已建 | 显示细节 |
| `capability.json` | 已建 | 指向 marketplace 的 capabilities 目录 |
| `auto-compact-target.json` | 2026-09-25 生成 | 内容 = 内置默认值，仅为了可见/可调 |
| `claude-code-style.json` | 2026-09-25 生成 | 同上 |
| `large-read-pack.json` | 已删 | 实测否决且默认关闭，代码保留，需要时点「创建并保存」即可恢复 |

## 4. 已清理（2026-09-25）

先归档再删，可回滚：

- `/home/tsien/pi-config-cleanup-20260925.tar.gz`（95 项，2.0 MB）：`extension-sync-backups/`(18)、
  `extension-quarantine/`(11)、`~/.pi/agent/backups/`(2)、`memory-backups/`(1)
- `/home/tsien/pi-backups-cleanup-20260925.tar.gz`（3 项，890 KB）：`~/.pi/backups/`
- 直接删除：`eagleye-install.yaml`（拼写错误的重复文件，市场工具只认 `eagleeye-install.yaml`）、
  `large-read-pack.json`（已否决）、`pi-crash.log`

保留未动：各类 `.bak-*` 备份（按用户要求先不管）、`~/.pi/knowledge-backups/`。

## 5. 统一策略（当前结论）

不做「所有扩展配置合成一个文件」的大改：每个扩展一份 JSON 是扩展包的设计（各自 `CONFIG_FILE_NAME`），
合并要动十余处代码且失去单扩展回滚能力。已经收敛的三处：

1. 环境变量 → 只留 `dashboard.env`
2. 配置目录 → 统一在 `~/.pi/agent/`
3. 需要人改的开关 → Extension config 区块（本仓库 `plugins/pi-extension-config`）

## 6. 关于 `pi-web-sessions.json` 能否并入 `dashboard.json`

**不建议**，理由是写入语义冲突：

- `dashboard.json` 是**用户配置**，Settings 页用 `PUT /api/dash/config` **整份覆盖**；
- `pi-web-sessions.json` 是**运行时状态**（slot 元数据），`backend/session-store.ts` 频繁写；
- 两者同文件后，任何一次配置保存都会冲掉当时的 slot 状态，反之亦然。

若目标只是「少几个文件」，可行替代是把状态文件挪到已有的 dashboard 专属目录：`~/.pi/dashboard/sessions.json`
（需改 `session-store.ts` 与两个测试）。要不要做由需求决定，不属于本轮改动。