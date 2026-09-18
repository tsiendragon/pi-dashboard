# Tasks 页面设计 v2（第一性原理重构 · 通用任务面板）

> 状态：**P1/P2/P3 主体已实现并提交，WIP 暂停（2026-09-18）**——收尾交接见 [§17](#17-收尾交接wip-暂停)。
> 已实现：后端聚合 + 两视图 + 规划层 + session 关联 + 本地临时任务增删改 + 深链 + 拖拽 + 趋势 + provider 插件化。
> 取代 v1（v1 的 bucket 字段、单一 status、三栏主视图已被本版修正）
> 关联：`backend/pi-env.ts`（`~/.pi/dashboard.json`）、`shared/src/live-sessions.ts`（session cwd/tags）

## 1. 本质与范围

用户的三类需求，性质不同、必须分层：

| 需求 | 性质 | 本质动作 |
|---|---|---|
| 显示「有哪些任务」 | 认知 | 把分散事实聚合成可读状态 |
| 规划「长/短/临时」 | 决策 | 分配注意力 |
| 联系 session | 执行 | 把「要做什么」和「正在做」连起来 |

- **目标**：一个页面同时支持「每日执行」和「全局鸟瞰」两种视角；数据源可插拔；零配置可用；lilong-task 为可选源；任务可关联 session。
- **非目标（P1）**：不改写 journal 事实层；不做 Jira/GitHub provider；不做写回 journal / markdown 勾选；不做时间线/燃尽。

## 2. 第一性结构：三个正交层（按「变化频率」分层）

分层的依据不是"数据来源"，而是**变化频率**——这是缓存、并发、职责划分的第一性依据。

| 层 | 内容 | 变化频率 | 读写 | 归属 |
|---|---|---|---|---|
| **事实层** | kind / parent / completion / archived / path | 慢 | 只读 | 外部源 |
| **规划层** | priority / focus / pinned / note | 中 | 可写 | **用户 × 任务**（非任务属性） |
| **执行层** | sessionRefs（按 cwd 归属） | 快 | 旁挂 | runtime |

**关键更正**：
1. 「长期/短期/临时」是**视角，不是数据**。数据只记客观层级 `kind`；泳道是**视图层映射**，可配置。
2. 完成度与可见性是**正交两维**：`completion`（走到哪）+ `archived`（是否在视野内）。`epic.active` 不是"进行中"。
3. 规划信息独立，是因为它是「用户 × 任务」关联，不是妥协。

## 3. 核心模型（`shared/src/tasks.ts`）

```ts
export type TaskKind = 'epic' | 'task' | 'todo' | 'item'
export type Completion = 'todo' | 'doing' | 'done' | 'paused'

export interface TaskFact {          // 只读，来自 Provider
  uid: string            // `${providerId}:${id}`，必须稳定
  providerId: string
  id: string
  kind: TaskKind
  parentUid?: string     // 同 provider 内唯一有效
  title: string
  description?: string
  completion: Completion
  completionRaw?: string // 原始值（如 Feasibility），容错
  archived: boolean
  plannable: boolean     // 身份是否稳定到可被规划（见 §5）
  path?: string          // 执行目录 → session 唯一鲁棒纽带
  progress?: { done: number; total: number }  // 仅源提供时
  tags: string[]
  updatedAt?: string
  writable: boolean
  raw?: unknown
}

export interface PlanningEntry {     // 可写，key = uid
  priority?: 0 | 1 | 2
  focusOrder?: number
  pinned?: boolean
  note?: string
  sessionIds?: string[]              // 手动关联
  laneOverride?: string              // 手动指定泳道（视图层覆盖）
}
export type PlanningOverlay = Record<string, PlanningEntry>
```

**注意：模型里没有 `bucket` / `status`。** 泳道不进数据；完成度与可见性分离。

## 4. Provider（P1 只读优先）

```ts
export interface ProviderCapabilities {
  writable: boolean        // 能否 create/update（P1 仅 local 可 true）
  providesTodos: boolean
  providesProgress: boolean
}
export interface TaskProvider {
  id: string               // 创建后不可变（uid 前缀，见 §8）
  label: string
  available(): Promise<boolean>
  capabilities: ProviderCapabilities
  list(): Promise<TaskFact[]>
  get?(id: string): Promise<TaskFact | null>
}
```

- P1 只实现 `list()`（+ 可选 `get()`）。写能力后置（P2），不污染只读抽象。
- 单源失败 → 返回空 + `warnings[]`，不影响其他源。

### 4.1 `task-journal` provider（只读，通用适配器，不写死 lilong-task）

目录规范：`tasks/DOMAINS.yaml`、`tasks/<domain>/epic.yaml`、`tasks/<domain>/<epic>/task.yaml`、`tasks/active-status.yaml`、`todos/*.md`。

**映射（含实测值）**

| 来源 | kind | completion | archived | plannable |
|---|---|---|---|---|
| `epic.yaml` | `epic` | `active→doing` / `archived→done`* | `status==='archived'` | ✅ |
| `task.yaml` | `task` | `to_do→todo` / `in_progress→doing` / `done→done` / `paused→paused` | 否 | ✅ |
| `todos/*.md` | `todo` | `[ ]→todo` / `[x]→done` / 含 blocker→`paused` | 否 | ❌（身份不稳） |

\* epic 的 completion 仅用于视图着色；其 `archived` 才是主语义。

**硬规则**
- **权威性**：以 `DOMAINS → epic.yaml → task.yaml` 树为唯一权威；`active-status.yaml`（实测 55 条，与 task.yaml 重复）**仅用于状态校验/补全 path，不生成独立条目**。
- **状态容错**：`to_do/in_progress/done/paused/active/archived` 走映射；任何未识别值（实测有 `Feasibility`）→ `completion='todo'`，原文写入 `completionRaw`，UI 展示原文。
- `progress`：`task.yaml` 的 `stages` 是**名字列表、无状态**；仅当任务目录内可解析出 stage 状态时才设 `progress`，否则不设（不伪造）。
- todos 解析按 `todos/README.md` 约定；解析失败的行**降级为纯文本条目，永不丢数据**。

### 4.2 `local` provider（兜底 + 个人临时收件箱）

- 文件 `~/.pi/tasks/tasks.json`（0600，temp+rename 串行写）。
- 手动创建的任务 `kind='item'`、身份为 uuid → **稳定、plannable、writable**，是「临时任务」的完整管理入口。
- P1 只读展示（CRUD 后置到 P2）；P1 至少保证"探测不到任何源时不崩、页面可解释"。

## 5. 「可规划集合」准入（架构约束，非容错）

> **只有身份稳定的条目才配进入可规划集合。**

- `plannable=true`：uid 由稳定锚点产生（journal 的 epic/task key、local 的 uuid）→ 可 pin/优先级/备注/关联 session。
- `plannable=false`：uid 会随内容变化（todos markdown）→ **只读旁挂**，出现在视图但不可规划。
- 因此 `planning.json` 只会出现稳定 uid；todo 不制造孤儿记录。

## 6. 视图层（「都要」：执行 + 鸟瞰）

两种视图是**同一数据的两种聚合**，切换零成本（数据一次加载）。

```ts
interface LaneDef { id: string; label: string; match: { kind?: TaskKind[]; tag?: string; pathPrefix?: string } }
```

### 6.1 执行视图（每日执行，默认打开）
- 结构：`聚焦 → 进行中 → 待办 → 暂停/阻塞(折叠) → 已完成(折叠)`
- 排序：`pinned/focusOrder` > `priority` > `completion==='doing'` > `updatedAt`
- 每行：标题 · kind 徽章 · 所属 epic · 领域 · session 徽章 · 状态点
- 定位：回答「**现在做什么**」

### 6.2 鸟瞰视图（全局规划）
- 结构：按 `lanes` 配置分栏（默认：长期←epic / 短期←task / 临时←todo,item）
- 泳道来自**视图映射**，不来自数据；支持 `laneOverride` 手动调整
- 定位：回答「**整体在哪、怎么排**」

### 6.3 切换
- 工具栏 toggle + 键盘 `1`/`2`；默认执行视图；上次选择持久化（localStorage）。

## 7. Session 关联（cwd 为主，物理事实）

规则，按优先级：
1. **cwd 前缀**：session 的 `cwd` 落在 `task.path` 下 → 自动关联；**最长前缀匹配，只挂最具体的一层**（避免 epic+task 重复挂载）。
2. session tag 含 `task.id`（小写）→ 自动。
3. `planning[uid].sessionIds` → 手动。

- 依赖解耦：定义 `SessionSource { listLive(): SessionRef[]; byCwdIndex(): Map<string, SessionRef[]> }`，TaskService 只依赖该接口。
- 性能：历史 session index 只加载一次建 `cwd→sessions` 索引；关联结果独立缓存。
- 仅对 `plannable` 任务做手动关联；自动关联对所有有 `path` 的任务生效。

## 8. 身份稳定性（uid 规则）

| 源 | uid | 稳定性 |
|---|---|---|
| journal epic/task | `task-journal:<KEY>` | 稳定（key 不变） |
| local item | `local:<uuid>` | 稳定 |
| journal todo | `task-journal:todo:<file>:<n>` | **不稳** → plannable=false |

- **provider id 创建后不可变**（UI 置灰）；改名走"迁移"（同步重写 planning key）。
- 规划层保留孤儿记录，不报错，提供「清理失效规划记录」入口。

## 9. 配置（自动探测 + 覆盖）

> 零配置的本质是**自动发现**，不是"默认某个源"。

`~/.pi/dashboard.json` 的 `tasks` 段（复用 `getDashConfig()/saveDashConfig()`）：

```json
{ "tasks": {
  "enabled": true,
  "journal": { "autoDetect": true, "roots": ["~/repos/lilong-task"], "enabled": true },
  "lanes": [
    { "id": "long",  "label": "长期", "match": { "kind": ["epic"] } },
    { "id": "short", "label": "短期", "match": { "kind": ["task"] } },
    { "id": "adhoc", "label": "临时", "match": { "kind": ["todo","item"] } }
  ],
  "defaultView": "execute"
}}
```

- 探测标志：候选 root 下存在 `tasks/DOMAINS.yaml`。
- 候选 root：`tasks.journal.roots` ∪ 环境变量 `LILONG_TASK_ROOT`（向后兼容）∪ `~/repos/lilong-task`。
- 探测到 → 启用 task-journal provider；否则仅 `local`。配置仅作覆盖。
- `~` 展开；root 不存在则该源 `unavailable` + warning。
- `lanes` 缺省用上面三项；可增删改，纯视图层。

## 10. 后端 API

```
GET  /api/tasks                 → { tasks: TaskFact[], warnings, providers, planning, sessionRefs }
GET  /api/tasks/providers       → { providers: [{id,label,capabilities,available}] }
GET  /api/tasks/:uid            → { task }
GET  /api/tasks/planning        → { planning }
PUT  /api/tasks/planning        → { planning }
POST /api/tasks       (P2, 仅 local)      → { task }
PATCH /api/tasks/:uid (P2, 仅 writable)   → { task }
```

- `PUT /api/tasks/planning` 只接受 `plannable` 的 uid；否则 409。
- 并发：`planning.json` 带 `version`，PUT 校验版本，不匹配返回 409 冲突（前端重取合并）。

## 11. 前端

**导航**：`App.tsx` 的 `NAV_ITEMS` 加 `{ path:'/tasks', label:'Tasks', group:'Main' }` + Route。移动端底部 tab 已 8 项，加 Tasks 前需评估溢出（低频项收进「更多」）。

**组件树**
```
TasksPage
├─ TasksHeader        (统计 + 刷新时间 + 视图切换)
├─ FocusRail          (聚焦条)
├─ TasksToolbar       (状态/领域/来源/搜索/排序)
├─ ExecuteView | SurveyView
│    └─ TaskRow / TaskCard (StatusDot / KindBadge / ProviderBadge / SessionBadges)
└─ TaskDrawer         (事实层只读 + 规划层可写)
```

**状态**：沿用 `JobsPage` 的 `useState + api.*` fetch 模式；规划层乐观更新。数据一次加载，视图切换纯前端。

**交互**：点行/卡片→抽屉；`📌`→聚焦；拖拽→写 planning（focusOrder/laneOverride）；只读项禁用编辑并提示；`plannable=false` 不显示规划控件。

## 12. 非功能

- **缓存**：provider 按 mtime + 5s TTL；**写后主动 invalidate**；sessionRefs 独立缓存。
- **规模**：journal 现有上百 task；每栏默认折叠（前 N + 展开），或复用已有 `react-virtuoso`。
- **鉴权**：沿用现有 `/api` origin guard（`backend/server.ts:223`，无身份鉴权、GET 开放）；**不落敏感字段**（P1 的任务信息本身即用户自己的规划内容）。
- **错误**：`warnings[]` 顶部提示逐条列出失败来源。
- **空态**：探测到 journal → 正常；无任何源 → 提示「未发现任务源，可配置 journal 或使用本地任务（P2）」。

## 13. 文件落点

| 类型 | 文件 |
|---|---|
| shared | `shared/src/tasks.ts` |
| backend 新增 | `backend/tasks/{types,service,planning-store,detect}.ts`、`backend/tasks/providers/{local,task-journal}.ts`、`backend/tasks/session-linker.ts`、`backend/routes/tasks.ts`、`backend/__tests__/tasks.*` |
| backend 修改 | `backend/pi-env.ts`（DashConfig.tasks + 默认/规范化）、`backend/server.ts`（挂载） |
| frontend 新增 | `frontend/src/pages/TasksPage.tsx`、`frontend/src/pages/tasks/*` |
| frontend 修改 | `frontend/src/App.tsx`、`frontend/src/api/client.ts`、`frontend/src/pages/SettingsPage.tsx` |
| docs | `docs/api-reference.md` |
| 运行时 | `~/.pi/tasks/{tasks,planning,history}.json` |

## 14. 分期与验收

**P1**：事实层聚合（task-journal + local 只读）· 自动探测 · 规划层 · 两种视图 · sessionRefs · Settings。
**P2**：local CRUD、写回/勾选（经 task-pilot）、深链、键盘无障碍、每栏虚拟化。
**P3**：时间线/燃尽/周报、插件化 provider。

**P1 验收**
1. 不写配置时，能自动探测到 `~/repos/lilong-task` 并显示真实任务；探测不到也不崩。
2. `epic.active` 显示为"活跃"而非"进行中"；`paused`/`Feasibility` 等原值不丢失、不错映射。
3. `active-status.yaml` 不产生重复条目。
4. todo 只读、不可规划；planning 中无 todo uid。
5. 执行/鸟瞰两视图数据一致，切换零请求。
6. session 按 cwd 最长前缀正确归属，无重复挂载。
7. 规划层重启保留；改 provider id 有约束提示。

### 已实现（增量）

- **起会话**：抽屉 `▶ 起会话` → `POST /api/live-sessions/start`（cwd=任务目录），成功跳转 `/live-sessions/:processInstanceId`；未认证时禁用并提示。
- **手动关联会话**：抽屉 `+ 关联会话` 从活跃会话中挑选 → 写入 `planning.sessionIds`；可 `✕` 取消。
- **来源徽章**：provider > 1 时卡片显示 `sourceLabel`，并支持按来源筛选。
- **分组折叠**：执行/鸟瞰每栏默认 20/25 条，超出 `展开全部（+N）`。
- **默认视图**：首次进入用配置 `defaultView`，此后记住用户选择（localStorage）。
- **Settings → Tasks**：开关任务面板/日志源/自动探测、编辑 journal roots、默认视图；写 `~/.pi/dashboard.json`。关闭面板时隐藏导航与路由。
- **深链**：`/tasks/:uid` 直接打开对应任务抽屉；卡片点击同步 URL，`✕`/Esc 返回 `/tasks`。
- **标签编辑**：local（可写）任务在抽屉内用逗号分隔编辑 `tags`（影响泳道匹配与筛选）。
- **拖拽跨栏**：鸟瞰视图可把卡片拖到其它泳道，写入 `planning.laneOverride`。
- **键盘**：抽屉支持 `Esc` 关闭。
- **趋势快照**：后端每日把 `{total,todo,doing,done,paused,archived}` 记入 `~/.pi/tasks/history.json`（同日变更才重写，保留 120 天）；鸟瞰视图顶部用内联 SVG 画「活跃/进行中」趋势；`GET /api/tasks/history?days=N`。
- **外部来源（provider 配置化）**：`tasks.providers` 声明只读来源，新增 Jira/Lark 无需改代码：
  - `{ kind: 'command', id, label, command: [bin, ...args], cwd?, timeoutMs? }`：执行命令读 stdout JSON
  - `{ kind: 'file', id, label, file }`：读本地 JSON 文件
  - 两者都接受 `[...]` 或 `{ "tasks": [...] }`，条目：`{ id, title, kind?, status?, archived?, path?, tags?, description?, updatedAt?, progress? }`；无 `id` 的条目丢弃；无法识别的 `status` 保留到 `completionRaw`
  - Settings → Tasks 里直接编辑该 JSON（带解析校验）；命令在请求时才动态加载并执行（不进模块加载路径）
- **移动端拖拽**：卡片新增 ⠿ 拖柄，用 pointer 事件（鼠标 + 触屏都能用，原生 HTML5 DnD 不响应触摸）拖到其它泳道 → `planning.laneOverride`；空泳道也可作为落点。

## 15. 风险

| 风险 | 处理 |
|---|---|
| journal 状态值自由化（`Feasibility` 等） | 宽松映射 + `completionRaw` 兜底 |
| todos 身份不稳定 | 排除出可规划集合 |
| YAML schema 演进 | 宽松解析，多余字段进 `raw` |
| stage 进度不可得 | 不显示，不伪造 |
| 探测到错误目录 | 以 `tasks/DOMAINS.yaml` 为标志，失败仅 warning |
| provider id 改名 | 约束不可变 + 迁移路径 |

## 16. 人工验收（需重启后端后执行）

代码修改后需由用户执行 `./run.sh`（后端改动必须重启才生效；前端 `dist` 已重建）。

1. **列表**：打开 `/tasks`，确认能看到 journal 正式任务与本地临时任务；来源筛选在来源 >1 时出现。
2. **规划**：给一条任务设优先级/聚焦；切到「鸟瞰」确认聚焦栏与泳道分组；拖拽（桌面整卡 / 触屏用 ⠿ 拖柄）换栏后刷新仍保留。
3. **写入**：`+ 新建` 记一条临时任务 → 改标题/状态/标签 → 删掉；对 journal 任务修改应得只读拒绝（提示走 task-pilot）。
4. **会话**：抽屉「▶ 起会话」（需先在 Live Pi 认证）以任务目录为 cwd 启动；「+ 关联会话」手动挂载后可用 ✕ 取消。
5. **深链**：直接访问 `/tasks/task-journal:<id>` 应直接打开抽屉；`Esc` 或 ✕ 关闭回 `/tasks`。
6. **Settings**：Settings → Tasks 改开关/roots/默认视图/外部来源 JSON；关掉「启用任务面板」后导航项消失。
7. **趋势**：进「鸟瞰」看趋势条（首日仅 1 点，会提示需 2 天）。
8. **外部来源**：写一个 `~/jira.json`=`[{"id":"ABC-1","title":"x","status":"in_progress"}]`，在外部来源 JSON 里加 `file` 类型，刷新应出现 `jira:ABC-1`。

运行时产物：`~/.pi/tasks/tasks.json`（本地任务）、`planning.json`（规划层）、`history.json`（趋势）。

## 17. 收尾交接（WIP 暂停）

**状态**：P1/P2/P3 主体已实现、已提交、已跑通验证；**代码工作到此为止**，剩下的是真机/真人验收与几条遗留测试。

### 17.1 提交记录

| 提交 | 说明 |
|---|---|
| `38d04fb` | `feat(design): 语义字号与前景色 token`（**前置依赖**：本页用到 `text-2xs`/`text-meta`/`text-body-s`/`--accent-fg`，HEAD 之外无此 token） |
| `ebec1bf` | `feat(tasks): 通用任务规划面板`（26 文件，+3082/−10） |

### 17.2 已验证（可复现）

- 后端 `tsc` 0 错、前端 `tsc` 0 错、`vite build` 成功。
- 后端 vitest：**25 文件 / 338 passed, 1 skipped**。
- 真实数据 smoke：**304 条**（62 epic / 239 task / 3 todo），`providers: task-journal:true, local:true(writable)`，无 warning。
- HTTP smoke 全覆盖：`GET/PUT/POST/PATCH/DELETE`，含 `409 read_only_source`、`400 title_required`、`404`。
- 外部来源（`kind:'command'`）node 冒烟：`wip→doing` 正确映射、`archived` 保留、`writable:false`。

### 17.3 未验证（需人工 / 真机）

1. **真人浏览器交互**：拖拽手感、触屏手势、抽屉键盘焦点（本机无真人操作证据）。
2. **真机 live session cwd 关联**：起会话后任务是否自动挂载（当前仅代码层验证）。
3. **本文 §16 的 8 步人工验收**：需重启后端后由人执行。

### 17.4 遗留 / 后续 TODO

| 项 | 说明 |
|---|---|
| 前端 6 条过期断言 | `App.test.tsx`×2（`PI DASH`/`Health` 文案已转中文）、`LiveSessionFeatures.test.tsx`（`BTW · 1`）、`ToolCallBlock.test.tsx`（Arguments 隐藏逻辑）、`ToolSummary.test.tsx`（label 期望 `Read`，现返 `read /path`）、`liveToolEntries.test.ts`（分组数 1→2）。**后两条疑似行为变化**，需先确认是有意改动还是回归，再改断言。 |
| 未 push | `master` 领先 `origin/master` **18** 个提交。 |
| journal 写回 | 面板不写 journal 事实层（设计即如此，非缺陷）；改状态请走 task-pilot。 |
| 真机 trend | `history.json` 首日仅 1 点，需 ≥2 天才有趋势线（UI 已提示）。 |

### 17.5 生效方式

后端改动需**用户自己执行 `./run.sh`** 重启进程才生效；前端 `dist` 已重建。按 `AGENTS.md`，agent 不代为重启正在运行的服务。
