# 树形工作形态（Session Tree / Branching）可行性分析

**日期**：2026-09 · **范围**：pi-dashboard 是否/如何支持「以树方式工作，主干 + 任意点分叉 + 临时分支」
**结论先行**：**可行，且地基已经存在**。pi 内核本来就是树模型，dashboard 已有树视图与 fork。缺的是三件事：①「原地切分支（navigate）」未接入；②树只覆盖单个 session 内部，slot 之间没有血缘，侧栏仍是平铺列表；③分叉点被 UI 限制为「用户消息」。最大硬约束是 **pi RPC 没有 `navigate_tree` 命令**。

---

## 一、现状盘点（有据可查）

### 1.1 pi 内核：session 天生是树，无需改造

Session JSONL（`~/.pi/agent/sessions/`）在 v2 起就是树结构：每个 entry 有 `id` / `parentId`，会话有一个可变 `leaf` 指针（HEAD）。
证据：`docs/session-format.md`、`packages/coding-agent/src/core/session-manager.ts`。

内核 API（`dist/core/session-manager.d.ts`）：

| API | 语义 |
|---|---|
| `getTree()` / `getChildren(parentId)` / `getBranch(fromId)` | 读树 |
| `branch(branchFromId)` | **原地**移动 leaf，下次 append 成为该点的新子节点（同文件多分支） |
| `branchWithSummary(id, summary)` | 同上，但把被放弃的分支压成 `branch_summary` entry |
| `resetLeaf()` | 回到「空会话」，适合重编辑第一条 user 消息 |
| `createBranchedSession(leafId)` | 抽出 root→leaf 路径，写**新文件** |

`AgentSession.navigateTree(targetId, {summarize, customInstructions, label})`：**同文件**跳转到任意节点，可带分支摘要。`fork()` 则产生**新文件**。

pi 自带的两种"分叉"因此是清晰的两种语义：

- **`/tree` = navigate**：同一文件、移动 HEAD、分支并存、可选摘要 → 相当于 `git checkout` / `git switch`
- **`/fork`、`/clone` = fork**：新文件、保留原会话 → 相当于 `git branch` + 新 worktree
- 参考 `docs/sessions.md` 的 `/tree vs /fork vs /clone` 对照表。

### 1.2 传输层缺口：RPC 没有 navigate

pi 有两种被 dashboard 使用的通道：

- **RPC**（`pi --mode rpc`，默认/后台/并发场景）：命令集中有 `fork`、`clone`、`get_tree`、`get_fork_messages`、`get_entries`、`switch_session`，**没有 `navigate_tree` / `set_leaf`**。证据：`dist/modes/rpc/rpc-types.d.ts:95-140`、`rpc-client.js`。
- **SDK**（`PiSdkSession` 包 `AgentSessionRuntime`，前台场景）：`this.runtime.session.navigateTree(...)` **可直接调用**。
- 另外 `navigateTree` 也绑定在 **extension command context**（`rpc-mode.js` 的 `commandContextActions.navigateTree`），即 pi 扩展的斜杠命令能用，但 RPC 客户端不能。

**这是本次设计唯一真正的"卡点"**：原地切分支在 RPC 通道无法直接实现。

### 1.3 pi-dashboard 现状：有树视图，但没有"树"

- `frontend/src/pages/chat/SessionTree.tsx`：已有树视图。读 `GET /api/chat/slots/:key/tree`，前端 `buildTree`（按 `parentId`）、`activePath` 高亮当前分支、`isBranchPoint` 标分支点、filter（user/all）。**但唯一动作是 `handleFork`**。
- `POST /api/chat/slots/:key/fork`（`backend/routes/chat.ts:166`）：`pi.fork(entryId)` → 新建 `"Fork: …"` slot 采用新 sessionFile → **`pi.kill()` 杀掉旧 slot**。
  - 这个 kill 是 `docs/spikes/fork-semantics.md`（slice 6/7d）的**刻意 parity 决定**：`runtime.fork()` 会把旧 runtime 的 `session` **原地劫持**到新文件，若保留旧 slot 就会两个 writer 写同一文件 → 损坏。所以今天 fork 后**父 slot 不再存活**。
- `parseSessionTree`（`backend/session-store.ts:227`）：已能解析 `id/parentId/parent` 树、branchSummary、compaction、model_change 等。
- **没有**：in-place navigate 的端点/UI；slot 之间的 fork 血缘（新 slot 不知道 parent）；跨 slot 的树/森林侧栏。
- live-sessions（tmux 路径）把 `/tree`、`/fork` 标为 `kind: 'tui'`：web 端只给提示、不发送（`frontend/src/features/live-sessions/liveSessionCommands.ts`）。
- 另有 `session-diff.ts` + `DiffView`（文件 diff），但**没有** Claude/Cline 式文件快照 checkpoint。

### 1.4 pi 生态先例（已经有人做）

| 扩展 | 形态 | 可借鉴点 |
|---|---|---|
| `pi-session-tree-browser` | 本地浏览器树视图：侧栏显示 fork 树、右键 assistant 消息即可 fork、web composer 直接续写、删除/裁剪分支 | **和本需求几乎同构**；证明"浏览器 + 树 + 可续写"可落地 |
| `cad0p/pi-tree-navigator` | agent 可调用：自己 anchor 命名 milestone，把中间工作压成 `branch_summary` 释放 context | 「临时分支 / 上下文回收」的正确姿势 |
| `hintjen/pi-extensions` | `/snapshot <label>` 给当前树节点打标，便于 `/tree` 跳转 | 标签 = 给分支起名，成本极低 |

结论：**pi 的树能力已经被社区验证可用**，dashboard 的差距是"没把它接进 web 产品"。

---

## 二、竞品 / 先例调研

分两条线看，成熟产品基本各占一条：

### A. 会话树线（context 层）

- **Claude Code**：自动 checkpoint + `/rewind`（Esc Esc），可选恢复 code / conversation / both，支持 `--fork-session`；`summarize` vs `branch` 两种推进。**语义是 rewind（回退再分叉），不是可视化树。**
- **ChatGPT / Claude.ai / Gemini**：edit-and-resubmit 生成分支，但 UI 把树**藏起来**（左右翻页），用户感知不到树。
- **OpenHands**：正在做（issue #3750，分 3 期），直接复刻 **git 模型**：event 加 `parent_id` + 可移动 `leaf_event_id`，fork = 新 conversation with lineage，navigate = 同 conversation 移 HEAD。**与 pi 现有模型完全一致，是强旁证。**
- **LangGraph**：checkpointer + time travel，`replay`（重跑）与 `fork`（从 checkpoint 改 state 分叉）。
- **学术/开源**：Conversation Tree Architecture（arXiv 2603.21278）、AIbranch（SoftwareX）、KnowTree / baobab / branching-llm-engine（可视化节点图）、"Branch Agent: Git-style branching for LLM conversations"。

### B. 文件/工作区恢复线（artifact 层）

- **Cline**：每次改文件/跑命令存 checkpoint，可回滚**代码**而保留对话。
- **Cursor**：restore checkpoint 只回**文件**、不回消息。
- 这些是"另一个维度"，与会话树正交。

### 共性结论

1. 「树」分两层：**会话树（context）** 与 **文件/工作区树（artifact）**；现有产品几乎都只做一层，**没有把两层合成一个统一树 UI**——这是可以做差异化的点。
2. 语义统一收敛为两类：**navigate（原地、同文件、git checkout 式）** 与 **fork（新文件、git branch 式）**。pi 两者都原生具备，OpenHands 正在补齐同样的两个原语。
3. 「任意点分叉」是行业共识能力；pi 已支持（`createBranchedSession` 对任意 leafId 都成立，spike CASE 2 已在 assistant entry 上验证），dashboard 只是 UI 限制。

---

## 三、可行性分析

### 3.1 为什么"可行且便宜"

- **内核零改动**：树、`navigateTree`、`branch_summary`、`createBranchedSession` 全部现成。
- **解析层零改动**：`parseSessionTree` 已经输出 `{entries, leafId}`，`SessionTree.tsx` 已经能画树、能标分支点。
- **UI 骨架零改动**：侧栏 slot 列表、SessionTree 面板、composer 可直接复用。

### 3.2 真正的工作量（集中在 dashboard，三处）

1. **后端 navigate 端点**
   - SDK 通道：`PiSdkSession` 加 `navigateTree(targetId, opts)` → 直接转发 `this.runtime.session.navigateTree`。改动极小（~20 行）。
   - RPC 通道：无对应命令。三条路：
     - (a) 给 pi 上游提 PR 加 `navigate_tree` RPC 命令（rpc-mode 里已经绑了 `navigateTree` 给扩展，命令化是自然延伸，成本小、收益通用）；
     - (b) 让需要 navigate 的 slot 优先走 SDK 通道；
     - (c) 降级：RPC 槽的"切分支"用 fork（新文件）近似——语义不等价，只作兜底。
2. **slot 血缘元数据**：fork 时在 SlotState 记录 `parentSlotKey` / `parentEntryId` / `branchLabel`，把平铺 slot 列表升级为「森林」。当前 `createSlot` 无此字段，需加 schema（向后兼容：老数据 parent=null）。
3. **前端两处升级**
   - `SessionTree`：从"只读 + fork"加一个"切到此处（navigate）"，并放开 `canFork` 到任意 entry（现在写死 `role === 'user'`）。
   - 侧栏：平铺 → 树/森林，支持折叠、当前 HEAD 高亮、临时分支（scratch）标记。

### 3.3 风险与硬约束（真实、高影响）

| 风险 | 说明 | 处置 |
|---|---|---|
| **RPC 无 navigate** | 最大实现分叉点，决定架构 | 先决策：上游 PR / SDK-only / 降级。建议上游 PR |
| **多写者并发** | navigate 原地移 leaf，同一 session 若被 web 与 tmux live-session 同时消费会互踩 | 复用 live-sessions 的 lease/独占机制；navigate 前要求独占 |
| **fork 会 kill 旧 slot** | 今天 fork 后父 slot 不再存活；"同一父下多个分支并存"需要父留在原文件 | 需要从 `runtime.fork()` 切到 `createBranchedSession()`/`forkFrom()`（slice-6 spike 已指出这点），并解决"旧 slot 保留原文件"的写权 |
| **上下文/token 成本** | 分支不共享 KV cache，上下文线性增长 | 依赖 `branch_summary` + `/compact`；`pi-tree-navigator` 是可复用范式 |
| **与 worktree 脱节** | 真正"树形工作"常是「一分支 = 一个 git worktree」，live-sessions 已跑在 worktree 里但与会话分支无绑定 | 把 worktree 作为分支的 artifact 层，做绑定 |
| **范围蔓延** | 文件级 checkpoint（Claude/Cline 式）是另一条线 | 明确排除在本次范围外 |

### 3.4 「任意点分叉」的澄清

- 内核层面**已支持任意 entry 分叉**；dashboard 只是把 `canFork` 限制为 user 消息。
- 放开后，assistant / tool / compaction 节点都可作为分叉点（`pi-session-tree-browser` 已做 assistant 分支）。
- 「临时分支」= 带 `scratch` 标签的分支，配合生命周期回收（pi-tree-navigator 的 milestone + summary 模式），不需要新机制，只需命名与清理策略。

---

## 四、分期建议（MVP → 完整）

| Stage | 交付 | 依赖 | 成本 |
|---|---|---|---|
| **S0** | `SessionTree` 加「切到此处」（navigate）；SDK 通道先通，RPC 槽降级为 fork | 后端 navigate 端点 | ~1 天 |
| **S1** | slot 血缘字段 + 侧栏森林视图 + 分支标签/命名 | S0 | ~2–3 天 |
| **S2** | 放开任意点分叉；上游 `navigate_tree` RPC（或 dashboard 全切 SDK 通道）；多分支并存（不再 kill 父） | pi 上游 PR / 通道改造 | ~3–5 天 |
| **S3** | worktree 绑定（一分支 = 一 worktree）+ 临时分支生命周期 | S1 + live-sessions | ~3–5 天 |
| **S4** | agent 自 anchor（pi-tree-navigator 模式）+ 自动 branch_summary 释放上下文 | S2 | ~2–3 天 |

建议**先做 S0 + S1**：投入小、感知强，能把"树"从隐藏能力变成一等公民，且不触碰任何高风险改动。

---

## 五、推荐结论

- **建议做**。收益场景明确：研究型任务、多方案对比、临时试错分支——今天靠"多开 slot 手动管理"，树形化后变成原生的导航与对比。
- **不要一次做全**。先决策 RPC navigate 路线（默认建议：上游加 `navigate_tree` RPC 命令，因为 rpc-mode 已经为扩展绑定过 `navigateTree`，命令化成本低且对所有 RPC 客户端通用）。
- **差异化机会**：把**会话树**与 **worktree/artifact 树**绑定成一个统一视图——现有竞品（Claude / Cursor / Cline / OpenHands）都只做其中一层。
- **明确排除**：文件级快照 checkpoint（Claude/Cline 式）不在本需求内，避免范围蔓延。

---

## 附：直接证据索引

- pi 内核：`dist/core/session-manager.d.ts`（`branch`/`createBranchedSession`/`getTree`）、`dist/core/agent-session.d.ts:634`（`navigateTree`）
- pi 文档：`docs/sessions.md`（`/tree vs /fork vs /clone`）、`docs/session-format.md`（v1/v2/v3 树格式）、`docs/rpc.md`（命令集）
- pi RPC 缺口：`dist/modes/rpc/rpc-types.d.ts:95-140`（无 navigate）
- dashboard：`frontend/src/pages/chat/SessionTree.tsx`、`backend/routes/chat.ts:160-200`、`backend/session-store.ts:227`、`docs/spikes/fork-semantics.md`
- 生态：`pi-session-tree-browser`（pi.dev/packages）、`cad0p/pi-tree-navigator`、`hintjen/pi-extensions`
- 竞品：Claude Code checkpointing/rewind、OpenHands issue #3750、LangGraph time-travel、Cline/Cursor checkpoints