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

### 3.1 具体会发生什么（一个例子）

1. 你在页面上把 `sidebar` 关掉。pi 的原生做法是往 `settings.json.extensions` 里写一条 **`-/…/extensions/sidebar.ts`**
   （前面一个减号 = 禁用），而不是删掉那一行——关了就只是“被排除”，随时可恢复。
2. 下次跑同步器（`install-standalone.sh` 或手动 `--apply`）时，它拿 `extensions.config.json` 里的
   `loadOrder` 去对齐 `settings.json`：它只认“路径完全相等”的条目，`-/…/sidebar.ts` 与
   `/…/sidebar.ts` 不相等 ⇒ 它认为“这个禁用品是陌生的”并删掉，同时把无前缀的 `/…/sidebar.ts` 补回去。
3. 结果：**你刚关掉的扩展被悄悄打开了**，而且没有任何提示。

### 3.2 两种修法（甲/乙）

- **甲（推荐）**：改同步器——看到以 `+`/`-`/`!` 开头的条目就**原样保留**，只对无前缀条目做增删。
  改动约 10 行 + 1 个回归测试。效果：两边各管各的，页面禁用永久有效，不需要额外流程。
- **乙**：页面不直接改 `settings.json`，而是在 `extensions.config.json` 里新增一段 `disabled: []`，
  由同步器统一写入 `-` 前缀。效果：单一真源、语义最干净；代价是**页面上的禁用必须先跑一次同步器才生效**，
  且“装/卸”路径变长（多一层间接）。

另有一处语义重叠：仓库文档写「从 `loadOrder` 删除一项会停用该 extension」（`pi-extension-management.md:43`），
即同一件事有两条实现路径。**设计上统一到前缀**（可回滚、有审计、与 pi 原生一致）。

若完全不用同步器（非 strict 管理），则不存在此冲突。

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

> **已落地（2026-09-26）**：写接口（toggle / order / 扩展配置 PUT）统一走 `backend/routes/require-browser-auth.ts`，
> 复用 live-session 浏览器认证（`pi_live_session` cookie）；未认证 401、跨域 403。只读接口保持开放。
> 原设计里 P3 的「先确认 dashboard 是否已有鉴权」由此回答：**没有全局鉴权，但已有可复用的 live-session 信任边界**。

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

### 12.3 细粒度切法（一功能一包，采纳）

> 包名以 §12.8 为准（本节表内的是早期草案名）。

原则：**一个具体功能 = 一个包**，一个包只声明一个扩展；共享代码下沉到 `core`
（依赖图是一棵树、无环，feature 包保持纯粹）。共 **25 个包**（1 共享库 + 24 功能扩展；其中 3 个为 `-fork`），
另有 `pi-tsien-web-tools-fork`（自维护副本，发布待上游许可，见 §12.8）。

**共享基础（不是扩展，不声明 `pi.extensions`）**

| 包 | 内容 | 被谁依赖 |
|---|---|---|
| `pi-tsien-core` | `lib/`（dashboard-bridge、live-observer、command-ui、background-commands）+ 压缩工具 `auto-compact-target/core.ts` | btw、live-session、running-commands、schedule、auto-compact-target、context-powerline |

**功能包（每包一个扩展；「自有目录」一并移入该包）**

| # | 包名（均在 `@tsiendragon/` 下） | 内容 | 依赖 core | 备注 |
|---|---|---|---|---|
| 1 | `pi-tsien-web-tools` | `vendor/pi-web-tools`（已独立） | — | 排第一初始化 |
| 2 | `pi-tsien-tool-result-pipeline` | 目录（含 `bash-digest/`） | — | |
| 3 | `pi-tsien-zero` | 桩 + `pi-zero/` | — | |
| 4 | `pi-tsien-btw` | 目录 | ✅ | |
| 5 | `pi-tsien-auto-compact-target` | 目录（功能层；共享部分已在 core） | ✅ | |
| 6 | `pi-tsien-context-powerline` | 单文件 209 行 | ✅ | 用 core 的压缩工具 |
| 7 | `pi-tsien-compact-continue` | 单文件 40 行 | — | |
| 8 | `pi-tsien-default-system-prompt` | 单文件 69 行 | — | |
| 9 | `pi-tsien-effort` | 单文件 47 行 | — | |
| 10 | `pi-tsien-git-graph` | 单文件 393 行 | — | |
| 11 | `pi-tsien-goal` | 桩 + `goal/src` | — | |
| 12 | `pi-tsien-live-session` | 目录 1119 行 | ✅ | 要求补丁版 pi（`extension_ui`） |
| 13 | `pi-tsien-memory` | 桩 + `memory/src` | — | |
| 14 | `pi-tsien-metrics-sidebar` | 单文件 499 行 | — | |
| 15 | `pi-tsien-ptc` | 目录 842 行 | — | 要求补丁版 pi（`executeTool`） |
| 16 | `pi-tsien-running-commands` | 单文件 367 行 | ✅ | |
| 17 | `pi-tsien-schedule` | 单文件 360 行 | ✅ | |
| 18 | `pi-tsien-session-aliases` | 单文件 19 行 | — | 小但功能独立 |
| 19 | `pi-tsien-sidebar` | 单文件 675 行 | — | |
| 20 | `pi-tsien-subagent-workbench` | 桩 + `subagent-workbench/src` | — | 要求补丁版 pi |
| 21 | `pi-tsien-usage-analytics` | 单文件 564 行 | — | |
| 22 | `pi-tsien-prompt-inspector` | 单文件 604 行 | — | |
| 23 | `pi-tsien-observation-pack` | 目录 303 行 | — | |
| 24 | `pi-tsien-trajectory-recorder` | 单文件 798 行 | — | |
| 25 | `pi-tsien-capability` | 目录 214 行 | — | |

说明：
- 全量 24 个 tsien 扩展中 **18 个零外部依赖**，6 个依赖 core；改包只是把相对 import
  （`./lib/live-observer.ts`、`./auto-compact-target/core.ts`）换成包名 import。
- **「包被安装」≠「扩展被启用」**：pi 只看 `settings.packages`，npm 传递依赖不会自动启用扩展。
  这是想要的语义（core 作为库被依赖，而 core 本身不是扩展）。
- peer 依赖必须是 `@earendil-works/*`；现有扩展已按包名 import 它们，说明裸包名解析没问题。

### 12.4 成本与风险

- 内部依赖跨包：npm 安装时依赖必须能在 registry 解析 ⇒ 已定「公开发布」，故 core 必须同时发布。
- 顺序：包内顺序由 manifest 决定；**包间顺序**仍需约定（`packages[]` 相对序 + 全局 `loadOrder`）。
- 机械改动量大（移动目录 + 改 import 路径 + workspace 配置 + CI 从 1 套变 N 套），测试是主要保障。
- **测试路径改动是真成本**：现有测试引用 `extensions/...` 路径，随目录迁移需要改（估算见 §12.7）。
- 收益：①可按需装 ②依赖图变成**真实的包级边** ③改一个功能不动整包 ④版本独立。

### 12.5 与其它部分的关系

- 同步器：只需支持多个本地/私有来源（已支持），`loadOrder` 变为「按包分组、保持全局序」；§3 的前缀保留仍需先做。
- 页面（§4/§6）：列表按包分组展示，依赖图直接画包级边 + 包内扩展；`pi install` 粒度=包，与页面一致。

### 12.6 npm workspaces 机制（已实测）

- **一个 repo 管多个包**：根 `package.json` 加 `"workspaces": ["packages/*"]`；每个子包有自己的
  `package.json`（含 `name`/`version`/`files`/`pi` manifest）。共用一份 `node_modules` 与 lockfile，
  可 `npm test --workspaces` 一次跑全部。
- **实测（npm 11.17.0）**：内部依赖写 `"@tsiendragon/pi-tsien-core": "workspace:*"` 时，
  `npm pack`/publish 出来的 tarball **原样保留 `workspace:*`**（npm 不会像 pnpm/yarn 那样改写）
  ⇒ 发布后依赖无法解析。**结论：内部依赖写普通 semver**（如 `"^0.1.0"`），workspaces 会在本地链接到位。
- 发布：`npm publish --workspaces`（或按包 `npm publish -w @tsiendragon/pi-tsien-x`）。
  `publishConfig.access` 只在带 scope 时才需要；定稿用不带 scope 的 `pi-tsien-*`（§12.8），可忽略。
- 每个包 `files: ["index.ts", "<自有目录>"]`，避免把测试/数据发上公网。
- CI/发布凭证：GitHub Actions + `NPM_TOKEN` secret（属你的凭证动作，我不代跑）。

### 12.7 风险与估时

- 包名在 npm 上是**永久占用**的（72 小时内可 unpublish，之后名字烧掉）→ 首次发布先 `--dry-run` 并把名字定死。
- 版本策略：各包独立版本（简单），或统一版本号（好记）→ 待定。
- 估时：目录迁移 + 25 个 `package.json` + import 改写 + 测试路径修正 + workspace 配置 ≈ **1.5~2 天**；
  发布流程（脚本 + README + 首次 dry-run）≈ 0.5 天。

### 12.8 最终包名（定稿：`pi-tsien-<name>`）

**规则**

- 统一格式 **`pi-tsien-<name>`**；直接发到公开 npm（**不需要 scope**）。
- **Fork 规则（已定）**：包内含第三方代码 → `pi-tsien-<name>-fork`；自研 → `pi-tsien-<name>`。
- 已核实：25 个 `pi-tsien-*` 名字在 registry 上**全部可用**（逐个查，0 占用）；
  而**不加前缀的短名已被别人占用**（`pi-memory`、`pi-sidebar`、`pi-web-tools` 均为他人 pi 扩展，keywords 含 `pi-package`）
  ⇒ 前缀不是装饰，是避让。
- npm 命名限制：全小写、只允许 `a-z0-9-._`、不能以 `.`/`_` 开头、≤ 214 字符。
- 发布只靠 npm 账号（不再需要 scope 名与账号名一致），因此之前的「scope 待确认」自动取消。

**定稿清单（25 包）**

| # | 包名 | 对应扩展 / 内容 |
|---|---|---|
| 1 | `pi-tsien-shared` | 共享库（lib/ + 压缩工具），不是扩展 |
| 2 | `pi-tsien-session-ui-fork` | `00-zero`/`pi-zero`（`/ccstyle` `/context` `/powerline` `/transcript` `/vibe`）—— 含第三方代码，见下 |
| 3 | `pi-tsien-side-chat` | `btw`（命令仍叫 `/btw`） |
| 4 | `pi-tsien-thinking-level` | `effort` |
| 5 | `pi-tsien-code-mode` | `ptc`（工具 `run_code`） |
| 6 | `pi-tsien-rtk-fork` | `tool-result-pipeline`（`rtk-*` 命令，含 bash-digest）—— 含合并的第三方 RTK，见下 |
| 7 | `pi-tsien-auto-compact` | `auto-compact-target`（功能层） |
| 8 | `pi-tsien-context-powerline` | `context-powerline` |
| 9 | `pi-tsien-compact-continue` | `compact-continue` |
| 10 | `pi-tsien-default-system-prompt` | `default-system-prompt` |
| 11 | `pi-tsien-git-graph` | `git-graph` |
| 12 | `pi-tsien-goal` | `goal` |
| 13 | `pi-tsien-live-session` | `live-session`（要求补丁版 pi） |
| 14 | `pi-tsien-memory` | `memory` |
| 15 | `pi-tsien-metrics-sidebar` | `metrics-sidebar` |
| 16 | `pi-tsien-running-commands` | `running-commands` |
| 17 | `pi-tsien-schedule` | `schedule` |
| 18 | `pi-tsien-session-aliases` | `session-aliases` |
| 19 | `pi-tsien-sidebar` | `sidebar` |
| 20 | `pi-tsien-subagent-workbench` | `subagent-workbench` |
| 21 | `pi-tsien-usage-analytics` | `usage-analytics` |
| 22 | `pi-tsien-prompt-inspector` | `prompt-inspector` |
| 23 | `pi-tsien-observation-pack` | `observation-pack` |
| 24 | `pi-tsien-trajectory-recorder` | `trajectory-recorder` |
| 25 | `pi-tsien-capability` | `capability` |
| 26 | `pi-tsien-web-tools` | **自研重写**（`vendor/pi-web-tools` 已停用、保留回滚） |

### 12.8.1 第三方代码审计（全仓扫过：PROVENANCE/VENDORED/ATTRIBUTION + 外部链接 + 比对 npm 同名包）

仓库里只有 **3 处第三方代码**，全部有出处文档：

| 包 | 第三方部分 | 上游 | 许可 | 能发 npm 吗 |
|---|---|---|---|---|
| ~~`pi-tsien-web-tools-fork`~~ | ~~`vendor/pi-web-tools`~~ | Brett Atoms | **无 license** | **已由自研重写替代（2026-09-25）**：不再分发第三方代码，无需许可 |
| `pi-tsien-rtk-fork` | `extensions/tool-result-pipeline/rtk/`（从 `pi-rtk` 0.1.4 合并） | Matt Cowger `pi-rtk` / RTK 规范（`PROVENANCE.md`） | **MIT** | ✅ 随包带 license + 出处 |
| `pi-tsien-session-ui-fork` | `extensions/pi-zero/ccstyle/tool-diff/` | `MasuRii/pi-tool-display`（`ATTRIBUTION.md`） | **MIT** | ✅ 随包带 `ATTRIBUTION.md` + license 全文 |

其余 **22 个包未发现第三方痕迹**（自研）：侧边栏/记忆/目标/定时/`git-graph`/指标/提示词检查器/观测归档/
能力注册/实时会话/后台命令/别名/子代理工作台/用量分析/轨迹记录/紧凑继续/默认系统提示/上下文状态栏/
侧聊/思考等级/代码模式/自动压缩。其中 4 个（`sidebar`、`git-graph`、`context-powerline`、`compact-continue`）
无法从 git 历史判定初始来源，但已确认：无外部链接、无出处文件、代码与 npm 上同名第三方扩展不同
（如我方 `sidebar.ts` 674 行 vs npm `pi-sidebar` 43 行，共享特征字符串 0 个）⇒ 按自研处理。

### 12.8.2 发布前的许可前置（重要）

- **本仓库目前没有 LICENSE 文件**（GitHub API：`license: None`），`package.json` 也无 `license` 字段。
  无许可证的 npm 包别人不敢用（法律上不可再分发）⇒ **首次发布前必须先加**（建议 MIT）+ 每个包写 `license`。
- Fork 包必须随 tarball 带上游许可与出处（`files` 字段里包含 `ATTRIBUTION.md`/`PROVENANCE.md`）。
- `pi-tsien-web-tools-fork`：**已取消**（改为自研重写，见 §12.10）；仍建议把两处修补提给上游（bug + 性能）。

**web-tools：已自研重写（见 §12.10）**

- 包名 `pi-tsien-web-tools`（不再是 fork）；`vendor/pi-web-tools` 停用并保留作回滚。
- 我们确定落地的**两处自家修改**（与上游 `master` 逐文件 diff 得出）：
  1. `src/providers/duckduckgo.ts`（±76 行）：DDG lite 解析器修复 —— 属性顺序无关、单/双引号都收、
     并解开 `//duckduckgo.com/l/?uddg=…` 重定向；上游正则仍要求 `class` 在前 + 双引号（未修）。
  2. `src/web-fetch.ts`（±21 行）：重量级依赖（jsdom/readability/turndown）改懒加载，
     启动耗时 1.7s → 0.6~0.8s。
  - 守护测试：`test/pi-web-tools-vendor.test.ts`（两版本 markup 都验）。
- **发布不再受第三方许可限制**（代码是我们的）；仍只差仓库/包自己的 license（§12.8.2）。
- 建议：把这两处修补提 PR/issue 给上游（一个是真 bug，一个是性能）。

### 12.9 已确认的决策

| 项 | 决定 |
|---|---|
| 拆分粒度 | **一功能一包**，含 19 行的 `session-aliases`（25 个包 = 1 共享库 + 24 功能；其中 3 个是 `-fork`） |
| 版本策略 | **各包独立版本**（依赖写 `^x.y.z`） |
| 发布渠道 | **公开 npm（npmjs.org）**，不带 scope 的 `pi-tsien-*` 名 |
| web-tools | 包名 `pi-tsien-web-tools-fork`（fork 规则），自维护；**发 npm 需先拿上游许可**（上游无 license） |
| 命名 | §12.8：自研 `pi-tsien-<name>`、含第三方代码的加 `-fork`；不带 scope，名字均已验证可用 |
| npm 账号 | 不再需要 scope/账号名一致性；发布时用你的 npm 账号即可 |
| 真源冲突 | 待定：甲（同步器保留 `+/-/!` 前缀，推荐）或 乙（回写 config） |
| 许可 | **待补**：仓库与各包目前无 LICENSE（发布前必须加，建议 MIT） |
## 13. 已落地记录（2026-09-25）

| 项 | 提交 | 证据 |
|---|---|---|
| 同步器保留 `+/-/!` 覆盖条目（方案甲） | `pi-tsien-extension@80408c7` | 新增回归测试；`node --test test/pi-extension-sync.test.mjs` 5 pass；本机真实配置 dry-run 正常 |
| WebSearch/WebFetch 自研重写 `packages/pi-tsien-web-tools` | `pi-tsien-extension@60079fe` | 包内 26 单测；A/B：3 查询 × 10 条结果 URL/标题/摘要归一化后逐条一致；`example.com` 提取一致；`nodejs.org/en/about` 去空白后逐字符相同；真实 `pi -p` 内 WebSearch 返回 `Pi Coding Agent / https://pi.dev/` |
| devDependencies 可移植性修复 | `pi-tsien-extension@e993ccf` | 原指向已删除的 `~/pi-lical-dist/*.tgz`（任何新 clone 都无法 `npm install`）；改为补丁版 Release URL + 放宽 peer 范围；`npm install` exit=0、`tsc --noEmit` 干净、`test:node` 245 pass |
| 配置与文档切换到新包 | `pi-tsien-extension@e2e20d9` | `config/extensions.standalone.json`、`config/examples/*`、README/CHANGELOG、`VENDORED.md` 状态标注 |
| 本机 live 切换（外科手术式，未触发无关 quarantine） | 本机配置 | 备份 `settings.json.pre-webtools-switch-20260925-232326` 与同名 config；切换后 dry-run 只剩既有的 `security-guard` 项 |
| 扩展包目录迁移（P0 拆包，一功能一包） | `pi-tsien-extension@ed471a8` | 22 个包：`packages/pi-tsien-*`（npm workspaces，内部依赖普通 semver）；新增共享库 `pi-tsien-shared`；19 个扩展 + 共享库已迁，3 个（auto-compact/context-powerline/live-session）因并行会话未提交改动延后。验证：`parity:check` 25/25 一致、`tsc --noEmit` 干净、`test:node` 246 pass、隔离 agent 目录真实 `pi -p` 会话内 25 个扩展全部加载且 `WebSearch`/`capability_ls` 正常 |
| **P3 安装管理**：install / remove / update + 审计 + 一键回滚 | 本仓库（`backend/ext-packages.ts`、`backend/ext-audit.ts`、`backend/routes/pi-ext-packages.ts`） | 无 shell（`execFile`）、装前备份、审计 JSONL（含 actor 与 backupPath）、回滚仅允许 `backups/settings-*.json`；隔离实例实测 8 项（401 / 装 / 假包 400 / 卸 / 两次回滚语义 / 越界 400 / 拒绝 update self） |
| **数据模型修正**：`packages[]` 是 string\|object 联合 | `backend/ext-inventory.ts`、`shared/src/ext-inventory.ts` | 上游 `PackageSource` 语义落地：string = 加载全部资源（`pi install` 写的就是这种）；新增「③ 由 package 自带（autoload）」组；7 个单测 |
| **P2 可写页**：toggle / order + 串行写模块 + 写前备份与 diff 确认 | 本仓库（`backend/ext-writes.ts`、`backend/settings-store.ts`、`backend/routes/pi-ext-write.ts`） | 11 个单测（含串行化与备份）；隔离实例实测：禁用位置不变、启用往返一致、排序保留覆盖条目索引、非法排序 400、未知路径 404、整份 PUT 与 toggle 并发互不覆盖 |
| **P1 只读页**：`GET /api/pi/ext/list` + Extensions 页面 | 本仓库（`backend/ext-inventory.ts`、`backend/routes/pi-ext-list.ts`、`frontend/src/pages/ExtensionsPage.tsx`） | 列表来自 `settings.json` + `extensions.config.json` + 各包 manifest，分三组（package 提供 / 直接路径 / 自动发现未纳管），标注 declared / undeclared / duplicate / missing 与「需要补丁版 pi（推断）」；隔离实例复核：29/29 条目与 `settings.json` **逐项一致**，`auto` 抓到探针文件，drift 为空；单测 5 个（含「来源不可解析时不误报 drift」） |
| 等价性验收工具（parity harness） | `pi-tsien-extension@a9c16e6` | 迁移前抓指纹（工具/命令/事件/调用签名）；实测能抓「少工具/少命令/少事件/调用数变化」；本轮又抓出 3 个真问题（依赖漏边、改写顺序、memory 入口选错） |

**回滚**：把 `~/.pi/agent/{settings.json,extensions.config.json}` 恢复为上述备份，或把 `extensions.config.json` 的 web-tools 来源改回
`${PI_TSIEN_EXTENSION_ROOT}/vendor/pi-web-tools` 后重新同步（`vendor/` 未删除）。

**仍未做**：P0 monorepo 拆分（24 个扩展还留在 `extensions/`，尚未迁到 `packages/*`）、仓库与各包 LICENSE、npm 首次发布、
dashboard 的 Extensions 管理页面（§4/§5）。
