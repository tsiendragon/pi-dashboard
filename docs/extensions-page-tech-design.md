# Extensions 管理页面 — 技术设计

状态：**设计稿（未开工）**。作者：agent，2026-09-25。目标仓库：`tsiendragon/pi-dashboard`。
关联：`docs/config-inventory.md`（配置盘点）、`docs/extension-config-ui.md`（已实现的配置卡片）、
`pi-tsien-extension/docs/pi-extension-management.md`（同步器语义）。

## 0. 结论摘要

- 诉求全部**可行**，但依赖三块 pi 宿主已有的原语：`settings.json` 的 `extensions[]` 数组顺序 = 加载顺序；
  `+/-/!` 前缀 = 非破坏性启停；`pi install/remove/list/update` = 安装管理。新页面的主体工作是**聚合 + 写回**。
- 有两件事必须先定，否则会做出「改了不生效」或「下次同步被回滚」的功能：
  1. **真源冲突**：同步器（strict prune）与页面写的是同一个 `settings.json.extensions[]`，语义不同（见 §3）。
  2. **`pi-tsien-extension` 的 manifest 顺序是错的**：它声明 `./extensions/*.ts`（glob），而 pi 展开 glob 会**按字母排序**，
     与仓库声明的 25 条 `loadOrder` 有 **11 处不一致**（见 §9）。想「像开源扩展一样一条命令装」必须先修这个。
- 分四阶段，P1+P2 是价值主体（约 1.5 天），P3 复用现成 CLI（约 0.5 天）。
- 追加：**按功能拆成若干独立 package**（monorepo，仍在 `pi-tsien-extension` 统一管理）可行，见 §12；
  但「用户可选装」在本机/受管环境下用前缀启停就够了，拆包的真实收益是**分发给别人**与**独立版本**。

## 1. 目标 / 非目标

**目标**：一个页面完成 — 列出真正生效的扩展、看清来源（哪个 package / 单文件）、版本、加载顺序、
逐个启停、就地改配置、看清依赖关系（含推断标注）、搜索并安装/卸载开源扩展。

**非目标（本轮明确不做）**
- 扩展热重载（宿主不支持，见 §8）；自动/静默安装任意开源扩展；把 25 个扩展拆成 25 个 npm 包；
  跨机器同步扩展清单（那是同步器/Ansible 的事）。

## 2. 现状事实（全部经代码核对）

| 事实 | 证据 |
|---|---|
| `settings.json.extensions` 是**绝对路径数组**，顺序即加载顺序；`packages[]` 是 `{source, autoload}` | 本机 `~/.pi/agent/settings.json`：`extensions` 29 条字符串、`packages` 5 条对象 |
| 启停是**非破坏性前缀**：`-path` 强制排除、`+path` 强制包含、`!path` 排除，支持 glob | `packages/coding-agent/src/core/package-manager.ts:709-750`；写入方 `modes/interactive/components/config-selector.ts:532-640` |
| package 通过 `package.json` 的 `pi` 字段声明自己的资源（`extensions`/`skills`/`prompts`/`themes`） | `core/pi-manifest.ts:11,17-29` |
| manifest 里的 glob 会被展开并**字母排序** | `core/package-manager.ts:288-296`（`expandPackageGlob` 带 `.sort()`），调用点 `:2324` |
| `autoload:false` 是刻意设计：包仍安装，但不自行打乱扩展顺序 | `pi-tsien-extension/docs/pi-extension-management.md:44` |
| 安装/卸载/更新/列表/交互式启停都有 CLI | `pi --help`：`install` `remove` `uninstall` `update` `list` `config` |
| dashboard 已有：gallery（npm keyword `pi-package` 搜索）、install/remove 转发 CLI、settings 整份 GET/PUT | `backend/routes/system.ts:314-347`、`237` |
| **缺口**：现有 `/api/pi/extensions` 只列 `<agent>/extensions/*.ts`（自动发现目录），**不反映真正加载的清单** | `backend/pi-env.ts:310-326` |
| 部分扩展**要求补丁版 pi**：`executeTool`、`extension_ui`、`respondExtensionUi`、`extension_ui_notify` 在上游 `main` 中**不存在** | `git show upstream/main:...extensions/types.ts \| rg -c <api>` = 0；`tsien` = 2~5 |

## 3. 数据模型与「真源」冲突（必须先决策）

会写 `settings.json.extensions[]` 的有两方：

- **pi 原生 / 新页面**：数组 + `+/-/!` 前缀，语义是「顺序 + 覆盖」。
- **同步器 `pi-extension-sync.mjs`（strict 模式）**：按**精确路径集合**增删（`:228-243`），
  并把 `-path` 这种条目当成陌生条目处理 → **页面里禁用的扩展，下次 `--apply` 会被悄悄恢复**。

另有一处语义重叠：仓库文档写「从 `loadOrder` 删除一项会停用该 extension」（`pi-extension-management.md:43`），
即同一件事有两条实现路径。**设计上统一到前缀**（可回滚、有审计、与 pi 原生一致），同步器负责「保留而非清理」前缀。

**决策（待你选）**
- **甲（推荐）**：同步器只对**无前缀**条目做增删，保留 `+/-/!` 条目（约 10 行改动，加 1 个回归测试）。
  → 页面禁用永久有效，两种工具互不干扰。
- **乙**：页面改动回写 `extensions.config.json`（新增 `disabledExtensions: []` 段），同步器仍是唯一真源。
  → 语义最干净，但页面必须依赖同步器才能生效，装/卸路径变长。

## 4. 页面信息架构

```
Extensions 页
├─ 顶部：模式（受管/全部）、搜索、刷新、与声明清单的 diff 提示
├─ 列表（每行）
│   名称 · 类型徽章（package:tsien / 单文件 / 未声明）· 版本 · 顺序 #n · 开关
│   健康点（文件存在/加载报错/需要补丁版 pi）· 展开 → 配置卡片 · 依赖
├─ 分组：① 由 package 提供 ② 直接路径（单文件） ③ 自动发现未纳管（可一键纳管/隔离）
└─ 安装区（独立标签页）：gallery 搜索 · 安装/卸载/更新 · 操作历史
```

复用：配置卡片直接用已实现的 `GET/PUT /api/ext/config`（`plugins/pi-extension-config`）。

## 5. API 设计

| 方法/路径 | 作用 | 备注 |
|---|---|---|
| `GET /api/pi/ext/list` | 生效清单 + 归属 + 版本 + 顺序 + 启停 + 健康 | 取代现有 `getExtensions()` 的误导性结果 |
| `POST /api/pi/ext/toggle` | `{path, enabled}` → 写 `+/-` 前缀 | 非破坏性，幂等 |
| `PUT /api/pi/ext/order` | `{paths[]}` → 重排无前缀条目 | 写入前校验顺序约束（§6 第 2 类） |
| `GET /api/pi/ext/deps` | 依赖图（含 `confidence: declared\|derived\|heuristic`） | 见 §6 |
| `GET/PUT /api/ext/config[/:name]` | 扩展配置文件 | **已实现** |
| `POST /api/pi/packages/install\|remove\|update` | 装/卸/升级 | **已存在**，需加「备份 + 审计 + 确认」 |
| `GET /api/pi/ext/export` | 导出当前清单（可贴回 `extensions.config.json`） | 便于甲方案下的人工对齐 |

**写入安全（必须）**
1. 所有写操作走后端**单一串行模块**（读-改-写 + 互斥）：现在 `/api/pi/settings` 是**整份 PUT**
   （`system.ts:237`），新页面也写同一文件 → 并发会互相覆盖。建议把 SettingsPage 的 PUT 也改走同一模块。
2. 写前把 `settings.json` 备份到 `<agent>/backups/settings-<ts>.json`，返回前后 diff，页面显示 diff 再确认。
3. 原子写（临时文件 + rename），与已实现的 `ext-config` 路由一致。

## 6. 依赖关系：四类，必须标注可信度

pi **没有**声明式依赖机制，所以页面不能假装有。可给出四类：

| 类 | 来源 | 可靠性 | 例子 |
|---|---|---|---|
| ① 归属 | package `pi.extensions`（manifest） | 声明（可靠） | `pi-web-tools` → `src/index.ts` |
| ② 顺序约束 | 同步器 `loadOrder` / 生效 `settings.extensions[]` 顺序 | 声明（可靠） | `packages` 顺序=安装顺序，`loadOrder`=初始化顺序（`pi-extension-management.md:11-12`） |
| ③ 文件级 import | 静态扫描 `import ... from "./x.ts"` | 可靠但只覆盖显式导入 | `extensions/live-session.ts:11` import `./auto-compact-target/core.ts` |
| ④ 宿主能力 | 扫描已知补丁 API 用法 + 运行时 throw 文本 | **启发式，必须标「推断」** | `extensions/ptc.ts:748` 要求 `executeTool`；`live-session.ts:1005` 用 `extension_ui` |

**UI 上要显式提示的一条语义**：`③` 意味着**禁用 ≠ 卸载代码** —— 把 `auto-compact-target` 关掉，
`live-session` 仍会 import 它的模块。页面必须在「禁用」确认框里写清这一点，否则用户会误以为获得了隔离。

## 7. 版本显示策略（诚实优先）

| 来源类型 | 版本可得性 | 展示 |
|---|---|---|
| npm package | 真版本 | `package.json.version` + registry 最新版（可提示升级） |
| git package | 真版本 + commit | `package.json.version` + `git describe/rev-parse`（升级=比对远端） |
| 本地路径 package | 半真 | 同 git（若是 git 仓库）；否则只显示 mtime |
| **单文件扩展** | **无版本概念** | 显示 git 仓库 + commit（若在仓库内）或文件 hash/mtime，**不伪造版本号** |

## 8. 安全与边界

- **安装 = 任意代码执行**：npm/git package 在会话启动时被 import。必须二次确认 + 展示来源
  （包名、版本、维护者、发布时间、下载量），并记录审计日志；默认不允许「一次装多个」的批量静默安装。
- **鉴权**：dashboard 现有部署可能是内网/隧道（`docs/remote-access-deployment.md`）。暴露公网时该页必须鉴权。
- **生效时机**：扩展只在会话启动时加载 → 改动后需要**新开会话**。实测 `/reload` **不会**重载扩展代码
  （老会话仍跑旧代码）；页面要给准确提示，不要照抄 CLI 的「/reload 生效」。
- **回滚**：每次写操作都可一键还原（备份 + diff）。

## 9. 「pi-tsien-extension 能否像开源扩展一样安装」

**能，但有两处前置**（都已核对）：

1. **顺序**：`package.json` 现在声明 `pi.extensions = ["./extensions/*.ts"]`。pi 展开 glob 会**字母排序**
   （`package-manager.ts:288-296`），而我们的 `loadOrder` 不是字母序 —— 实测 25 条里
   **11 处位置不一致**（位置 1,2,4,14-22,24；例：`tool-result-pipeline.ts` vs `00-zero.ts`）。
   → 修法：manifest 里**显式列出 24 个文件**（顺序即加载顺序），不要用 glob。
2. **第二个包**：`vendor/pi-web-tools` 是独立 package（`pi.extensions=["./src/index.ts"]`），且被要求**第一个**初始化。
   → 要么让它成为 `pi-tsien-extension` 的 npm 依赖（单一来源），要么在安装说明里要求两条命令。

**关于「每个扩展单独安装」**：pi 的安装粒度是 **package**，不存在「从包里单独 npm 装某一个扩展」。
等价能力 = **装整包 + 用 `-path` 前缀逐个启停**（正是本页面要暴露的开关）。
按功能拆成 N 个包是另一条路（比 25 个包现实），见 §12。

三种分发路径对比：

| 路径 | 一条命令安装 | 顺序保证 | 适用 |
|---|---|---|---|
| **A. npm 私服发布**（内网 registry） | ✅ `pi install <pkg>` | manifest 显式列序后 ✅ | 想给别人「像开源一样装」 |
| **B. git URL** | ✅ `pi install git:github.com/tsiendragon/pi-tsien-extension` | 同上 | 公开/内网可达即可，无 registry |
| **C. 现状：本地 checkout + 同步器**（strict `loadOrder` + quarantine） | ❌ 需 `install-standalone.sh` | ✅ 最强（可校验、可收敛） | 受管环境/多机一致 |

建议：**A/B 与 C 并存** —— 仓库同时是合规 package（A/B），受管环境继续用同步器（C）。
前提是 §3 的甲方案落地，否则两种方式会互相回滚。

## 10. 分阶段计划与验收

| 阶段 | 内容 | 验收（可观测证据） | 估时 |
|---|---|---|---|
| **P0 前置** | 甲/乙决策；manifest 显式列序；同步器保留前缀（若选甲） | 同步器有回归测试；`pi install` 后顺序与 `loadOrder` 逐项一致 | 0.5 天 |
| **P1 只读页** | `GET /api/pi/ext/list` + 页面列表/分组/健康/依赖图（标推断） | 隔离 agent 目录起服务，列表与 `settings.json` 逐项一致；与现有误导性 `/api/pi/extensions` 对比截图 | 0.5 天 |
| **P2 可写** | toggle / order / 配置卡片 / 写前备份 + diff 确认 | 单测 + 端到端：启用→禁用→再启用，`settings.json` 前缀正确、顺序不变；并发写不丢改动 | 1 天 |
| **P3 安装管理** | gallery 搜索、安装/卸载/更新、审计与回滚 | 在隔离 HOME 真装一个公开 `pi-package` 并卸载；备份可还原 | 0.5 天 |
| **P4 可选** | 依赖图可视化、与声明清单 diff、加载错误展示 | —— | 视需要 |

## 11. 未验证项与开放问题

- 未实测「`autoload:true` 的 package + glob manifest」在真实会话里的加载顺序（本文用代码推断为字母序）。
- `/reload` 不重载扩展代码是本机实测结论，未做跨版本验证。
- dashboard 是否已有鉴权中间件（取决于部署方式），P3 前必须确认。
- gallery 目前只搜 npm 公开包（keyword `pi-package`）；内部 marketplace 的扩展是否需要一并展示，待定。
- 并发写同一 `settings.json` 的具体冲突场景未实测（预案见 §5）。

## 12. 按功能拆成多个 package（monorepo，repo 仍统一管理）

**结论：可行，而且是现有机制的自然延伸** —— `vendor/pi-web-tools` 本来就是第二个包，
同步器的 `packages[]` 天生支持多个来源。拆包不改变「repo 只有一个、由同步器统一管理」这一点。

### 12.1 用户「选装」的三条路径（实测约束）

| 路径 | 能否按子包装 | 证据 |
|---|---|---|
| npm 私服/公开包，一包一发 | ✅ 真正像开源扩展：每包一条 `pi install <pkg>` | `pi --help`：`pi install <source>` |
| git URL 装整个仓库 | ❌ **只认仓库根的 `package.json`**，不支持子目录 | `installGit` clone 后只查 `join(targetDir, "package.json")`（`package-manager.ts:1850-1856`） |
| 本地 checkout + `pi install <子包目录>` | ✅ 实测通过 | 隔离 HOME 实测：输出 `Installed .../vendor/pi-web-tools`，写入 `packages:["../../../../mnt/..."]`，**未写 `extensions`**（走包 autoload → manifest 顺序，故 §9 的顺序修复是前提） |
| 同步器（现状） | ✅ 已支持多包 | `packages[]` + `loadOrder` |

### 12.2 耦合实测（决定怎么切）

- 24 个顶层扩展中 **10 个完全没有跨模块 import**；**9 个只 import 自己目录**（含 4 个一行 re-export 桩：`00-zero`/`goal`/`memory`/`subagent-workbench`）。
- 真正的跨功能耦合只有 5 处，集中在两个共享模块：
  - `extensions/lib/`（`dashboard-bridge`、`live-observer`、`command-ui`、`background-commands`）← `btw`、`live-session`、`running-commands`、`schedule`
  - `auto-compact-target/core.ts` ← `live-session`、`context-powerline`
- ⇒ **必须把 `lib/` 与 `auto-compact-target/core.ts` 抽成基础包被依赖**，不能靠复制，否则 4 份 `lib/` 必然漂移。

### 12.3 建议切法（5 + 1 个包，按「用户会一起选/不选」切）

| 包 | 内容 | 依赖 |
|---|---|---|
| `pi-tsien-core` | `lib/`（dashboard-bridge、live-observer、command-ui、background-commands 配置）、`auto-compact-target/core.ts` | 无 |
| `pi-tsien-live` | live-session、btw、running-commands、schedule、session-aliases、metrics-sidebar、sidebar、context-powerline | core |
| `pi-tsien-tools` | tool-result-pipeline(+bash-digest)、ptc、subagent-workbench、observation-pack、trajectory-recorder、compact-continue、auto-compact-target(功能层) | core |
| `pi-tsien-memory` | memory(tsien-memory)、capability、prompt-inspector、default-system-prompt、goal、00-zero(pi-zero) | core |
| `pi-tsien-extra` | git-graph、usage-analytics、effort（展示/统计类） | 无 |
| `pi-web-tools`（已独立） | `src/index.ts` | 无 |

原则：**包内允许耦合，包间只允许依赖 core**；每包 `package.json` 的 `pi.extensions` **显式列序**（不用 glob）。

### 12.4 成本与风险

- 内部依赖跨包：npm 安装时依赖必须能在 registry 解析。走私服则 `core` 必须一起发布；走本地路径则不涉 registry，但用户要 clone。
- 顺序：包内顺序由 manifest 决定；**包间顺序**仍需约定（`packages[]` 的相对顺序 + `loadOrder` 全局序）。
- 机械改动量大（移动目录 + 改 import 路径 + workspace 配置 + CI 从 1 套变 N 套），测试是主要保障；npm workspaces 可一条命令全跑。
- 收益：①可按需装 ②依赖图变成**真实的包级边** ③改一个功能不动整包 ④版本独立。
- 代价 vs 收益提示：**只在本机/受管环境选装**时，§5 的前缀启停就够；拆包的净收益在「分发给别人 + 独立版本」。

### 12.5 与其它部分的关系

- 同步器：只需支持多个本地/私有来源（已支持），`loadOrder` 变为「按包分组、保持全局序」；§3 的前缀保留仍需先做。
- 页面（§4/§6）：列表按包分组展示，依赖图直接画包级边 + 包内扩展；`pi install` 粒度=包，与页面一致。
- 估时：拆分重构 + workspaces + 测试绿 ≈ 1 天（机械但面广）；发布到私服再 +0.5 天。