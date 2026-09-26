# LiveSession 会话树 + 树图页面 — 完整设计方案（v5）

**状态**：**L0.1 已落地**（Phase 2.1–2.6 实现完成；待用户 `/reload` + `./run.sh` 做端到端验证）
**关联**：`docs/research/agent-tree-branching-feasibility.md`、`docs/research/live-session-tree-and-graph-page.md`
**Mock**：`docs/mockups/session-tree-graph.html`

---

## 0. 修订记录

### v4 → v5（L0.1 落地）

新增 §15 落地记录（交付物、探针结论、与计划的 5 处偏差、验证证据、未验证项）。关键修正：
- **必须加能力字段**：pi 对未知斜杠命令会回退成普通 prompt（已在 bundle 里确认）
- **路由改为按文件路径键控**（`GET /api/session-tree?file=`）
- **`frontend npm run typecheck` 是空操作**，真实门禁是 `tsc -b`

### v3 → v4（零依赖 + 零协议 + 数据验证）

| 变更 | 内容 |
|---|---|
| **不装任何第三方包** | 取消原 Phase 0 的 `pi-session-tree-browser` 安装验证 |
| **不新增 npm 依赖** | 取消 React Flow / dagre；改用**自写原生 SVG 图谱**（数据是树，布局 ~15 行） |
| **不改协议** | navigate/fork 改用 **bridge 斜杠命令 + 已有 `input` 通道**，不需要 v3 协议与区间兼容（§6.2） |
| **Phase 0 改为数据验证（已完成）** | 扫描真实会话：**97% 无分支**，fork 仅 3/336 → 结论：**只读图谱价值低，必须与“切分支”同批交付** |
| 有界读取成为硬需求 | 单文件最大 **764MB**、entries 最大 7176 → 必须 >20MB 只读尾部 + 节点上限 + 长线性段折叠 |

### v2 → v3（需求收敛）

| 变更 | 内容 |
|---|---|
| 取消泳道布局 | 只保留分层（§7.2） |
| 只做一个 graph 页 | 移除图/列表切换与 `SessionTreeList`（§7.1） |
| **图谱 ↔ 会话 双向跳转** | 图谱页为独立路由；节点点击可打开对应会话；会话页可返回图谱（§8.3） |
| 新增只读会话视图 | 无进程会话也能“打开”（从 JSONL 渲染只读转录） |

### v1 → v2（对抗性 review 返工）

上一版经过对抗性 review，发现 3 处**阻断级**问题与 6 处设计缺陷。本版逐条返工：

| 编号 | v1 的问题 | 证据 | v2 的修法 |
|---|---|---|---|
| **A1** | 只画**单个 session 文件**的树 → fork 出的分支不在图上，用户只会看到直线 | `createBranchedSession` 写新文件并记 `parentSession`（`session-manager.js:1134`、`.d.ts:11`）；`parseSessionTree` 跳过 header 且只读单文件（`session-store.ts:237`） | **L0 引入 session family 拼装**（用 `SessionInfo.parentSessionPath`，`session-manager.d.ts:133`） |
| **A2** | 终端 `/tree` 切分支后 web 不刷新 | bridge **无 `session_tree` 订阅**；`markChanged()` 仅在 lease 变化 / onConnected / onDisconnected（`live-session.ts:228/436/443`） | bridge 加 `pi.on('session_tree')` → `markChanged()` + publish；**L0 即跨两个仓库** |
| **A3** | 用 `LiveSessionPathPolicy` 校验 `sessionFile` 是错的 | `authorize()` 要求路径是**目录**（`path-policy.ts:57` `isDirectory()`），传文件必返 `cwd_unavailable` | 改为校验落在 `<agentDir>/sessions/` 内，realpath 归一化 |
| B1 | `parseSessionTree` 不解析 `label`、不读 `parentSession` | 无 `label` 分支，未知类型归为 `role:'system'`（`session-store.ts:265-269`） | L0 解析层扩 `label` 与 header |
| B2 | 同步全量解析 + 高频刷新会阻塞 Express 主线程 | `readFileSync` 读整文件（`session-store.ts:232`）；所有 slot 共用一个进程 | 异步读 + `path+mtime+size` 缓存 + 仅面板打开时订阅 + 超阈值只读尾部 |
| B3 | "编辑并重发"在**选中时**就移动 HEAD（副作用） | v1 §8.3 表述 | 拆为 **预览 / 提交** 两步 |
| B4 | 无撤销 | pi TUI 有 Esc，web 没有等价物 | 记录 `previousLeafId` + "撤销切换" |
| B5 | 能力协商没有落地位置 | v1 §6.5 只提到 `capabilities` | 由 `entry.hello.protocolVersion` 派生，放进 detail 响应 |
| B6 | 大 session 策略缺失（只截文本不截节点数） | — | 节点上限 + `truncated` + 默认折叠 + 简化渲染 |
| C1–C5 | mock 与计划不一致（孤儿语义混淆、标签 L0 不可得、按钮状态、时间轴命名、触屏） | — | 见 §8 与同批重做的 mock |

**结论修正**：v1 说"L0 只动 pi-dashboard、零改动"——**错误**。L0 必须改 bridge（A2），因此**从第一期就跨两个仓库**。仍然**不需要改 pi 上游**。

---

## 1. 背景与目标

### 1.1 问题

pi 的会话是树（entry 有 `id`/`parentId`，有可变 leaf/HEAD），且**分叉会产生新的 session 文件**（通过 `parentSession` 串成"会话家族"）。但 pi-dashboard：

- 只把单个文件的树渲染成**列表**（`frontend/src/pages/chat/SessionTree.tsx`）；
- LiveSession 侧**完全没有树视图**；
- **跨文件的家族关系完全不可见**——而 fork 恰恰是主要的分叉手段。

### 1.2 目标

1. **LiveSession 支持树形工作**：看到**整棵家族树**（含同文件废弃分支 + 跨文件 fork 分支）、能切分支、能从任意节点分叉。
2. **一个可视化树图页面**：主干/分支/泳道一目了然，可从图上进分支、建分支。
3. **一个可视化图谱页**：主干/分支/fork 边一目了然；**从图上点开即可进入对应会话，从会话可回到图谱**。

### 1.3 非目标

- 文件级 checkpoint / 快照回滚（Claude Code / Cline / Cursor 那种）——artifact 层，另立项。
- 分支 merge / 三方合并——pi 无此语义。
- 跨机器同步、多人协作编辑。

---

## 2. 现状与设计约束（每条带证据）

| 事实 | 证据 | 约束 |
|---|---|---|
| pi session JSONL 是树：`id`/`parentId` + 可变 leaf | `session-format.md`、`session-manager.d.ts` | 不造树模型 |
| 原地切分支 = `navigateTree(targetId, opts)`（**同文件**） | `agent-session.d.ts:634` | 语义 = git checkout |
| 新文件分叉 = `fork(entryId)` / `clone()`，新文件头记 `parentSession` | `rpc-types.d.ts`；`session-manager.js:1134`；`SessionHeader.parentSession`（`.d.ts:11`） | **家族关系必须显式拼装** |
| 家族链接字段已现成 | `SessionInfo.parentSessionPath`（`session-manager.d.ts:133`） | 不需要新协议 |
| LiveSession 已下发 `sessionFile` | `shared/src/live-sessions.ts:44`；bridge `live-session.ts:243` | 拿得到文件 |
| LiveSession 已有会话级血缘（main/subagent） | `live-sessions.ts:39-43`；`registry.ts:60-88` | 会话间已是树 |
| bridge 跑在 pi 进程内，可调 `ctx.navigateTree()`/`ctx.fork()` | `extensions/types.d.ts:263-296` | 切分支无需动 pi |
| bridge **未订阅** `session_tree` | `live-session.ts` 无该订阅 | **必须补，否则 web 失同步** |
| `parseSessionTree` 不解析 `label`、不读 header、同步整文件读 | `session-store.ts:227-275` | 解析层要扩 + 要异步 |
| `LiveSessionPathPolicy.authorize()` 只接受目录 | `path-policy.ts:57` | **不能复用它校验文件** |
| 控制权 = claim + lease | `live-session/lease.ts` | 写操作必须持 lease |

---

## 3. 总体架构（v2）

```
┌─────────────────────────── 前端（React） ───────────────────────────┐
│  <SessionFamilyGraph>  图：家族树（跨文件）                            │
│  <SessionTreeList>     列表视图                                       │
│  <SidebarForest>       侧栏：家族 + 子代理两层                         │
│  <BranchDetailPanel>   预览/提交分离 + 撤销                            │
└──────────┬──────────────────────────────────────────────────────────┘
           │ 读：HTTP（异步、带缓存）        写：HTTP → broker 命令
───────────▼──────────────── 后端（Express） ─────────────────────────┐
│  GET /api/live-sessions/:pid/tree        → 家族树（新增）             │
│  GET /api/chat/slots/:key/tree           → 单文件树（已有，可扩家族）  │
│  POST /api/live-sessions/:pid/commands   → 复用，承载新命令（无新端点）│
│  family.ts   会话家族拼装（沿 parentSessionPath）                     │
│  tree.ts     解析 + 派生字段 + 异步缓存                                │
└───────────┬──────────────────────────────────────────────────────────┘
            │ broker（WS，已有通道）
┌───────────▼──────────── pi 进程内（bridge 扩展）────────────────────┐
│  L0：pi.on('session_tree') → projector.markChanged() + publish       │
│  L2：protocol v3 { navigate_tree } → ctx.navigateTree()              │
│  L3：protocol v3 { fork_from }     → ctx.fork()                      │
└─────────────────────────────────────────────────────────────────────┘
```

**读路径**：解析 JSONL + 家族拼装（不需要进程存活，会话结束后仍可浏览）。
**写路径**：下发命令给进程内 pi（需 lease）。

---

## 4. 数据模型（v2）

### 4.1 关键修正：三层状态要分开

v1 把三种"分支状态"混成一个"孤儿"概念，这是错的。v2 明确三层：

| 层 | 含义 | 视觉 |
|---|---|---|
| **废弃分支**（in-file abandoned） | 同文件里不是当前活动路径的分支 | 淡化（opacity .55），**不**标"未运行" |
| **未运行会话**（session without process） | 文件存在但没有 pi 进程（fork 后旧会话、或已退出） | 会话级徽标"未运行" + 只读 |
| **未持久化**（no sessionFile） | `--no-session` 启动，无文件 | 空态"该会话未持久化，无树可看" |

### 4.2 树节点

```ts
interface SessionTreeNode {
  id: string
  parentId: string | null
  sessionFile: string          // 所属文件（跨文件时用于分组/着色）
  kind: 'message' | 'branch_summary' | 'compaction' | 'model_change' | 'custom' | 'label'
  role: 'user' | 'assistant' | 'toolResult' | 'branchSummary' | 'compaction' | 'system'
  text: string
  fullText?: string            // 仅 user（保持现行为）
  tools?: string[]
  timestamp?: string
  label?: string               // ← 新增：解析 label entry（v1 缺失）
  // 派生
  childCount: number
  isBranchPoint: boolean
  isOnActivePath: boolean
  isHead: boolean
  isForkRoot: boolean          // ← 新增：本文件是 fork 出来的（挂在父文件的分叉点上）
}
```

### 4.3 会话家族（v2 的核心新增）

```ts
interface SessionFamily {
  sessions: Array<{
    sessionFile: string
    sessionId?: string
    parentSessionFile: string | null   // ← SessionHeader.parentSession
    forkFromEntryId?: string | null    // ← 父文件里的分叉点（需在父文件中定位）
    role: 'main' | 'subagent'
    alive: boolean                     // 是否有运行中的 pi 进程
    isHeadSession: boolean             // 当前查看的会话
  }>
  entries: SessionTreeNode[]           // 全部文件的节点，合并到一张图
  heads: Record<string, string | null> // sessionFile → 该文件的 leafId
  truncated: boolean
}
```

**家族拼装规则**：
1. 从当前会话文件出发，沿 `parentSession` 向上收集祖先，向下收集子会话（需要枚举同 `cwd` 下 sessions 目录，读 header）。
2. 每条 fork 边：父文件里定位"分叉点"——即子文件 root 的父。实现上取子文件**第一条 entry 的 `parentId`**（`createBranchedSession` 会保留路径，root 的 `parentId` 指向父文件的那个 entry）。若定位不到，退化为把子文件根挂在父文件 HEAD 上并标 `unresolved`。
3. 子代理会话（`role:'subagent'`）不并进家族图，单独作为挂载在 `parentToolCallId` 节点上的折叠子树。

> ⚠️ **拼装第 2 条需要开工前做一次 5 行探针验证**：fork 出来的文件里，root entry 的 `parentId` 是否确实指向父文件的 entry id（而非 null）。若为 null，则只能按时间戳近似挂载——这会显著影响图的可读性。**这是 v2 新增的第二个未知数。**

---

## 5. 后端设计

### 5.1 读：`GET /api/live-sessions/:processInstanceId/tree`

```
200 → SessionFamily
404 → { error: 'live_session_not_found' }
```

实现要点：
- **异步读**：用 `fs/promises`，不要 `readFileSync`。
- **缓存**：key = `sessionFile + mtime + size`；命中直接返回。
- **家族拼装**：`family.ts` 沿 `parentSession` 上/下遍历；同 cwd 的 sessions 目录列表也缓存（TTL 5s）。
- **节点上限**：默认 2000 节点/文件；超限只保留"活动路径 + 分支点 + 最近 N 条"，并置 `truncated: true`。
- **安全校验**（替代 v1 的错误做法）：
  ```
  sessionFile 必须 realpath 后落在 <agentDir>/sessions/ 之内
  agentDir = process.env.PI_CODING_AGENT_DIR || ~/.pi/agent
  否则 403 { error: 'out_of_scope' }
  ```
  **不复用** `LiveSessionPathPolicy`（它只接受目录）。

### 5.2 写：复用 `POST /api/live-sessions/:id/commands`

**不需要新端点**（v1 已确认）。L2/L3 只需在 `validateLiveSessionCommand` 与 `sendBrowserCommand` 的白名单里加上新命令类型，并归入"需要 lease"集合。

### 5.3 Chat Slot 侧

`GET /api/chat/slots/:key/tree` 已有；v2 允许它复用 `family.ts` 返回家族（可选，非 L0 必须）。
`POST /api/chat/slots/:key/navigate` 只在 **SDK 通道**可用（RPC 无 navigate 命令）→ 不在 L0–L3 范围。

---

## 6. 协议与 bridge 改动

### 6.1 L0（**不 bump 协议版本**）

bridge 新增订阅：

```ts
pi.on("session_tree", (_event, ctx) => {
  projector?.markChanged()              // 让下次 snapshot 反映新 HEAD
  publish("session_tree", { newLeafId, oldLeafId }, ctx)   // 通知 web 立即重取
})
```
- `session_tree` 是 pi 已有的扩展事件（`guide/extensions.md`，携带 `newLeafId`/`oldLeafId`）。
- 现有 `bindings` 表（`routes/live-sessions.ts`）需加一条 `['session_tree', 'live_session_tree_changed']` 或复用 `live_session_event`。
- **不改协议版本号**，因为只新增一个上行事件、不新增下行命令。

### 6.2 L2/L3（**也不 bump 协议** —— v4 关键简化）

**发现**：bridge 投递输入用的是 `pi.sendUserMessage()`（`live-session.ts:164-176`），而代码注释明确写着：

> *“For a model prompt sendUserMessage resolves at the end of the turn; for a slash command (e.g. `/effort` raising a dialog) pi executes the extension [command]”*

所以：**以 `/` 开头的文本会被 pi 当作斜杠命令执行**。而 `{type:'input', text}` 已是**现有**协议命令。

因此 L2/L3 的做法改为：

```ts
// bridge 新增两个扩展斜杠命令（注册，不需要协议字段）
pi.registerCommand('ls-navigate', { handler: async (args, ctx) => { ... ctx.navigateTree(args.trim()) } })
pi.registerCommand('ls-fork',     { handler: async (args, ctx) => { ... ctx.fork(args.trim())       } })

// dashboard 侧：直接复用已有的 commands 端点与命令类型
POST /api/live-sessions/:pid/commands
  { command: { type:'input', channel:'web', text:'/ls-navigate <entryId>' } }
```

**收益**：
- **不改协议版本号**（无 `parseHello` 严格相等问题、无 v2/v3 区间兼容、无版本偏差）
- 不需要给 `validateLiveSessionCommand` / `sendBrowserCommand` 加白名单
- 风险最高的那部分工作（协议兼容）**整个消失**

**代价与对策**

| 代价 | 对策 |
|---|---|
| 没有结构化 `command_result`（不知道成功/失败） | 结果通过**已有的 `session_tree` 事件 + snapshot 变化**确认；失败时 bridge 用 `ctx.ui.notify` + `publish` 上抛 |
| `input` 命令在 registry 与 bridge 都**不要求 lease** | 在 bridge 的斜杠命令 handler 内自行 `lease.assertLease`（lease 对象就在同文件内） |
| 命令文本会进入会话历史 | `/ls-*` 是一次性斜杠命令（不产生 turn，与 `/live-session-reload` 同一机制），不会污染上下文 |

> 如果后续需要严检的返回码（例如 UI 要区分 session_busy / not_found），再升级为结构化命令；这不影响现在开工。

### 6.3 bridge 侧实现要点

1. **先做 5 行探针**：确认斜杠命令的 `ctx` 是否含 `navigateTree`/`fork`（`ExtensionCommandContext` 有）。
2. 斜杠命令 handler 内：`lease.assertLease(...)` + `if (!ctx.isIdle()) 拒绝`。
3. `fork` 会改 sessionId → 现有 `registry.sessionChanged`（`registry.ts:137`）已处理清 lease + 广播。
4. 旧 bridge（未升级）在 UI 上自动无写操作（无 `/ls-*` 命令即无法调用），**不需要版本协商**。

---

## 7. 前端设计

### 7.1 组件

| 组件 | 职责 |
|---|---|
| `SessionFamilyGraph` | **独立的图谱页**（路由 `/live-sessions/graph`），渲染家族图 + 节点导航 |
| `BranchDetailPanel` | 选中节点详情 + 动作（预览/提交分离） |
| `ReadonlySessionView` | 无进程会话的只读转录（数据来自同一份 family 解析结果） |
| `useSessionFamily(focus)` | 取数 + 事件失效刷新（**仅图谱页打开时订阅**） |
| `useLiveSessionControl()` | 复用现有 claim/lease |

**已移除**：v2 的 `SessionTreeList` 列表视图与 图/列表 切换（需求收敛为"只要一个 graph 页"）。

### 7.2 布局（仅一种）

**分层**：深度 = 分支层级（左→右），tidy tree（父节点居中于子节点）。

**已取消泳道布局**（v2 曾计划 L1 加入）——需求明确不要。

### 7.3 状态

```ts
interface GraphState {
  view: 'graph' | 'list'
  layout: 'layered' | 'lanes'
  filter: 'all' | 'user' | 'labeled' | 'no-tools'
  selectedId: string | null
  pendingCommit: { kind: 'navigate'; targetId: string } | null   // ← 预览/提交分离
  undo: { previousLeafId: string; sessionFile: string } | null   // ← 撤销
  collapsed: Set<string>
}
```

---

## 8. UI/UX 规范（v2）

### 8.1 布局

三栏：侧栏森林（280px）· 树图画布（自适应）· 详情面板（320px）。
`<1280px` 详情变浮层；`<900px` 侧栏变抽屉。

### 8.2 节点视觉（区分三层状态）

| 状态 | 视觉 |
|---|---|
| 活动路径 | 边/描边 `--accent`，opacity 1 |
| **废弃分支**（同文件） | 边 `--border-strong`，节点 opacity **0.55** |
| **fork 边**（跨文件） | 边 `--info` **虚线**，中点标 `fork` 小标签；子文件节点组加浅色背景带（`--info-subtle`） |
| **未运行会话** | **会话级**徽标"未运行"（`--warn`）+ 该组写操作禁用 |
| HEAD | 左实心点 + `HEAD` 徽标 + `--accent` 外发光（**每个会话各有一个**） |
| 分支点 | 右缘实心三角 + 计数 |
| 子代理子树 | 分组框，默认折叠 |
| `branch_summary` | 切角矩形（区别于普通消息） |

**每个会话一个 HEAD**：家族图里会有多个 HEAD（父会话的 + 子会话的），必须都标出来，否则"我到底在哪"会混乱。

### 8.3 交互（v3：图谱 ↔ 会话 双向跳转）

图谱页是**独立路由**（`/live-sessions/graph`），节点与会话页双向可达：

| 交互 | 行为 |
|---|---|
| **单击节点（属于其他会话）** | **打开那个 agent session**，并定位到该节点（`?session=<id>&node=<entryId>`） |
| **单击节点（属于当前会话）** | 只选中 + 右侧详情（**不跳页**，避免浏览家族时被反复弹出）；会话页同步高亮该行 |
| 会话页「**在图谱中查看**」 | 回到图谱页，聚焦该会话（`?focus=<sessionId>&node=<entryId>`，高亮分组 + 选中节点） |
| 详情面板「打开该会话」 | 同“单击其他会话节点”（从会话页返回后仍可用） |
| `切到此处` | 需显式点击 → 移动 HEAD → 出现**撤销条** |
| `编辑并重发`（user 节点） | 点击后：移到其 parent + 文本回填输入框 → 撤销条 |
| `从此分叉` | 调 `fork_from` → 新会话加入家族图，高亮 fork 边 |
| **撤销** | 顶部条 `HEAD 已从 X 移到 Y · [撤销]`，5s 自动消失 |
| 拖拽 / 滚轮 | pan / zoom（0.3–2.0） |
| `Ctrl+O` / `F` / `Esc` | 循环过滤器 / 适配 / 取消选中 |
| 折叠子树 | 若 **HEAD 在被折叠的子树内，自动展开到 HEAD** |

**为什么单击跨会话节点直接跳页**：图谱是“定位与导航面”，用户的意图是“去那个会话看”。要避免的反而是**在同家族内浏览时被反复弹出**，所以“当前会话内单击只选中”。

**无进程会话怎么“打开”**：用 `ReadonlySessionView` 从其 JSONL 渲染只读转录（数据就是家族解析的同一份），顶部标“未运行 · 只读”，输入框禁用，并提供「在此会话启动 live session」（L3）。

### 8.4 触屏（v1 遗漏）

hover 动作在触屏不可用。**统一以"选中 → 详情面板操作"为唯一通道**；hover 浮现仅作桌面加速键，不作为功能前提。

### 8.5 空 / 加载 / 错误 / 结束态

| 状态 | 表现 |
|---|---|
| 加载 | 骨架节点（无 shimmer） |
| **未持久化**（无 sessionFile） | 居中空态："该会话未持久化，无树可看（`--no-session` 启动）" |
| **会话已结束**（无进程） | 树仍可浏览；会话级"未运行"标签；写操作全禁用 |
| 仅活动分支（家族拼装失败降级） | 顶部细条 `⚠ 仅显示活动分支` |
| navigate 失败 | 面板内 `--danger-subtle` + 重试，不弹全局 modal |
| 超限截断 | 顶部细条 `⚠ 树已截断（超过 2000 节点）` |

### 8.6 可访问性

- 节点 `role="button"` + `tabIndex=0` + `aria-label`（含角色/状态）。
- **SVG 焦点环需显式实现**（全局 `:focus-visible` 对 `<g>` 不可靠）。
- 状态不单靠颜色：HEAD/未运行/截断都有文字。
- 动效走全局 `prefers-reduced-motion`。

### 8.7 设计令牌

全部复用现有变量；字号只用 `text-2xs / text-meta / text-body-s / text-sm`。

---

## 9. 并发、安全与性能

| 项 | 设计 |
|---|---|
| 写操作并发 | 强制 lease；无 lease 返回 409 |
| **读性能** | 异步读 + `path+mtime+size` 缓存 + **仅面板打开时订阅** + 事件防抖 500ms |
| 家族遍历性能 | sessions 目录列表 TTL 缓存 5s；祖先链深度上限 20 |
| 节点上限 | 2000/文件，超限截断并标记 |
| **路径安全** | 校验 `sessionFile` realpath 在 `<agentDir>/sessions/` 内（**不用** `LiveSessionPathPolicy`） |
| 敏感内容 | 只返回截断文本，与现 `parseSessionTree` 一致 |
| 删除分支 | v1 起即不做（append-only，删需重写 JSONL） |
| 孤儿会话 | 标记"未运行"；L3 提供"在此分支启动 live session" |

---

## 10. 分期与验收（v2）

### L0 — 家族树 + 图页面（**跨两个仓库，不 bump 协议**）

交付：
- bridge：`session_tree` 订阅（A2）
- 后端：`family.ts` + `tree.ts` + `GET /api/live-sessions/:pid/tree`（异步、缓存、家族拼装、正确校验）
- 前端：**图谱页**（`/live-sessions/graph`）`SessionFamilyGraph` + `BranchDetailPanel`（预览态）+ `ReadonlySessionView`
- **双向跳转**：图谱节点 → 打开会话（带 `?node=` 定位）；会话页「在图谱中查看」→ 回图谱（带 `?focus=`）
- 解析层：支持 `label` entry 与 `header.parentSession`（B1）——标签在 L0 **只读展示**，写入留 L4
- 家族呈现：**一张图 + 文件分组带**；当非当前会话节点数 > 60 或会话数 > 3 时，自动把非当前会话折叠为"会话摘要节点"（可展开）

**验收**
- [ ] 对任一活跃 LiveSession，图能显示**家族树**：同文件分支 + 跨文件 fork 边 + 每个会话的 HEAD。
- [ ] **双向跳转闭环**：图谱里点 A 会话的节点 → 打开 A 会话并定位到该消息；在 A 会话点「在图谱中查看」→ 回到图谱且 A 的分组与节点被高亮。
- [ ] 同会话内单击节点**不跳页**（只选中）。
- [ ] 无进程会话可打开**只读转录**，输入框禁用并标"未运行"。
- [ ] 在 tmux 里执行 `/tree` 切分支，**web 在 2s 内自动刷新**新 HEAD（A2）。
- [ ] `sessionFile` 不在 `<agentDir>/sessions/` 内时返回 403（A3）。
- [ ] 打开 5MB / 5000 entry 的会话，树端点响应 < 500ms，且**不阻塞其他请求**（B2）。
- [ ] 无 sessionFile 时显示"未持久化"空态；无进程时显示"未运行"且写操作禁用。
- [ ] 触屏（无 hover）下所有操作可达（C5）。
- [ ] 明暗主题对比度达标，`npm run check:theme-cvd` 通过。

### L1 — 侧栏森林增强
家族 + 子代理两层；点击联动画布；"展开到 HEAD"。

### L2 — 原地切分支（协议 v3）
`navigate_tree` + **v2–v3 区间兼容**（§6.2）+ 能力协商透出 + 预览/提交分离 + 撤销。

**验收**
- [ ] 持 lease 时可切分支，HEAD 移动、无新文件。
- [ ] 无 lease → 409 + UI 提示。
- [ ] **未升级的 v2 bridge 仍能正常连接**（不报 unsupported_protocol），只是写操作被隐藏。
- [ ] 误操作可一键撤销回原 HEAD。
- [ ] 回答进行中拒绝（`session_busy`）。

### L3 — 任意点分叉 + 未运行会话
`fork_from`；未运行会话"在此启动 live session"（需 launcher 支持按 sessionFile 恢复）。

### L4 — 标签与临时分支
标签写入 pi `label` entry（终端 `/tree` 同步可见）；`scratch` 过滤；折叠已完结分支。

---

## 11. 风险（v2）

| 风险 | 等级 | 缓解 |
|---|---|---|
| **fork 文件的 root `parentId` 是否指向父文件 entry 未知** | **高** | L0 开工前 5 行探针；为 null 则退化为时间戳近似挂载 |
| bridge 的 ctx 是否含 `navigateTree` 未知 | 中 | L2 前探针；不行走 `commandContextActions` 注入 |
| 家族拼装在深链/大目录下变慢 | 中 | 祖先链深度上限 + 目录列表 TTL 缓存 |
| ~~协议区间兼容写错导致旧 bridge 被拒~~ | — | **已消失**：不再有协议变更 |
| 斜杠命令无结构化返回（不知道成功/失败） | 中 | 靠 `session_tree` 事件 + snapshot 变化确认；失败由 bridge `publish` + `ui.notify` 上抛 |
| 大会话渲染（p99 4682 节点、最大 7176） | **高** | 有界读取 + 节点上限 + 长线性段折叠 + 视口裁剪；11% 的会话会碰到 |
| 中位会话（110 节点）很短，图谱易显得空 | 中 | 接受；价值在“让分叉变容易”，不在“展示已有分支” |
| 多 HEAD 造成认知混乱 | 中 | 每个会话明确标 HEAD；当前查看会话加高亮边框 |
| 图节点过多 | 中 | 折叠 + 节点上限 + 简化渲染 |

---

## 12. 决策（已定，v2）

| # | 决策 | 理由 | 影响 |
|---|---|---|---|
| 1 | **一张图 + 文件分组带**；非当前会话**按阈值自动折叠**（节点 > 60 或会话数 > 3），可展开 | 家族通常只有 2–3 个文件、且 fork 子文件只含 root→leaf 路径（节点少）→ 直接铺开最利于"对比分支"；大到一定程度再折叠，避免深链家族把画布撑爆 | 不引入"父为根/子可展开"的第二套导航模型 |
| 2 | **接受 L0 跨两个仓库** | A2（`session_tree` 订阅）是正确性刚需：不修则终端 `/tree` 一操作 web 就失同步；且它只是**一个事件订阅、不 bump 协议**，成本极小 | L0 的验收因此变得可测（"tmux 切分支后 web 2s 内刷新"） |
| 3 | **navigate 是默认主路径，fork 是显式次级动作** | navigate 分支留在同一文件 → 与"看树/对比分支"的价值主张一致，且**不产生会话泛滥**；fork 每分一次就多一个文件 + 一个"未运行"死会话，还要求并行跑两个方向才有收益 | 按钮层级：`切到此处` = primary，`从此分叉` = secondary；分期保持 **L2（navigate）先于 L3（fork）** |
| 4 | **标签以 pi `label` entry 为唯一真源**；L0 只读、L4 写入 | 与"web 与终端是同一个会话"的既定原则一致；pi 终端已有 `Shift+L` 打标签的 UI，用 `meta.json` 会造成**双真源**且终端不可见 | L0 顺带把 `label` 解析做掉（本来就是 B1），写入留 L4 |
| 5 | **泳道彻底取消**，只保留分层 | 需求明确不要；分层已足以理解分支结构 | 移除泳道分配 + 异形边路由的实现与测试成本 |
| 6 | **图谱页为独立路由**，与会话页**双向跳转** | 图谱的价值是“定位与导航面”；用户的需求是“从图里点开去会话，从会话回到图” | 单击跨会话节点 = 打开会话并定位；单击同会话节点 = 只选中（不跳页）；会话页加「在图谱中查看」 |
| 7 | **只做一个 graph 页**，不做图/列表切换 | 需求收敛为“只要一个 graph 页就行” | 移除 v2 的 `SessionTreeList` 与视图切换 |

---

## 13. 可复用的开源资产（已核实许可）

| 工具 | 许可 | 形态 | 结论 |
|---|---|---|---|
| **不新增任何 npm 依赖** | — | — | ✅ **自写原生 SVG 图谱**：我们的数据是**树**（家族图仍是树），tidy-tree 布局 ~15 行（mock 已跑通两版）；pan/zoom/命中 ~250 行；全部用 pi 现成 API |
| pi 自带 `SessionManager.getTree()/getBranch()/header.parentSession` | 内置 | API | ✅ 解析与树能力全部用 pi 现成的，**不自写解析器** |
| `pi-session-tree-browser` | **MIT** ✅ | pi 扩展，**单文件 138KB**（扩展+内嵌 HTML/JS/CSS） | ⚠️ **只作参考/临时工具，不作依赖**：不是组件库，无法 import；且它会重写 JSONL（违背我们的 append-only 原则） |
| `pi-context-tree` | **MIT** ✅ | TUI 浮层 + 只读 CLI（`core` 零 pi 依赖） | ️ 设计可参考；**其 web dashboard 仍在 roadmap（未做）** → 证明本功能无现成替代 |
| `vercel/ai-elements` | **Apache-2.0** | shadcn 注册表 | ⚠️ 只有 `conversation.tsx` / `file-tree.tsx`，**没有 conversation-tree**（且是列表不是图） |
| `tryelements.dev` 的 conversation-tree | ❓来源不明 | 第三方 shadcn 注册表 | ❌ 不引入 |
| `tldraw` | ⚠️ source-available（非 OSS） | 无限画布 | ❌ 许可不允许，仅借鉴交互 |

**确定不做的**：**不新增任何 npm 依赖**；不引 `pi-session-tree-browser` 作为依赖；不用 tldraw；不用来源不明的注册表。

**为什么不用 React Flow**：它主要省的是 canvas/pan-zoom/命中测试，但对**树**这种结构，自写布局比引入通用图引擎更短；而且它自带的节点/边样式与设计令牌（HEAD 徽标、文件分组带、fork 虚线边）会打架。自写的代价是失去视口虚拟化 → 用**节点上限 + 线性段折叠 + 视口裁剪**对冲（**这些本来就因真实数据规模而必需**，见 Phase 0）。

---

## 14. 实施计划

### Phase 0 — 零依赖数据验证（**已完成**）

不装任何东西，直接扫真实会话文件（`~/.pi/agent/sessions/*/*.jsonl`，最近 336 个）：

| 指标 | 结果 | 含义 |
|---|---|---|
| 文件由 fork 产生（有 `parentSession`） | **3 / 336** | 跨文件家族极罕见 |
| 文件内存在分支点 | **10 / 336** | **97% 的会话是纯线性** |
| 分支点分布 (0,1,2,3) | 326 / 7 / 2 / 1 | 树形工作目前几乎没被用起来 |
| entries 中位数 / p90 / p99 / 最大 | **110 / 1079 / 4682 / 7176** | 中位数很小 → 自写 SVG 完全够用 |
| 单文件体积 p50 / p90 / 最大 | **0.38MB / 5.55MB / 764MB** | 尾部极重 → **必须有界读取 + 节点上限** |
| >1000 entries 的会话 | 38 / 336（11%） | 折叠线性段是刚需 |

**两条结论**

1. **只读图谱的独立价值低**（97% 情况是一条直线）→ 真正的价值在**让“分叉/切分支”变便宜**。因此 **L0 必须与最小写动作（切分支）同批交付**，否则图谱做出来没东西可看。
2. 渲染选择被数据证实：中位数 110 节点 → **自写 SVG 足够**；11% 的大会话靠折叠 + 上限处理。

### Phase 1 — 两个探针（约 30 分钟）

| # | 探针 | 方法 | 若失败则 |
|---|---|---|---|
| 1 | fork 文件的 root entry 的 `parentId` 是否指向**父文件**的 entry id | 造一段会话 → `fork` → 读新文件首个 entry 的 `parentId` | 家族图退化为“按时间戳近似挂载”（但 fork 仅 3 个文件，影响面小） |
| 2 | 斜杠命令的 `ctx` 是否含 `navigateTree`/`fork` | 在 bridge 打一行 `typeof ctx.navigateTree` | 退回到结构化命令（需加协议字段，但不阻塞只读图谱） |

### Phase 2 — 实施（6 步，**零新增依赖 + 零协议变更**）

| 步骤 | 仓库 | 产出 | 估时 |
|---|---|---|---|
| **2.1 解析 + 家族（纯函数，先写测试）** | pi-dashboard | `backend/live-sessions/tree/parse.ts`（**有界读取**：>20MB 只读尾部；扩 `label` 与 `header.parentSession`；派生字段）、`family.ts`、`cache.ts`（`path+mtime+size`）；`backend/__tests__/live-session-tree.test.js` | 1.5d |
| **2.2 端点** | pi-dashboard | `GET /api/live-sessions/:pid/tree`（只读）；校验 `sessionFile` 在 `<agentDir>/sessions/` 内；节点上限 + **长线性段折叠** | 0.5d |
| **2.3 bridge：事件 + 两个斜杠命令** | **pi-tsien-extension** | `pi.on('session_tree')` → `markChanged()` + publish；`pi.registerCommand('ls-navigate'\|'ls-fork')` → `ctx.navigateTree`/`ctx.fork` + lease 校验 | 0.5d |
| **2.4 图谱页（原生 SVG）** | pi-dashboard | `frontend/src/features/session-tree/`：`SessionFamilyGraph.tsx`（SVG + pan/zoom）、`layout.ts`（tidy-tree ~15 行）、`GraphNode.tsx`、`BranchDetailPanel.tsx`、`useSessionFamily.ts`；`App.tsx` 加路由 | 2d |
| **2.5 写动作接入** | pi-dashboard | 「切到此处 / 从此分叉」→ 走已有 `/commands` 端点发 `input:'/ls-navigate <id>'`；预览/提交分离 + 撤销条 | 0.5d |
| **2.6 双向跳转 + 只读会话** | pi-dashboard | 节点→会话（`?session=&node=`）、会话→图谱（`?focus=&node=`）、`ReadonlySessionView` | 1d |

合计约 **6 人日**；**无新依赖、无协议变更、无版本兼容风险**。

### Phase 3 — 验收

按 §10 L0 的 10 条验收逐条跑；额外必跑：
```bash
cd <pi-dashboard repo> && npm run typecheck && npm test
cd frontend && npm run typecheck && npm test && npm run check:theme-cvd
cd <pi-tsien-extension repo> && npm run check
```

### Phase 4 — 交付

- pi-tsien-extension 改动属**仓库直加载**，无需构建/同步
- ⚠️ **已运行的 live session 需 `/reload`** 才能加载新 bridge 代码
- 前端重建 + 服务重启由**用户执行 `./run.sh`**

### Phase 5+（后续，不在本次范围）

L1 侧栏森林增强 → L3 fork/未运行会话启动 → L4 标签写入。（原 L2 “协议 v3 + 区间兼容”已并入 Phase 2.3/2.5，**不再需要**）

---

## 15. 落地记录（v5，L0.1 已实现）

### 15.1 交付物

| 文件 | 变更 |
|---|---|
| `shared/src/session-tree.ts` | **新增**：图类型 + 上限常量（`SESSION_TREE_MAX_NODES=3000`、`MAX_SESSIONS=40`、`LINEAR_RUN_MIN=3`、`MAX_PARSE_BYTES=20MB`、`TAIL_BYTES=8MB`） |
| `backend/live-sessions/session-tree.ts` | **新增**：头部索引（只读每文件首行）· 有界异步解析（mtime+size 缓存）· 家族拼装（祖先+后代 BFS）· 前缀去重· 线性段折叠 |
| `backend/routes/live-sessions.ts` | **改**：`GET /api/session-tree?file=` + `SessionTreeError` 错误码映射 |
| `backend/__tests__/session-tree.test.ts` | **新增**：9 个用例（fork 去重/标签/工具/能力/越界/超大会话尾读/折叠） |
| `extensions/live-session.ts` | **改**：`session_tree` 订阅（`markChanged` + `sendSnapshot` + publish）· `/ls-navigate` · `/ls-fork` · 能力声明 |
| `extensions/live-session/protocol.ts` | **改**：`LiveSessionSummary.capabilities?`（附加可选字段） |
| `test/live-session.test.ts` | **新增** 3 个用例（能力/快照、命令调用、拒绝路径） |
| `frontend/src/features/live-sessions/graph/*` | **新增** 6 个文件：`layout.ts`（tidy-tree ~60 行）· `useSessionTree.ts` · `SessionFamilyGraph.tsx`（原生 SVG + pan/zoom + 分组带 + fork 边）· `BranchDetailPanel.tsx` · `SessionGraphPage.tsx` |
| `frontend/src/App.tsx` | **改**：路由 `/live-sessions/graph` + 侧栏入口 |
| `frontend/src/features/live-sessions/api.ts` | **改**：`sessionTree()` · `sessionTreeAction()` |
| `frontend/src/features/live-sessions/LiveSessionPage.tsx` | **改**：「在图谱中查看」按钮 + `?node=` 定位条 |

### 15.2 两个探针（均通过）

| 探针 | 结果 | 证据 |
|---|---|---|
| `ctx.navigateTree`/`ctx.fork` 在斜杠命令里可用 | ✅ | `dist/bundle/...chunk-MU3PTSMJ.js` 的 `createCommandContext()` 显式挂 `context.navigateTree/fork/reload` |
| fork 文件 root `parentId` 是否指向父文件 | ✅ **结论比预期更简单** | 真实 fork 文件 **root `parentId = null`**，但**复制了父文件的前导前缀且 entry id 完全相同**（验证：父子共享 id 且同序）→ 锚点 = **最后一个共享 id** |

### 15.3 与计划的偏差（全部已实测确认）

| # | 计划 | 实际 | 原因 |
|---|---|---|---|
| 1 | `GET /api/live-sessions/:pid/tree` | `GET /api/session-tree?file=` | 按**文件路径**键控，未运行会话也能看；且避免与 `/api/live-sessions/:processInstanceId` 单段路由冲突 |
| 2 | `ReadonlySessionView` 渲染未运行会话转录 | **未实现**：改为把图谱**重新聚焦**到该文件 | 诚实缩减：转录渲染器是新组件，价值低于写路径；已在 UI 里明说 |
| 3 | bridge 内 `lease.assertLease` | **未宣称的规则**：未占用 → 允许；已占用 → **必须带匹配 leaseId** | `input` 通道不携带 browserClientId，无法鉴定调用方；与已有 `input` 同一信任模型 |
| 4 | 无协议变） | **新增** `summary.capabilities: ["session_tree"]` | ️ **必需**：`_tryExecuteExtensionCommand` 对未知命令 `return false` → pi 会**把 `/ls-navigate` 当普通 prompt 发给模型**。该字段是可选的、纯追加的，**不 bump 协议版本** |
| 5 | 长线性段折叠在 UI 做 | **改为服务端**（`kind:'collapsed'`, id `run:<headId>`） | 否则 7000 条的会话先得传 7000 个节点；L0 不提供展开 |

### 15.4 验证证据

| 检查 | 结果 |
|---|---|
| `backend` 全套（含新增 14 例） | **26 files / 351 passed**，1 skipped |
| `pi-tsien-extension` 全套（含新 3 例） | **239 passed**，1 failed —— `conversation-workbench.test.ts`，**已用 `git stash` 验证为既有失败** |
| `frontend` 全套 | **662 passed**，6 failed —— 已用 `git stash` 验证**同样是既有失败** |
| `frontend` typecheck（修后真实门禁 `tsc -b --noEmit`） | ✅ 通过，且能用探针拦下故意插入的错误 |
| `frontend` `npm run build`（`tsc -b` + vite） | ✅ 通过（built in 32.51s） |
| `check:theme-cvd` | ✅ 未改主题色，结论与改动前一致 |
| 真实数据冒烟 | 764MB 会话 **198ms / 325 节点 / partial=true**；中位会话 5ms；真实 fork 家族 6 节点（父 4 + 子 2，**无重复**）；缓存命中 3ms |

### 15.5 既有问题（本次已修 1 项）

- ⚠️ **`frontend` 的 `npm run typecheck` 原本是空操作，已修**。`tsconfig.json` 是 solution-style（`files: []` + `references`），旧 `tsc --noEmit` 编译 0 个文件 → 始终通过。
  - 实证：故意插入 `export const broken: string = 42`，`tsc --noEmit` 退出码 0 不报错；`tsc -b` 正确报 TS2322。
  - 已改为 **`tsc -b --noEmit`**（TS 5.9 支持），修后同一探针能被正确拦下。
  - 影响：之前任何“前端 typecheck 通过”都是**空洞结论**；真正的首次代码检查发生在 `npm run build`（也正是它招出我 2 个类型错误）。
- `frontend/src/test/dbg2.test.tsx` 是未跟踪的遗留文件（非本次新增）。
- 两个仓库都有大量本次之外的未提交改动，已保留未动。

### 15.6 收尾修复（同一轮补完）

| # | 问题 | 修复 |
|---|---|---|
| 1 | 会话页「在图谱中查看」传了 `&node=<processInstanceId>` —— 那不是 entry id | 去掉该参数（dashboard 侧拿不到当前 leaf entry id） |
| 2 | 选中**折叠节点**后点「打开会话/定位」，会把合成 id `run:<headId>` 传给 `/ls-navigate` | 新增 `actionableNodeId`，过滤 `run:` 前缀 |
| 3 | 多级 fork 缺单测（上轮列为“未覆盖”） | **已补A→B→C 测试**：7 节点、无重复、B 锚 u3 / C 锚 a5；另补“父文件已删”用例（`forkOf` 保留、`forkAnchorId=null`） |
| 4 | `frontend` typecheck 空操作 | 见 §15.5 |
| 5 | **路径不存在时返回 200 + 空图**（会误导用户以为是空会话） | 拆开语义：不存在 → **404 `session_file_not_found`**；越界 → **403 `session_file_out_of_scope`**；缺参数 → **400 `session_file_unavailable`** |
| 6 | **HTTP 路由本身无测试**（只测了 builder） | 新增路由级测试：未鉴权 401 / 缺参 400 / 越界 403 / 不存在 404 / 正常 200（含 payload 断言） |

### 15.7 未验证 / 后续

- ❗ **端到端未跑**：需要用户在会话里 `/reload`（否则命中 §15.3 #4 的能力守卫，写按钮会禁用）+ `./run.sh` 重建重启后，实际点一次「切到此处」/「从此分叉」。
- ❗ 已由 **§16 的「显示步骤」开关（`?detail=full`）** 解决；`collapsedRange` 仍可用于后续的「就地展开单段」。
- ❗ **多级 fork 已有单测覆盖但真实数据未验**：已补 A→B→C 用例（绿）；真实环境只有 3 个 fork 且父文件是 pi 测试夹具，没有真实的多级家族可看。
- **未运行会话的转录视图**（原 `ReadonlySessionView`）未做。
- 大会话下**视口裁剪**未做：节点已在服务端限到 ≤3000 + 折叠，但 SVG 仍会渲染全部节点（当前真实最大 325）。

---

## 16. 阅读友好性修订（v6）

### 16.1 现象与根因

真实会话（线性 55 节点）在图上表现为**一条不可读的长条**：

- 布局把**深度放在 X 轴**，线性会话于是变成 `55 × (212+76) ≈ 15,840px` 的长条；
- `fit()` 为装下全部而缩到 **k ≈ 0.10** → 卡片变成 21px 宽。

根源不是布局，而是**“什么该显示”**：旧折叠规则把 `role === 'user'` 当结构节点，于是一问一答的会话几乎全被保留。

### 16.2 修订

> 示意图（自包含 HTML，可浏览器打开）：`docs/mockups/session-tree-fold-before-after.html`

| # | 内容 |
|---|---|
| 1 | **折叠规则改为只保留结构节点**：会话起点（每个文件第一个节点）、终点（`isHead`/`isLeaf`）、fork 锚点、分支点（`childCount !== 1`）、pi `label`、`compaction`/`branchSummary`。其余（普通问答与工具步骤）全部折入一个 `collapsed` 节点 |
| 2 | **整个 run 折成一个节点**，并把 run 尾节点的子节点**重挂**到折叠节点上（旧实现额外保留 tail，得到 起点→折叠→tail→终点 共 4 个而非 3 个） |
| 3 | 新增 **`?detail=full`** + 前端「显示步骤 / 仅关键节点」开关 |
| 4 | **去掉「只看用户」筛选**：用户消息不再是结构节点，该筛选已失去意义 |
| 5 | `fit()` 加**可读性下限 `MIN_FIT_ZOOM = 0.4`**：宁可让内容溢出、用户平移，也不再缩到不可读 |

### 16.3 效果（真实数据，无 fork 会话）

| 会话大小 | 旧（节点数） | **新（默认）** | `detail=full` |
|---|---|---|---|
| 764.6 MB | 325 | **8** | 2126 |
| 49.9 MB | 96 | **13** | 2816 |
| 3.4 MB | 46 | **5** | 1688 |
| 0.6 MB | 21 | **3**（起点→+N 步→终点） | 150 |
| 最小 | 6 | **3** | 8 |

### 16.4 代价

- 默认视图下**无法逐条看步骤**：需切「显示步骤」或点「打开会话」看转录。
- 切「显示步骤」会重新请求（`detail=full`），大会话可能达上限 3000 节点并被截断。

### 16.5 就地展开折叠段（v6.1）

点 `+N 步` → **原地展开该段**（`?expand=run:<headId>`，可逗号分隔多个）。

关键设计：展开的内容是**嵌套数据**（`node.steps`），**不进入图布局**。因此：

| 项 | 行为 |
|---|---|
| 顶层 `nodes` / 拓扑 / `fit()` 缩放 / 分组带 / 边 | **完全不变**（否则展开 418 步又会把画布拉成一条长条） |
| 卡片 | 变高到 `NODE_H_EXPANDED = 268`，句部固定、步骤列表在卡内**滚动**（SVG `clipPath` + 偏移；滚轮在卡内滚动而不缩放画布） |
| 步骤行 | **可点** → 选中那一步（真实 entry id），于是「切到此处 / 从此分叉」能直接作用于具体 entry |
| 长度上限 | 单段默认返回 `SESSION_TREE_STEPS_DEFAULT = 400` 步（超出置 `stepsTruncated`）；硬上限 `SESSION_TREE_STEPS_MAX = 3000` |
| 分页 | 卡片底部页脚：`已加载 400/868 步 · 加载更多`；点一下把 `?steps=` 提升一批（+400），已加载步数用 `collapsedCount` 作分母 |
| 布局侧 | `tidyLayout(nodes, heightOf)` 新增每节点高度；同一深度列做**不重叠推挤**（高卡片不会压住邻行） |
| 收起 | 再点卡片或详情面板的「收起」，或切「显示步骤」（会清空展开集） |

**已验证**：展开后顶层节点数不变（真实会话 `01a0ae48`：5）；`run:f46aa332` 返回 400 步且 `stepsTruncated=true`（实际 418 步）。

---

## 17. 手机端精简阅读（v6.2）

### 17.1 问题

会话转录里 thinking 与工具块**本身已经是折叠的**，但**占位行依然在**。用真实会话计数：

| 类型 | 数量 | 手机上的观感 |
|---|---|---|
| `message` (toolResult) | 508 | 一行一个，滚不到底 |
| `message` (assistant，只有 toolCall) | 大量 | 渲染为空/无用行 |
| `custom`（其中 `compact-thinking-duration`） | 458（434） | 纯遥测，无阅读价值 |
| `message` (user) | 22 | **这才是要看的** |

### 17.2 行为

新增 **`useMediaQuery`**（`frontend/src/hooks/useMediaQuery.ts`）。转录新增「精简阅读」开关：

| | 精简阅读（手机默认） | 显示全部（桌面默认） |
|---|---|---|
| thinking 片段 | **整个条目隐去**（不是折叠成一行） | 折叠为 `<details>` 一行 |
| toolCall / toolResult 行 | **隐去** | 折叠为一行摘要 |
| 只有 toolCall 的 assistant 条目 | **整条丢弃**（否则留下空行） | 保留 |
| `custom` 遥测条目 | **隐去** | 保留 |
| user / assistant 正文、compaction、model/thinking 变更 | **保留** | 保留 |

默认由视口决定（`(max-width: 767px)`，与 ChatPage 已有的断点一致），用户切换后写入 `localStorage['live-session-auxiliary']`（`show` / `hide`），跨会话记住。

顶部工具条与转录顶部各有一个开关；转录顶部的提示行会告诉你隐去了多少（思路片段 / 工具处 / 遥测条）。

### 17.3 效果（真实会话）

```
会话总 entry 1509  →  精简阅读后保留 248 条（16%）
```

### 17.4 范围与代价

- **只改了 LiveSession 会话页的转录**（图谱卡片本来就只有一行标题与预览）。
- 桌面不受影响（默认显示全部）；手机上首次进入即为精简。
- **`/chat` 页（SplitPane）的转录未改**：它同样已经默认折叠 thinking / 工具组，但如果也要手机端隐去占位行，需同样接上该开关。

---

## 18. 写操作可用性修正（v6.3）

### 18.1 问题

「从此分叉」看起来永久置灰，而且**没有任何说明**。原因是禁用的四个条件里，只有两个会展示提示：

| 条件 | 旧行为 |
|---|---|
| 未选中真实 entry（选中了**折叠段**） | ❌ **静默置灰** ← 而折叠段正是默认视图的主体 |
| 该文件没有运行中的进程 | 小字提示（位于按钮下方） |
| bridge 未声明 `capabilities.session_tree` | 黄色提示（需 `/reload`） |
| 已被另一浏览器接管 | 小字提示 |

### 18.2 修正

| # | 内容 |
|---|---|
| 1 | **`writeUnavailableReason`**：面板总是明确告诉你为何不能写（未运行 / 旧版扩展 / 被接管 / 折叠段），并写进按钮 `title` |
| 2 | **折叠段直接给出写目标选择器**：选「起点 / 终点」+ 「切到该处 / 从此分叉」，一步到位，不必先展开再在画布里找 |
| 3 | **live 进程改为先按 `sessionId` 匹配**（路径可能因 realpath 写法不同而错配，错配会把所有写操作错误地禁用） |
| 4 | **fork 后自动跟随新会话**：`/ls-fork` 会把 bridge 切到新 session file，URL 里的旧 `file` 会失效（图谱不刷新、写按钮反而变灰）；现在会跟随该进程上报的新文件并跳过去 |

---

## 19. 布局自动转向（v6.4）

### 19.1 问题

布局方向写死为「**深度 → X 轴**」，于是一条长链在窄屏（尤其手机竖屏）上被压成一条细线：

```
5 节点链：内容 1364 × 60 px，手机 390 × 700 → fit k = 0.20（卡片 42px 宽）
```

### 19.2 做法：选「在本页渲染更大」的方向

`tidyLayout(nodes, heightOf, orientation)` 新增 `'vertical'`，并新增两个纯函数：

| 函数 | 作用 |
|---|---|
| `fitScale(layout, w, h)` | 该布局在容器里的适配缩放（≤ 1） |
| `chooseOrientation(h, v, w, h, hysteresis=1.08)` | 比较两者缩放，取更大的一种；接近时**保持横排**（避免拖窗口时来回翻） |

竖向布局：深度 → y，叶子槽位 → x；**每个深度层的高度取其最高卡片**（展开的折叠段是 268px 而非常规 60px）。

UI：工具栏新增三态按钮 `⇄ 自动（竖排/横排）` → `⇄ 横排` → `⇅ 竖排`；容器尺寸用 `ResizeObserver` 跟踪，方向变化会重新 `fit()`。

边也按方向走线：横排是 `右→左` 三次曲线，竖排是 `下→上`。

### 19.3 实测（真实会话 `01a0ae48`）

| 视图 | 容器 | 选择 | 横排 k | 竖排 k |
|---|---|---|---|---|
| 默认（5 节点） | 手机 390×700 | **竖排** | 0.20 | **1.00** |
| 默认（5 节点） | 桌面 1400×800 | 横排（迟滞） | 0.94 | 1.00 |
| 显示步骤（1592 节点） | 任意 | 横排 | 0.05 | 0.05 |

两条诚实结论：

1. 默认视图上手机**从 0.20 提到 1.00**，这就是“自动转弯”的收益。
2. **`显示步骤`（1592 节点）两种方向都无解**（k=0.05，加上 `MIN_FIT_ZOOM=0.4` 只能靠平移）——那个模式本来就不是用来“读懂”，而是用来搜索/定位。

---

## 20. 蛇形换行与“填满画布”（v6.5）

### 20.1 四种“更好看”的候选逐个评估

真实数据形状：**97% 的会话没有分支的长链**（entries 中位 110 / p90 1079 / p99 4682 / 最大 7176）。

| 提议 | 结论 | 理由 |
|---|---|---|
| **先横排再换行（蛇形）** | ✅ 采用 | 唯一能随规模伸缩的方式；换行处**天然相邻**，不需要弧线绕回 |
| 弧形 |  不需要 | 蛇形已经把绕回问题消解了（换行两侧同列）；剩下的边全是横或竖 |
| 圆形/径向 | ❌ 不做主力 | 径向适合浅而宽的树；我们是深链，会变成一圈圈螺旋，且卡片带角度不好读 |
| 树形 | ✅ 已有 | 分层布局就是树形；“竖排”即经典自上而下 |

### 20.2 蛇形（牛耕式）布局

`serpentineLayout(nodes, heightOf, columns)`：深度轴切成每行 `columns` 列，**奇数行反向**。

```
columns = 3，7 个节点：          n0 → n1 → n2
                                 ↓
                          n5 ← n4 ← n3          ← 换行两侧同列，边是短短的一条竖线
                                 ↓
                          n6
```

两个关键实现细节：

1. **行内局部 y = tidy 树的叶子 slot**，所以父节点仍在子节点中点，树形不被压坏。
2. **每个行带的高度取其最高列**（展开的折叠段 268px）。

### 20.3 目标函数换成“填充度”

旧的“适配缩放最大”无法区分“竖着一条细列”和“铺满画布”，所以改成 `canvasFill()`：

```
scale = min(MAX_FIT_ZOOM, 可用宽/内容宽, 可用高/内容高)
fill  = (内容宽 × scale) × (内容高 × scale) / 可用面积
```

被宽度限制时，`fill` 正比于 `内容高/内容宽` —— 即**奖励宽高比接近画布的布局**。`MAX_FIT_ZOOM = 1.6` 防止 3 个节点被吹成广告牌。

`layoutCandidates()` 一次性生成 横排 / 竖排 / 蛇形×2..12 共 14 个候选并打分，`pickBestLayout()` 取最高分（接近时保留靠前候选，避免拖窗口时翻来覆去）。

### 20.4 实测（会话 `01a0ae48`）

| 视图 | 容器 | 自动选择 | 填充度（前两名） | 绘制缩放 |
|---|---|---|---|---|
| 默认（7 节点） | 手机 390×700 | 竖排 | 竖排 91% · 蛇形×2 26% | k=1.20 |
| 默认（7 节点） | 桌面 1400×800 | **蛇形×3** | 蛇形×3 46% · 蛇形×2 40%（竖排仅 23%） | k=1.60 |
| 显示步骤（1662 节点） | 手机 | 蛇形×12 | 蛇形×12 72% · ×11 60% | k=0.06 |
| 显示步骤（1662 节点） | 桌面 | 蛇形×12 | 蛇形×12 18% · ×11 15% | k=0.07 |

即：**手机保持竖排（已填 91%），桌面把长链折成 3 列蛇形（从 6%/23% 提到 46%）**。

### 20.5 其他改动

- 工具栏四态循环：`自动（形状）` → `横排` → `竖排` → `蛇形×N`。
- 边的走线不再看布局方向，而是**看两个节点实际被分开的轴**（`|dx| >= |dy|` 走横，否则走竖），所以蛇形行内向右、奇数行向左、换行向下都自动正确。
- `fit()` 上限从 1.0 提升到 `MAX_FIT_ZOOM=1.6`，小图不再缩在中间一小块。
- 选形状的开销在 1662 节点上是 **34ms**，所以容器的测量值用 `useSettledSize` 滞后 150ms 才参与选形状（拖动窗口不再逐帧重算）；实际绘制仍然实时重适配。
- 删掉了只支持两个方向的 `chooseOrientation`（被 `pickBestLayout` 取代）。

---

## 21. 边的方向与图例（v6.6）

### 21.1 问题

边只是一条线，**看不出谁先谁后**，于是“节点之间的关系”无法读。

### 21.2 修正

| # | 内容 |
|---|---|
| 1 | 每条边加**箭头**（SVG `<marker>` + `markerEnd`），`orient="auto"` 跟随曲线切线方向；两个变体（accent / border-strong）让箭头颜色跟边一致 |
| 2 | `refX` 比 viewBox 宽 2 单位，所以箭头尖端**停在卡片外侧 2px**，不会被卡片填充盖住 |
| 3 | 静态边从 `opacity 0.45 / 1.5px` 提到 **`0.75 / 2px`**（之前太淡，箭头也看不见） |
| 4 | 节点卡片加 `data-node-id`（测试/调试可直接按 entry id 定位卡片） |
| 5 | 左下角图例重写，用**与图中一致的箭头小图**（而不是纯文字）：当前分支的下一步 / 其他分支的下一步 / 虚线 = fork 出的新会话 |

### 21.3 验证

新增 `frontend/src/test/sessionGraphEdges.test.tsx`（6 例，jsdom + @testing-library）：

- 两个 `marker` 存在且 `orient="auto"`；
- **每条边都有 `markerEnd`**；
- 当前分支用 accent 箭头、旁支用 muted 箭头；
- **箭头端点落在子卡片边界上、起点落在父卡片边界上**（直接读 DOM 里卡片 rect 的 x/y/宽/高 算到边界的距离，不依赖具体方向）；
- 蛇形换行的边是“同列向下”的竖箭头。

---

## 22. 卡片拖拽与分组标题遮挡（v6.7）

### 22.1 问题

1. 只能拖动**背景**平移画布、滚轮缩放，**单张卡片不能拖**。而自动布局不可能知道哪两条交叉边碍眼。
2. 多个会话时，后一个分组带的**标题被前一个会话的卡片盖住**（SVG 没有 z-index，而标题原来跟带子矩形同一层、在后面画）。

### 22.2 卡片拖拽

| 关键点 | 做法 |
|---|---|
| 拖动目标判定 | 在 SVG 的 `pointerdown` 上用 `closest('[data-node-id]')` 区分“拖卡片”与“拖画布”（背景才平移） |
| 坐标换算 | 存 `delta / view.k`，所以缩放状态下拖动手感一致 |
| 点击与拖拽区分 | 位移 < 4px 视为点击；真拖过就在 `suppressClickRef` 上打标，`onClick` 看到就吞掉（否则拖完会意外选中/打开会话）|
| 跟随 | 边、分组带、`适配`全部改用**合并后的 positions**（而不是自动布局坐标），所以拖完边就跟着走、`适配`也会把拖到画布外的卡片拉回来 |
| 复位 | 工具栏出现「重排」按钮（只在有卡片被拖过时显示）；切形状/换会话会自动清除 |

### 22.3 分组标题改到最上层

分组带拆成**两层**：矩形仍在卡片下面（不遮内容），标题最后绘制并加 `paint-order="stroke"` + `stroke=var(--bg)` 的**不透明描边光晕**，所以就算被另一个带的卡片叠到也读得清。

### 22.4 验证

新增 `frontend/src/test/sessionGraphDrag.test.tsx`（6 例）与 2 个标题层用例：

- 只移动被拖的那张卡片（其余不动）；
- **入边跟着移动后的卡片**（箭头端点落在新边界）；
- 分组带宽度随拖动增长（所以 `适配` 能拉回来）；
- 不位移的点击仍能选中；真拖过后**不再触发选中**；
- 「重排」只在拖过后出现，点击后位置回到自动布局且按钮消失；
- 标题在文档顺序上位于**最后一张卡片之后**，且带 `paint-order=stroke` 光晕。

> 测试踩坑记录：jsdom 没有 `PointerEvent`（用 MouseEvent 手动派发 `pointer*`），且原生 `dispatchEvent` **不走 `act()`** → React 不同步刷新 DOM，所以必须包 `act`；`setPointerCapture` 在 jsdom 不存在，调用处改成可选调用。

---

## 23. 修复步骤不可点 + 默认「骨架视图」（v6.8）

### 23.1 回归：步骤行点不动了

**根因**：拖拽实现里在 `pointerdown` 立刻 `setPointerCapture` 到 SVG，而**指针捕获会把后续 `click` 重定向到捕获元素**（Pointer Events 规范）。步骤行是卡片 `<g data-node-id>` 的子元素，于是它的 `onClick` 永远收不到事件。

**修法**：捕获改为**惰性**——`pointerdown` 不捕获，等拖动真正超过 4px 阀值、确定这是一次拖拽后再捕获（这样拖出画布也能继续跟手；而普通点击从未被捕获，click 正常落到步骤行/卡片上）。

防回归的判定性测试：把 `setPointerCapture` 换成 spy，断言 **press 时未被调用、越过阀值后才被调用**（jsdom 不实现指针捕获重定向，所以测的是契约而不是现象）。

### 23.2 默认改为「骨架视图」

原来的默认（关键节点）会把折叠段与 compaction 总结都画出来（你的会话 10 张卡片），但一个直链会话真正有信息量的只有“从哪开始 / 现在在哪”。

**规则**：保留**结构点**——树根、每个会话文件的首节点、分支点（`childCount ≥ 2`）、叶子（否则被放弃的分支会整个消失）、fork 锚点、当前点、人工标注；其余全部丢掉，**并把丢掉步数记到跳过去的边上**（`+N 步`）。

| 结构 | 关键节点 | 骨架 |
|---|---|---|
| 纯直链（5 个关键节点） | 5 | **2**（起点 → 当前，边上一枚 `+1287 步`）|
| 你当前会话 `01a0ae48`（2 个会话文件） | 10 | **4** + 2 枚标注（`+1673 步` / `+260 步`）|

**跨分支绝不凭空造边**：步数是沿着 DFS **路径**累加的，不是按会话序列拼的，所以两条分支的各端仍各自挂在自己父节点上（有测试钉住这一点）。

视图改为三态循环：`◈ 骨架` → `◈ 关键节点` → `◈ 全部步骤`；边上的 `+N 步` 标**可点**，点一下回到关键节点。

### 23.3 测试

`sessionGraphNodeView.test.ts`（13 例）+ `sessionGraphDrag.test.tsx` 新增 2 例（捕获契约 / 步骤行仍可选中）。

---

## 24. 界面细节修正（v6.9）

从真实截图里找到的三个缺陷：

| 缺陷 | 原因 | 修法 |
|---|---|---|
| `+N 步 · 展开` 镇住卡片与箭头 | 镇标固定 76×17 并放在边中点，而蛇形换行的行间距只有 **12px**、列间隙只有 76px | 镇标长宽**按文字算**（`+1673 步` → 62px）、批换成上；有镇标时把行间距提到 `GAP_Y_BADGED = 34`，让镇标有落脚空间且**不遮箭头** |
| 分组名与条数撞在一起（`…9cb71986条 · 运行中`）| 左侧名字固定截断 24 字，没看带子多宽 | 用 `estimateTextWidth`（宽字 10px / 窄字 6px）算出右侧条数占位，名字按**剩余宽度**截断（再留 8px 安全余量），并加 `<title>` 提示完整文件名 |
| 图例 6 行太占地方 | 每行都带一个图标说明 | 压到 **4 行**（两个箭头合一行；虚线框+分组带合一行；`+N 步` 与拖拽合一行） |

`· 展开` 字样从镇标里去掉（宽度吃紧），改成图例里说明“点 +N 步 展开中间步骤”。

### 24.1 测试

- **镇标尺寸**：`+1673 步` 的 pill 宽 < 76px（能落在列间隙里）。
- **行间距**：带镇标时两行卡片的 y 距离 ≥ 20px 变大。
- **不重叠不变量**：名字宽 + 条数宽 + 36px 内边距 ≤ 带子宽（并且窄带子的名字比宽带子短）。写这条时踩了个坑：`textContent` 会把 `<title>` 提示也算进去，所以只能取 **文本节点**。

---

## 25. 分叉到底做了什么（v7.0）

### 25.1 pi 的语义

`ExtensionCommandContext.fork` 的官方注释是 “Fork from a specific entry, **creating a new session file**”：

| 会 / 不会 | 说明 |
|---|---|
| ✅ 新建**会话文件**（新分支） | 事件 `session_start.reason = "fork"`，带 `previousSessionFile` |
| ✅ 复制本会话到该 entry 的**前缀** | 实测：子的 2117 条里**前 1675 条与父同 id 逐字相同**，之后开始分岔 |
| ✅ 同一个进程**切到**新会话 | Dashboard 里 `processInstanceId` 不变，`sessionFile` / `sessionId` 变 |
| ❌ **不新起 pi 进程** | 所以不会多出一个 live session |

### 25.2 图谱侧的行为

分叉后 pi **没有** post-fork 事件，所以桥在 `ctx.fork` 返回后主动 `markChanged() + sendSnapshot() + publish(session_tree)`。

前端旧行为：只把图谱 URL 的 `file` 换成新文件 + 一个 toast（停在图谱页，要自己点「打开会话」）。

新行为（`followSessionFile`）：

- 是**分叉**触发的换文件 → `navigate('/live-sessions/<pid>?node=<分叉 entry id>')`，即**直接进入新分支的 agent 页面并定位到分叉那一步**（`LiveSessionPage` 本就读 `?node=` 并显示「已定位到节点 X / 切到此处」）。
- 是**普通换会话**（终端 `/tree` + resume）→ 仍然只跟随文件，留在图谱页。

因为前缀同 id，`?node=` 在新会话里仍能匹配（上面实测的那个 1675 条就是证据）。
---

## 26. 一步 = 一轮对话（v7.1）

### 26.1 问题

截图里一个 15 条记录的会话被显示成 `+15 步`，展开后是：

```
1 Model → deepseek-v4.1-flash      ← 模型切换
2 Thinking → max                    ← 思考等级
3 User · hello
4 task-pilot-runtime · [task-pi…    ← 遥测
5 compact-thinking-duration         ← 遥测
6 compact-thinking-duration         ← 遥测
7 Assistant · 喵，你好！我在。当前工…
8 User · 我发现有时候在dashboard上打…
```

用户不关心 thinking 的内容，也不关心遥测与工具调用各占一行——真正的"步"应该是**一轮对话**（一问一答）。

### 26.2 做法：`turnSteps`

折叠段不再按 entry 计数，而是把记录归并成 **agent turn**：

| 规则 | 说明 |
|---|---|
| 一条 `user` 消息开启新一轮 | 该轮 = 这条提问 + agent 的全部工作（thinking / 工具调用 / 遥测 / 回复） |
| `compaction` 也断一轮 | 它是上下文重置，不属于正在进行的这一轮 |
| **首个请求之前的前奏并入该轮** | `Model → …` / `Thinking → …` 是那条提问的准备动作，不该单独成为一步 |
| 每轮带 `coveredCount` | 诚实记账：这一行是 1 轮，但可能含几十条记录（面板会说明） |
| 每轮带 `reply` | 面板分别显示「提问 / 回复」 |

于是 `collapsedCount` 的含义变为**轮数**，`collapsedRange` 仍是真实 entry 区间（覆盖性不丢）。单位的 UI 文案统一从「步」改为「**轮**」；`全部步骤` 也改名 `逐条记录`（那才是逐条 entry 的模式）。

### 26.3 实测（真实会话）

| 会话 | 逐条模式 | 折叠后 | 变化 |
|---|---|---|---|
| `01a0c312`（截图那个） | 303 条记录 | **1 段 / 2 轮** | `+15 步` → `+2 轮`，噪音行消失 |
| `01a0ae48`（本对话） | 2244 条记录 | 4 段 / **31 轮** | `+1673 步` → `+12 轮` |

`01a0c312` 展开后的两行：

```
1. User · hello                                  [7 条记录]   → 回复「喵，你好！我在。当前工作目录是…」
2. User · 我发现有时候在dashboard上切换session…   [294 条记录] → 回复「用现有 vitest 环境写一个临时测试…」
```

折叠段的预览也变成首尾两轮的实际提问（而不是 `User → Assistant` 这种空信息）。

### 26.4 顺带修掉的一个洞

步骤行原本**不能**填满右侧面板：面板只从顶层节点里查 `selectedId`，而 step 行是嵌套数据。现在面板也会查各折叠段的 `steps`，所以点一轮就能看到「提问 / 回复 / 含 N 条记录」，并直接对它「切到此处 / 从此分叉」。

### 26.5 测试

后端新增 `turnSteps` 4 例（合并 thinking/工具/遥测与回复、compaction 断轮、缺回复、无 user 时回退到 assistant 文本、前奏并入首轮），并更新 3 个既有用例到轮语义（其中 assistant-only 长链：8 条记录 = **1 轮**，区间仍覆盖 a2..a9）。
---

## 27. 「从此分叉」的实测结论（v7.2）

用户报告「在 graph 上点击从此分叉之后并没有创建新的 session」。用隔离 pi 会话逐层复现后，确认**是三个独立原因叠加**，不是分叉本身坏掉。

### 27.1 分叉一直会创建会话

pi 的 `ctx.fork(entryId, {position:'at'})` 每次都成功（实测：pi 屏幕 `Forked to new session`、`sessionFile` 切到新文件、新文件里保留分叉点之前的前缀、`parentSession` 指向父文件）。登记在 dashboard 侧也同步更新（`summary.sessionFile` + snapshot）。

### 27.2 原因一：前端在不可执行时静默 return

`runCommand` 原本 `if (!live || !treeCapable) return`。若该会话的 pi 进程加载的是**旧版扩展**（不声明 `session_tree`），点击等于没点、也没有任何提示。实测当时 17 个 live 进程中有 **6 个**是旧扩展；全量扫描所有会话文件，`role=user` 且文本为 `/ls-fork …` 的条目 **0 命中** —— 证明命令根本没离开浏览器。

修复：`graphWriteBlockReason` 给出每种状态的原因（含「请在该 Pi 会话执行 /reload」），图谱页顶部横幅同步显示；`tree_action` 事件把 pi 侧的真实结果回传（成功进 toast、拒绝进错误条）。

### 27.3 原因二：fork 后必须用 `withSession` 的 ctx

pi 会明确抛错：

> This extension ctx is stale after session replacement or reload. … For newSession, fork, and switchSession, move post-replacement work into withSession

旧代码在 fork 返回后仍用捕获的 `currentContext`（已 stale）读 `sessionFile`、发 `notify` → 抛错被吞 → 分叉结果谁也不知道（连终端提示都没有）。现在 fork 后的上报与快照都放进 `withSession` 回调，用回调传入的新 ctx。

### 27.4 原因三：pi 会「延迟」写新会话文件

`SessionManager.createBranchedSession` 的源码注释写得很清楚：

```
// Only write the file now if it contains an assistant message.
// Otherwise defer to _persist(), which creates the file on the first response
```

实测：fork 到**含 assistant 回复**的位置 → 文件立刻落盘（1→2 个文件）；fork 到**分支上还没有 assistant** 的位置（例如第一条 user 消息）→ pi 已切过去但**磁盘上没有文件**，直到新会话产出第一条回复才出现。dashboard 的图谱是按文件读的，所以那一瞬间看不到 → 又像「没创建」。

修复：扩展上报 `filePending`；前端跟随分叉时先探测文件，未落盘则显示「已分叉，正在等待文件落盘」并轮询（≤60s）后再跳转。

### 27.5 仍不稳定的一点（已知）

`tree_action` 在 **fork 场景**下偶尔投不到 dashboard：fork 会替换 runtime，live 连接短暂断开，`client.ready` 实测会在新会话开始后再次变 false；`/ls-navigate` 与「被拒绝」路径已实测可达（`eventSequence` 递增且事件出现在 dashboard 侧）。影响面：只少了那句「pi 侧结果」的文案（前端仍有乐观 toast 与等待落盘提示），**不影响创建会话与跟随**。下一步需要抓 fork 前后的 `session_shutdown`/`session_start`/`onDisconnected` 时序。

---

## 28. fork 分支配色，去掉分组大框（v7.3）

### 28.1 问题

同一张画布上，会话文件外面套了一圈半透明大圆角框（band）。框与框之间、框与卡片之间都在抢注意力，而真正要看的信息——**哪几张卡是同一条 fork 血统**——反而没有表达：两条从同一点分出去的支，画出来完全一样（灰色细线）。

### 28.2 修正

| # | 内容 |
|---|---|
| 1 | **删掉 band 矩形**：分组信息只由浮动**组标题**承担（会话 key + 条数），画布上不再有大色块 |
| 2 | **新增分支配色** `branchColorOf()`（`graph/layout.ts`，纯函数）：先序遍历，单链继承父色；遇到分叉（`childCount ≥ 2`）时，每个孩子拿一个**与父色、与兄弟都不同**的颜色槽 |
| 3 | 颜色落到三处：**边的描边 + 箭头**（`marker#ls-graph-arrow-<slot>`）、**卡片描边**（`strokeOpacity 0.55`，避免过重）、**`fork` 文字** |
| 4 | 调色板 = **`ok / warn / danger` 三色**，`accent` 与 `info` 都不进：蓝色在图上只保留一个含义（当前分支），且 `info` 在部分主题里与 `accent` 字面相同 |
| 5 | 图例重写：加粗蓝 = 当前分支；颜色 = fork 分支；虚线（带色）= fork 出的新会话；虚线框 = 已选中，顶部小字 = 同一会话文件 |
| 6 | 组标题组补 `data-session-group` / `data-band-width`，作为原 `rect[data-band]` 的测试锚点（band 宽就是组宽，不再需要画出来） |

**边界**：只有 3 个颜色槽，**同一分叉点的兄弟一定不同色**；一个分叉超过 3 个孩子（鸽笼原理）时颜色必然重复，不相关的两条支也会轮回到同一个颜色——所以颜色表达的是“分叉点之后各自一条线”，不是全局唯一 id。

**为什么是 3 色**（而不是 4 色）：用 `scripts/check-theme-cvd.mjs` 的同一套 Machado 模拟算过所有候选组合，`ok/warn/danger` 在全主题下最坏红/绿 ΔE = **11.3**（仓库阈值 <10 算塌陷）；换成 4 色（含 `info`）在 manuscript 主题降到 **9.0**，含 `accent` 的组合更是低到 0（accent 与 info 在 manuscript 完全同色）。

### 28.3 验证

- `sessionGraphLayout.test.ts` 新增 `branchColorOf` 5 例：单链同色、分叉兄弟互不同色且不同于父色、子分支继承后可在下游再分叉、6000 深链不爆栈、`parentId` 成环不挂死。- `sessionGraphEdges.test.tsx`：每个颜色槽一个 `marker`；非当前分支的两兄弟箭头 `marker-end` 不同；当前分支保持 accent。
- `sessionGraphDrag.test.tsx` / `sessionGraphEdges.test.tsx` 的 band 断言改读 `data-band-width`。

---

## 29. 分叉被折进同一列（v7.4）

### 29.1 现象

真实截图（4 个会话文件：235 / 462 / 420 / 370 条，trunk 在 HEAD 处分出 3 支）+ 真实数据复算：

`reduceToStructure` 后 8 个节点，**`serpentine×3`** 被选中（fill 0.69 > 竖排 0.45），于是

| 节点 | x | y |
|---|---|---|
| trunk `dfda8856` / `19ddeecd` | 0 / 288 | 72 / 72 |
| 462 支 `d9d730eb` / `6a38ba2a` | 576 / 576 | 0 / 216 |
| 420 支 `a11c4a20` / `c541cb74` | 576 / 576 | 72 / 288 |
| 370 支 `c4705f2a` / `d396e1ac` | 576 / 576 | 144 / 360 |

**三个分叉支的 6 张卡全部落在同一列 x=576**（y=0/72/144/216/288/360，与截图逐张对上），每条支的边变成一条竖线，穿过另外两支的卡片。"不同的路径混到一起" = 这里，与分组大框无关。

### 29.2 根因

蛇形折行只折**深度**轴，不认识分支：depth 2 与 depth 3 在 `width=3` 的翻转行里都映射到 column 2，于是各支同时出现在同一列；而 `canvasFill` 恰好**奖励**这种密度（0.69），所以自动布局主动选了它。

### 29.3 修正

| # | 内容 |
|---|---|
| 1 | `layout.ts` 新增 `laneOf()`（纯函数）：lane = 从「根」与「每个分叉的孩子」开始的一条线，单链继承（与 `branchColorOf` 同一套分组） |
| 2 | `LayoutCandidate` 新增 `cohesion`（0..1，默认 1）；`serpentineCohesion()` 统计「每个折行 band 里有几条 lane」，取 `1 / max`，横向/竖排恒为 1 |
| 3 | `pickBestLayout` 改用 `candidateScore = scale × cohesion`；`candidateScore` 单独导出以便测试 | 
| 4 | 效果：同一张图 `serpentine×3` 由 0.69 → 0.17，自动改为横排（1950×1050）/ 竖排（1680×900）：**每条 lane 一行/一列**，分叉点三条边分别向左下、正下、右下；单链长会话 cohesion=1，折行行为完全不变 |

### 29.4 验证

- `sessionGraphLayout.test.ts` 新增：`laneOf` 2 例；分叉图 `serpentine` 的 `cohesion < 1` 且 `pickBestLayout` 不选它；单链折行 `cohesion === 1`（不回归）；**核心不变量**：3 个分叉兄弟必须落在 3 条不同线上，且每条 lane 的后续节点仍在自己那条线上。
- 用真实数据（`/tmp/family.json`）复算 4 种画布尺寸：自动布局不再选蛇形，且没有边穿过其他分支的卡片。
