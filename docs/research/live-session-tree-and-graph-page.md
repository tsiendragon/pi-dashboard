# LiveSession 树化 + 树结构交互图页面：方案与开源借鉴

**日期**：2026-09 · **关联**：`docs/research/agent-tree-branching-feasibility.md`
**结论先行**：**可行且比 Chat Slot 更顺**。LiveSession 的完整会话树数据（`summary.sessionFile`）**已经下发**，切分支能力（`ctx.navigateTree()` / `ctx.fork()`）**就在 bridge 扩展进程内**。因此 LiveSession 树化几乎不需要改 pi、也不需要改 live-session 协议就能做出**只读树 + 图页面**；只有"原地切分支"需要给协议加两个命令。

---

## 一、LiveSession 现状盘点（关键事实）

### 1.1 运行模型

- dashboard **不拥有** pi 进程。pi 跑在 detached tmux（`pi-dash-live-*`）里，由 `pi-tsien-extension/extensions/live-session.ts` 这个 **bridge 扩展**注册到 dashboard broker。
- 通道：`hello`（注册）→ `snapshot` / `event`（上行）→ `command`（下行）→ `command_result`。
- 控制权：**claim + lease**（`leaseMs` 30s）。只有持有 lease 的浏览器能发命令（`slash`、`input`、`abort`、`compact`、`set_model`…）。
- 身份两层：`processInstanceId`（运行时，重启即换）与 `sessionId`（pi 会话，可跨重启）；UI 元数据按 `sessionId` 持久化。
- 文件位置：`<pi-tsien-extension repo>/extensions/live-session/`（`client.ts` / `projector.ts` / `protocol.ts` / `lease.ts`），主文件 `extensions/live-session.ts`（561 行）。

### 1.2 已经"免费"拿到的树能力（这是本方案成立的关键）

| 事实 | 位置 | 意义 |
|---|---|---|
| `LiveSessionSummary.sessionFile` 已下发 | `shared/src/live-sessions.ts:44`；bridge `live-session.ts:243` | dashboard 可直接用**现有** `parseSessionTree(sessionFile)` 读**完整树**（含废弃分支） |
| snapshot 的 entry 带 `id` + `parentId` | bridge `projector.ts:99-100` | 即使没有 sessionFile，也能从活动分支重建树 |
| **会话级血缘已存在**：`role: 'main'\|'subagent'` + `parentSessionId` + `parentToolCallId` + `subagentWorkId` | `shared/src/live-sessions.ts:39-43`；`registry.ts:60-88` | **会话之间已经是树**（main → subagent），侧栏可画"子代理森林" |
| `sessionChanged` 分支已处理 | `registry.ts:137-138` | fork/switch 后 sessionId 变化时自动清 lease + 广播，天然支持 |

### 1.3 唯一的缺口

- bridge 用 `getBranch()`（`live-session.ts:414`）→ snapshot **只含当前活动分支**，不含废弃分支。要完整树，走 `sessionFile`（见上）即可绕开。
- live-session 协议命令面（`protocol.ts:77-101`）**没有 navigate / fork**：
  `resync`、`claim`、`renew`、`release`、`input`、`abort`、`set_session_name`、`get_models`、`set_model`、`compact`、`reload`、`feature_command`、`answer_ui`。
- 但 **bridge 扩展进程内有 `ctx.navigateTree()` / `ctx.fork()` / `ctx.newSession()` / `ctx.switchSession()`**（`ExtensionCommandContext`，`pi-coding-agent/dist/core/extensions/types.d.ts:263-296`）。**补两个协议命令即可打通，不需要动 pi 上游。**

---

## 二、方案设计

三层，按耦合度从低到高：

### 2.1 数据层（dashboard 后端，**零协议改动**）

```
GET /api/live-sessions/:processInstanceId/tree
  → 读 summary.sessionFile
  → parseSessionTree(sessionFile)        // 复用 backend/session-store.ts:227
  → { entries: {id,parentId,type,role,text,timestamp,tools}[], leafId }
回退：sessionFile 缺失时，用 snapshot.entries 重建活动分支树
```
与 `GET /api/chat/slots/:key/tree` **输出同形状** → 前端可共用组件。

### 2.2 控制层（bridge 加 2 个协议命令，Stage L2）

```ts
// live-session/protocol.ts 新增
| { type: "navigate_tree"; leaseId: string; targetId: string; summarize?: boolean; customInstructions?: string }
| { type: "fork_from";     leaseId: string; entryId: string }
```
- handler 内调用 `ctx.navigateTree(targetId, {summarize, customInstructions})` / `ctx.fork(entryId)`。
- **两点必须处理**：
  1. 协议处理器当前拿的是 `currentContext: ExtensionContext`（`live-session.ts:133`）；`navigateTree/fork` 在 `ExtensionCommandContext` 上。需把命令能力暴露给协议处理器（捕获 command ctx，或直接接 `commandContextActions`）。
  2. **必须要求持有 lease**——navigate 会移动 HEAD，web 与 tmux 同时改会互相踩。
- `protocolVersion` 从 2 → 3，旧 bridge 未升级时 UI 隐藏切分支动作（降级为只读）。

### 2.3 展示层（前端）

**(a) 新增「Session Tree」图页面**（全局页面 + LiveSession 内嵌面板共用）

- 画布：**React Flow**，节点 = 消息 / 分支点 / branch_summary，边 = `parentId`。
- 布局：树形自动布局用 **dagre**（`@dagrejs/dagre`）或 **elkjs**；React Flow 官方有对应示例。
- 状态表达：
  - 当前 HEAD（活动叶）高亮；
  - 活动路径 vs 废弃分支用不同描边/透明度；
  - 分支点徽标；`branch_summary` 节点用不同形状；
  - subagent 子会话作为一个"折叠子树"挂在发起它的 tool call 节点上。
- 交互：
  - 单击节点 → 右侧预览该节点文本/工具；
  - 「切到此处」→ `navigate_tree`（L2）；
  - 「从此分叉」→ `fork_from`（L3，任意节点，不再限制 user 消息）；
  - 右键 → 打标签 / 重命名分支 / 折叠子树；
  - 双轴：水平 = 分支，垂直 = 时间；或遵循 git graph 习惯（左到右）。

**(b) 侧栏「森林」视图**

把平铺 live session 列表升级为两层森林：
- 第一层：**会话内分支**（来自 sessionFile 树）；
- 第二层：**会话间血缘**（`parentSessionId` → subagent 树）。
两者用同一 `parentId` 图模型，只是边的语义不同（branch vs spawn）。

### 2.4 与 Chat Slot 树的复用

| 层 | Chat Slot | LiveSession | 复用 |
|---|---|---|---|
| 数据形状 | `parseSessionTree` | 同 | ✅ 完全相同 |
| 读接口 | `/api/chat/slots/:key/tree` | 新增 `/api/live-sessions/:id/tree` | 结构相同 |
| 切分支 | SDK `session.navigateTree` | bridge `ctx.navigateTree` | 命令名可统一 |
| 前端组件 | `SessionTree.tsx`（列表） | 新图组件 | **图组件应做成两者共用** |

**这是最大的复用点**：一个 `<SessionTreeGraph>`，两个数据源。

---

## 三、开源工具借鉴清单

### 3.1 前端树图库（做"图页面"）

| 工具 | 许可 | 适配度 | 建议 |
|---|---|---|---|
| **React Flow（@xyflow/react）** | MIT | ★★★★★ React 原生、自定义节点、拖拽/缩放/minimap/多选，生态最大 | **首选** |
| dagre（`@dagrejs/dagre`） / **elkjs** / d3-hierarchy | MIT / EPL | React Flow 无内置布局，需其一做树形自动布局 | 配套（elkjs 更可控，dagre 更简单） |
| **Cytoscape.js** | MIT | ★★★ 网络图强，节点内嵌 React 内容弱 | 备选 |
| Reagraph / Reaflow | MIT | ★★ WebGL/3D，对会话树过重 | 不推荐 |
| **tldraw** | source-available（非纯 MIT，注意水印/商用条款） | 无限画布 + 自定义 shape | **只作交互参考，不作依赖** |
| react-arborist | MIT | ★★★★ 树**列表**（侧栏用），非图 | 侧栏备选 |
| mermaid | MIT | 静态图 | dashboard **已依赖**，但不适合交互树 |

### 3.2 有源码的产品/模板（照抄交互）

| 项目 | 借鉴点 |
|---|---|
| **`tldraw/branching-chat-template`** | 节点式聊天树 + 无限画布：消息是**可拖拽节点**，带输入框与连接端口，流式 AI 回写节点。**交互最接近本需求** |
| **`pangolinsec/baobab`** | 树形对话 UI，从任意回复分叉，root→leaf 上下文完整保留，纯前端 |
| **`ConfidentProgrammer/branching-llm-engine`（chat-tree-ai）** | 树 + 无限画布，任意深度 fork/branch/inspect |
| **`liuliu-dev/CommitGraph`（DoltHub）/ `GitGraph`（shadcn 版）** | **git DAG 交互相位**：因为 pi/OpenHands 都用 git 语义，"分叉点 / HEAD / 切换分支 / 折叠"可直接照搬；React + 无限滚动 |
| **`AIbranch`**（SoftwareX 论文，开源） | 可见对话树 + 每节点模型切换，研究级设计参考 |
| **Vercel AI Elements `conversation-tree`** | 组件级参考：节点类型（user/assistant/system/tool）、可展开分支、活动路径高亮、点击导航 |
| **pi `pi-session-tree-browser`** | 同类产品（浏览器树 + 右键 assistant 分叉 + web composer 续写 + 删除/裁剪分支），**架构与 LiveSession 模型最像** |

### 3.3 交互模式（横切参考，非库）

| 来源 | 交互 |
|---|---|
| **pi TUI `/tree`** | 键位规范：`Ctrl+←/→` 折叠并跳分支段、`Shift+L` 打标签、`Ctrl+O` 切过滤器（default/no-tools/user-only/labeled/all）。网页端可直接平移这套 |
| **Claude Code `/rewind`** | Esc Esc 唤出**列表式**回退选择器（比图更轻）；`summarize` vs `branch` 两种推进 |
| **LibreChat fork** | 任意消息点 fork，**选择携带多少历史** |
| **Cursor / Cline checkpoint** | 文件层恢复，与会话树正交（本方案不含，避免范围蔓延） |
| **OpenHands issue #3750** | 同款 git 模型设计文档（`parent_id` + 可变 `leaf_event_id`），可直接对齐接口命名 |

---

## 四、风险与约束

| 风险 | 说明 | 处置 |
|---|---|---|
| **多端并发改 HEAD** | web 与 tmux 同时 navigate 会互相踩 | **强制 lease**：无 lease 只读 |
| **fork 产生孤儿分支** | 新 sessionFile 存在但没有 live 进程 | 树里标"未运行"，支持"从此分支启动 live session"（需 launcher 支持按 sessionFile 恢复） |
| **协议版本兼容** | 新命令需 bump `protocolVersion` | 2→3，旧 bridge 自动降级只读 |
| **完整树体积** | 长会话 JSONL 可能很大 | `parseSessionTree` 已截断 text；图页面按需懒加载/折叠 |
| **上下文成本** | 分支不共享 KV cache | 沿用 `branch_summary` + `/compact` |
| **tldraw 许可** | 非纯 MIT | 仅借鉴交互，不引入依赖 |

---

## 五、分期建议

| Stage | 交付 | 依赖 | 成本 |
|---|---|---|---|
| **L0** | **只读树**：后端 `/tree` 端点 + React Flow 图页面（导航/预览/高亮 HEAD，无写操作） | 无（零协议改动） | ~2–3 天 |
| **L1** | 侧栏森林：会话内分支 + subagent 血缘两层树 | L0 | ~2 天 |
| **L2** | **原地切分支**：bridge 加 `navigate_tree` + lease 校验 + protocol v3 | bridge 改 ctx 能力 | ~2–3 天 |
| **L3** | 任意点 fork（`fork_from`）+ 孤儿分支「启动 live session」 | L2 + launcher | ~3 天 |
| **L4** | 分支标签/临时分支生命周期 + branch_summary 集成 | L2 | ~2 天 |

**建议先做 L0**：零协议改动、纯前端 + 一个读接口，就能得到一个可用的交互树图页面；确认交互手感后再做 L2 的写操作。

---

## 附：证据索引

- LiveSession 摘要/协议：`shared/src/live-sessions.ts:37-95`、`backend/live-sessions/registry.ts:34-160`、`backend/live-sessions/config.ts`、`backend/live-sessions/launcher.ts`
- bridge：`pi-tsien-extension/extensions/live-session.ts:225-268, 378-420`、`extensions/live-session/projector.ts:85-180`、`extensions/live-session/protocol.ts:77-101`
- pi 扩展能力：`pi-coding-agent/dist/core/extensions/types.d.ts:263-296`（`navigateTree`/`fork`/`newSession`/`switchSession`）
- 现有树解析：`backend/session-store.ts:227`（`parseSessionTree`）、`backend/routes/chat.ts:157-200`
- 前端现状：`frontend/src/pages/chat/SessionTree.tsx`、`frontend/src/features/live-sessions/*`、`frontend/package.json`（已含 mermaid/react-virtuoso，未含图库）