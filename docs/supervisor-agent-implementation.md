# 主 Agent 首版实施记录

## 当前状态

首版代码与针对性回归完成；尚未由 Agent 部署，也未做真实模型/浏览器联调。用户启动时报出的 `path is not defined` 已修复，并增加不启动服务器的实际导入/初始化表达式回归。用户已有改动均保留，未创建提交。记录增长后的查询优化（真实 `limit`、类型/时间过滤、轻量投影、报告复用）已出设计、**待实现**，见 [监督档案记录查询技术设计](supervisor-record-query-tech-design.md)。

## 后续：监督台任务聚焦

- 用户确认：首页优先显示在线会话正在开发的任务与 Dashboard 本地任务；其他任务默认隐藏但不缩小主 Agent 访问范围。
- 实现：复用现有 `sessionRefs` 和在线会话身份，显示关联的未完成、未归档开发任务与全部未归档本地任务，并补齐父级项目/Epic；主管会话自身不作为开发关联依据。其他任务按需展开/收起，收起时不渲染其列表，不改服务端权限、状态或任务数据。
- 验证：`bash-8587` 前端类型检查及 21 项监督回归通过；新增默认聚焦、父级保留、历史/完成/归档/主管自身关联隐藏、展开收起不写配置，以及无 Task Journal/会话时本地任务展示测试。此前观察状态和来源事实测试改为显式展开其他任务后检查。

## 后续：禁用/越权提示区分

- 用户截图中的“权限或授权范围不足”混淆了“监督未启用”和真正越权。现在 403 按错误码区分：`supervisor_disabled` → “监督服务未启用：请先在监督台启用观察模式，再启动主 Agent 会话。”；`use_primary_agent_entry`、`protected_supervisor_archive` 各自明确；仅其余才归为“权限或授权范围不足”。401 仍提示需要认证。
- 验证：`bash-3e1e` 监督回归 22 项通过，含错误码文案区分；前端类型检查（`bash-11fd`）通过；`git diff --check` 通过。
- 前端全量 `bash-1303`：982 项中 978 通过，4 项失败均为既定旧问题且与本次无关（`App.test.tsx` 仍断言源码中不存在的 `PI DASH`/`Health` 字样、`ToolSummary.test.tsx` 与 `ToolCallBlock.test.tsx` 断言值不匹配）；`App.tsx`、`ToolSummary.tsx`、`ToolCallBlock.tsx` 本身未被本次修改（前者仅改 logo 图片地址与 Provider 引入）。未修复这 4 项，也未改动其源码或测试。
- 本轮仅改页面及文档，未修改 Agent 资源或后端接口；未部署，用户自行 `./run.sh` 后验收真实会话关联与页面效果。

## 后续：无任务对象的一次性记录约定

- 用户提出的场景：面试、外部沟通等一次性事项没有对应任务，却希望主 Agent 记录并在年终按类别统计。
- 结论：现有模型不持久化“无对象事件”（事件按 objectRef 分组、范围过滤与来源快照都依赖它），但本地任务永远稳定可规划，因此用本地容器承接即可，不需新对象类型。
- 落地：主 Agent Skill 新增“无对应任务的快速记录”约定：查找/创建 tags 含 `personal-log` 的本地 Epic 容器（可按类别建子任务），事件直接挂容器或子任务；类型用固定词便于汇总；不把一次性事项挂到开发任务或只读来源；新建容器需用户明确要求，不静默新增。
- 已核对边界：`task_create` 在非通配授权下返回 `create_outside_scope`，所以缩小到具体任务清单的授权无法新建本地容器；需范围含 `local:*` 或 `*`。这不是新缺陷，是既有范围语义，已在回复中说明。
- 本次仅改 Agent Skill 与文档，未改后端接口；无新增自动回归。剩余未验证：真实会话里主 Agent 自动建容器并记录的实际效果待用户运行验收。

## 后续：事件类型词表与一次性记录约定（A+B）

- A（约定）：主 Agent Skill 新增“无对应任务的快速记录”完整模板：`personal-log` 本地容器 + 类别子任务、固定字段、生命周期用词、仅显式区间算时长、新建容器需用户确认、年末按 `type` 分组汇总。
- B（校验）：`shared/src/supervisor.ts` 新增 `SUPERVISOR_STANDARD_EVENT_TYPES`（progress/reply/blocked/resumed/decision/result）与 `SUPERVISOR_SYSTEM_EVENT_TYPES`（working_state/suggestion），`SupervisorConfig.eventTypes` 可选（归一化时总是填充）。`backend/supervisor/config.ts` 新增 `normalizeEventTypes`（去重、trim、小写标识符、≤32 个、禁止占用系统类型，空列表回退默认词表）；`backend/supervisor/service.ts` 在 `record`/`correct` 校验 `type`，写入词表外类别返回 `invalid_event_type` 并列出可选值，但事件自身类型未改变时仍允许更正（历史数据不会被锁死）；`backend/routes/supervisor.ts` 对显式传入的非法 `eventTypes` 返回 `invalid_event_types`；前端配置摘要、Extension 工具描述与 `guide/{config,dashboard}.md` 同步词表。
- 副产品修复：`protectSupervisorFiles` 的 realpath 失败处理原本会把普通文件读取变成 400（在替换 `fs/promises` 的环境里 realpath 不可用），现改为“缺失父目录递归解析、其余错误回退为已解析绝对路径”，不再改变正常读取状态码；`server-routes.test.js` 的 4 项 `/api/file-read` 回归恢复通过。
- 验证：`bash-4b25` 后端类型检查 + `docs:env-check` + 全量回归；新增 `supervisor-service` 词表测试（越权类别拒绝、系统类型放行、自定义词表生效、历史类型仍可更正）与 `supervisor-runtime` 归一化测试。前端 `bash-b8b6` 监督 22 项通过；Extension `bash-e685` 除既有无关失败外 239 项通过。
- 已知无关失败（未修、非本次改动）：`backend/__tests__/live-session.test.js` 的 session-tree 缺参数期望 400 实得 404（用户进行中的 `backend/routes/live-sessions.ts` 改动将 `session_file_unavailable` 映射为 404）；`backend/__tests__/pi-env.test.js` 的 `getRecentSessions` 在全量并行下偶发 5s 超时（单独运行 10 项通过，属环境相关抖动）；`pi-tsien-extension` 的 `conversation-workbench.test.ts` 期望 `Enter send/queue` 文案。
- 未验证：真实会话中主 Agent 自动建容器/拒错类别的实际表现，待用户运行验收。

## 修复：启动会话被错绑到同目录的其他会话（主 Agent 身份错乱）

- 现象：用户问“现在的主 Agent 是哪一个，怎么匹配到了 `01a1159d…`”。`runtime.json` 记的 sessionId 是一个旧开发会话（「将 Live Session 改成按活动分组的时间线」，Oct 7，10.8MB），而今天 15:18 由 dashboard 真正启动的主会话是另一个（`01a11b90…`，title `主 Agent · 工作监督`）。
- 根因（`backend/live-sessions/launcher.ts` `awaitRegistration`）：匹配规则是“新出现且同 cwd 的会话里优先按 pane pid 找，找不到就退回**最新的那一个**”。主 Agent 与用户的开发会话都在 `repos/pi-dashboard` 目录下，启动等待期间那个旧会话重新注册（拿到新的 processInstanceId，因此不在 `before` 集合里），而真正的 pane 还没注册 → 退回分支把它当成了刚启动的会话，于是 `runtime.json` 的 sessionId/processInstanceId/sessionFile 全被写成对方的，监督台随后会把用户消息发给错误的会话。
- 修复：`panePid` 已知时**只接受 pid 完全匹配**，不再退回“同 cwd 最新”；只有 tmux 探不到 pane pid 时才保留旧退回逻辑。证据支持该不变量：抽查注册表与 tmux，`bridge 上报的 pid == tmux pane_pid` 在多个会话上完全一致。
- 新增用例：同 cwd 下先出现一个 pid 不同的“诱饵”会话、真正的 pane 稍后注册 → 必须绑定到真正的 pane，且不杀 tmux 会话。
- 数据修复：把 `~/.pi/dashboard/supervisor/runtime.json` 里被写错的 sessionId/processInstanceId/pid/sessionFile 改回真实主会话（改前备份 `runtime.json.bak-20261013-152918`）。
- 待定/未做：是否再加一层“启动后校验返回会话标题等于请求标题”的防御（本轮只修根因，避免过度耦合）。
- 追加（用户提议“特殊 tmux 命名 + 去掉 fallback”）：
  - 主会话现在用独立命名 `pi-dash-supervisor-<8位>`（`LivePiStartOptions.tmuxPrefix`，非法前缀回退 `live`），`tmux ls` 里一眼可辨。
  - 说明：**命名本身不能用于匹配**——面板的 hello 只带 processInstanceId/pid/cwd/mode/sessionId，broker 不知道 tmux 名字。要让名字/标签参与匹配，必须让面板上报它（需同时改扩展 bridge）。
  - 已删除“pid 已知时退回同 cwd 最新”的分支；pid **探不到**时的退回也收紧为“必须是在本次启动之后才启动的会话”（`startedAt >= 启动时刻`，时钟可注入便于测试），从而排除“早已存在、只是重新注册”的邻居。
  - 若要**彻底删除一切退回**：需先给面板加唯一启动标签（env + bridge 上报 + summary 字段），否则 tmux 探测异常时启动会硬失败（超时并杀面板）。该方案列为待用户决定的后续项，本轮未做。


## 修复：主会话被记录“钉死”在错误的会话文件上（关掉又续上）

- 现象：用户反馈“还是 `pi-dash-live-e03d8d90`，一直作为主 Agent，我关掉了它还是会重启这个 session”。重启后核查：面板本身已是 `pi-dash-supervisor-810f611f`（pid 3439 == 注册表上报的 pid，说明**匹配逻辑已正确**），但它的启动命令里带 `--session …/2026-10-07T09-06-45-025Z_01a1159d….jsonl`——即真正的问题在**记录里的会话文件是错的**。
- 机制：`runtime.json` 的 `sessionFile` 既是“续接哪个对话”的输入，又会被写成“匹配到的会话的文件”。一旦某次旧代码的错绑把错误的文件写进去，之后每次启动都 `--session` 续接那个别人的对话，续接出来的会话 id 又恰好等于记录，于是**自洽地错下去**，单纯关掉面板无法解除（点启动又续上同一个文件）。
- 修复：
  - 记录清理：`runtime.json` 被写错的 sessionId/processInstanceId/pid/sessionFile 全部清空（`{"loaded": false}`，改前备份 `runtime.json.bak-20261013-180147`），并把仍在运行的那个错绑面板 `pi-dash-supervisor-810f611f` 关掉。下次启动不带 `--session`，全新会话；被误用的那个开发会话文件本身不受影响。
  - 根治“必须重启整个服务才能清绑定”：`SupervisorRuntime` 新增 `reloadRecord()`，`boot()` 与**每次 `startOnce()`** 都重新读 `runtime.json`，所以在外面清理绑定后直接点启动即可生效（新增用例覆盖：清空 `sessionFile` 后启动不再续接旧文件）。
- 运维结论（写进排查手册口吻）：`runtime.json` 是主会话的绑定凭据；清空它并点启动 = 让主 Agent 换一个全新对话，不需要重启 dashboard，也不需要动任何真实会话文件。

## 设计草案：竖轴时间线（mock）

- 用户诉求：时间线做成**一根竖轴**，轴上每个点是一个日期，点右边是该事件的简介；点开看完整记录（含图片）。Task 页面打开后**优先显示时间线**。
- 交付：`docs/mockups/timeline-redesign.html`（自包含，无外部依赖；顶部两个视图切换，`#task` 直达 Task 视图）。
- 结构要点：左侧日期列 + 竖轴（日期一个节点，事件一个小点，按 `type` 上色）；卡片头内是时间 + 标题 + 类型徽标 + 两行简介 + 元信息/缩略图；展开后为现有卡片内容（发生/记录时间、参与人、记录人、来源、来源会话、描述、原始回复、下一步、修订历史、事件 id）。
- Task 视图：任务头（标题/UID/provider/状态/父级）→ **时间线（默认展开，含子对象开关与类型筛选）** → 任务信息 / 任务描述 / 待办与建议（默认折叠）。
- 待用户确认的取舍：时间位置（卡片头内 vs 轴旁独立列）、Task 页是否保留其它 tab、默认展开最近一条还是全部折叠、图片缩略图尺寸与张数上限、是否需要按天折叠/虚拟滚动。
- 实施（用户确认 mock 后）：新增 `frontend/src/features/supervisor/EventTimeline.tsx`（共用时间线组件：按天分组、竖轴、可折叠日期、单条展开/收起、类型色点与徽标、摘要一行、缩略图/附件、`groupByDay`/`dayKeyOf`/`clockOf`/`plainSummary` 导出便于测试）；`EventLedgerPage` 用它替换原来的平铺 `<ol>` 列表，并加类型筛选、只看有图片、新→旧切换；`TaskDrawer` 在最上方新增「时间线」区块（compact、`key=task.uid`、`intervalMs=0` 只读一次，未认证或失败时给出说明与流水账链接）。
  - 默认值：展开最新一条；记录 > 12 条时只展开最新一天（可用「展开全部日期/收起全部日期」改）；缺 `occurredAt` 时轴上时间标为「记 HH:MM」，避免被读成发生时间；两侧都缺失才进「时间未知」节点。
  - 测试：新增 `frontend/src/test/eventTimeline.test.tsx`（8 项：分组/摘要/时间标注/默认展开/日期折叠/阈值折叠/空态/无障碍状态）；`supervisor.test.tsx` 增「任务抽屉时间线优先」并按新交互更新两处断言（标题现在是展开按钮而不是 heading）。前端全量 1052 通过 / 4 项既有失败（App、ToolCallBlock、ToolSummary，与本次无关）；前端 typecheck 与 ESLint 通过。
  - 未做（下一步可选）：按天虚拟滚动/只加载最近 N 天（当前一次加载对象全部事件）、时间线导出。
- 生效：前端为静态托管，需要重新构建才会看到（构建与重启仍由用户执行）。

## 变更：事件流水账并入 Tasks 之下（用户要求）

- 需求：把 `/events` 与任务页面合并，流水账作为任务的下一级。
- 实现：路由 `/tasks/events` 为正名（声明在 `/tasks/:uid` 之前，避免被当成 UID），旧 `/events` 走 `EventsRedirect` 带上 `search` 跳过去（任务功能关闭时退回 `/chat`）；两个页面共用 `TasksSectionTabs`（任务清单 / 事件流水账）切换；任务详情与监督台里的链接改指 `/tasks/events?...`。
- 用户复查后追加：**侧边栏不放这一项**（缩进一层也被认定为"还挂在左栏"）。因此 `NAV_ITEMS` 里没有流水账条目、`parent` 机制一并撤掉；入口只在 Tasks 页顶部页签与任务详情页的链接（监督台按对象链接、深链仍可用）。`isNavActive` 保持 `/tasks/events` 不点亮 Tasks。
- 测试：新增 `frontend/src/test/tasksSection.test.tsx`（子级路由、旧链接带参数跳转、流水账路径不被当作任务、`/tasks/:uid` 仍正常、导航只有一处并以 `data-child="tasks"` 标记）；`supervisor.test.tsx` 链接断言同步。
- 版式自检：用真实导航渲染 + 现有样式截图核对缩进层级（临时预览文件已删除）。
- 改动文件：`frontend/src/App.tsx`、`frontend/src/pages/tasks/TasksSectionTabs.tsx`（新）、`frontend/src/pages/TasksPage.tsx`、`frontend/src/pages/EventLedgerPage.tsx`、`frontend/src/pages/tasks/TaskDetail.tsx`、`frontend/src/pages/SupervisorPage.tsx`、`frontend/src/test/tasksSection.test.tsx`、`frontend/src/test/supervisor.test.tsx`、本文件与 `guide/dashboard.md`。

## 变更：写入确认改成“页面常驻卡片 + 侧栏角标”（用户要求 A）

- 背景：弹窗在高参数下会被挤出屏幕；且确认弹窗完全盖住页面，看不到“到底是给哪个任务写什么”。用户选了 A：卡片常驻在对应页面 + 侧栏角标 + 弹窗降为小而矮的兜底。
- 扩展（`../pi-tsien-extension/extensions/supervisor/index.ts`）：确认请求的 message 末尾追加一行机器可读标记 `[supervisor-confirm]{op,ref,sum}`（pi 的 UI 请求只有文本字段，目标对象只能随文本传）；dashboard 在展示前剔除这行。
- 前端数据层：`frontend/src/features/supervisor/pendingConfirmation.ts` 解析标记、按 `objectRef` 过滤出待确认项；无法解析的请求继续由弹窗举。
- 前端展示：
  - `PendingConfirmations`：任务详情页与事件流水账页在顶部常驻显示“等你确认：…”，带「不允许 / 允许这次操作」，答完即消失；
  - `PendingConfirmationBadge`：侧栏常驻“N 项待确认”，点开小列表可原地处理或跳到对应流水账；
  - `LiveSessionExtensionUiModal`：只负责没有目标对象的请求，改为右下角小卡片（无全屏遮罩、无 aria-modal），不再遮挡页面。
- 订阅收敛：新增 `LiveSessionsRuntimeProvider`，live-session WebSocket 在 App 根只挂一份（以前跟页面/主管弹窗挂，导致换页面收不到确认，且可能双连接）；`LiveSessionPage`/`Gallery`/`Graph` 改用 `useLiveSessionsRefresh()`，`SupervisorAgentProvider` 删除 `LiveBridge`。
- 测试：新增 `pendingConfirmation.test.ts`（4 项：标记拆分、无标记回退、按目标过滤、坏标记不丢正文）与 `pendingConfirmations.test.tsx`（5 项：页面卡片渲染、其他对象不渲染、允许/不允许走 `answer_ui`、角标计数与空态）；前端全量 1293 通过 / 5 项既有失败（App×2、ModelLeaderboard、ToolSummary、LiveSessionsList 分组，均与本次无关，已用还原改动复测确认），typecheck 通过；扩展 25/25。
- 生效：前端需用户重新构建（`./run.sh`）；扩展需重新加载后重启主会话。
- 未验证：真实浏览器视觉与真实主 Agent 端到端未实测；标记行在 pi TUI（非 dashboard）里会显示为一行 JSON。

## 修复：回「确认」也写不进去（用户反馈，第二次）

- 现象：主 Agent 记录 EuFakeID 事件（含截图）连续失败三次，回执都是「确认窗口被关掉或选择了不允许」；用户按要求在对话里回了「确认」，仍然失败。
- 证据（主会话 `2026-10-16T09-27-44…jsonl`）：三次 `event_append` 分别耗时 25.1s / 6.0s / 5.4s；第三次是用户 16:12:57 回复「确认」后 16:13:07 重发、16:13:12 失败；三次 `objectRef`/`type` 相同，`description` 文本被模型重述过。
- 根因：对话内确认的凭据按「操作 + 完整参数哈希」匹配。模型重发时把 `description` 改了措辞 → 哈希变化 → 上一句「确认」不再算数 → 又弹窗 → 弹窗应答失败 → 回执「未通过」。用户看到的确认内容也被换成了模型的新版本。
- 修复（`../pi-tsien-extension/extensions/supervisor/index.ts`）：
  - 确认凭据改为绑定「操作 + 目标」（`confirmationTarget`：`objectRef`/`uid`/`id`/`path`/`type`，`task_create` 另加标题），不再对自由文本做哈希；
  - 待确认请求保留**用户当时看到的那份参数**，一句「确认」后执行的就是这份原内容，模型重述的新文本不会顶替；
  - 一次确认只授权一次写入，换目标/换操作/整句含别的诉求仍要重新询问。
- 测试：扩展 237 项通过（新增「重述文本后一句确认仍生效，且执行的是原内容」「一次确认只授权一次写入」）。
- 前端（同一症状的另一半）：`ExtensionUiModal`、`LiveSessionExtensionUiModal`、`ToolApprovalModal`、扩展写入确认框都加了「最高 90dvh + 正文内部滚动 + 按钮常驻」，长参数不再把按钮挤出屏幕。
- 生效：扩展与前端都需用户重新构建并重启（前端 `./run.sh`），主 Agent 需「清空并重新加载」或结束旧主会话后重启才会加载新扩展代码。
- 已知风险（未改）：确认弹窗依赖 live-session 运行时订阅，而该订阅目前由「主 Agent 弹窗可见」或「打开 Live Session 相关页面」触发；用户停在其他页面时，弹窗可能不出现（不点也不会自动拒绝，但用户会以为没反应）。是否改成全局常驻订阅需先治理重复连接，待用户决定。

## 修复：写入确认「总是被取消」（用户反馈）

- 现象：`supervisor_task_update`（把任务标成完成）连续三次返回「操作被取消」，用户从未点过取消。
- 排查证据：
  - 会话记录里三次调用分别在 1.4 / 1.7 / 1.5 秒内返回「取消」——不是 60 秒超时，也不是用户思考后拒绝；
  - 在隔离 tmux 面板里用探针扩展复现 `ctx.ui.confirm`：空闲会话与回合进行中**都不会自己消失**，也没有工具信号中止（等 17 秒仍在等待）→ 排除「pi 自动取消」；
  - 桥接与注册表（`pi-tsien-live-session`、`backend/live-sessions/registry.ts`）只在收到 `answer_ui` 命令时才应答，没有自动取消路径；
  - 前端 `LiveSessionExtensionUiModal` 是**全屏浮层**，且遮罩层 `onClick={cancel}`——用户当时正在主 Agent 弹窗里点击/输入，浮层一出现，任何一次点击都落在遮罩上，被当成「不允许」。
- 修复：
  - 前端遮罩不再响应点击（只能显式点「允许这次操作 / 不允许」），并加一句「需要你回答，否则这项操作不会执行」；
  - 扩展错误文案不再写「用户取消」，改为「主 Agent 操作确认未通过（确认窗口被关掉或选择了不允许），本次没有做任何修改」；
  - 新增**对话内确认**：用户被问过之后直接回一句「确认」（同意/允许/可以/好/是 等短句，整句仅此一词且 ≤12 字），扩展即按授权处理，无需弹窗；只认「刚刚问过的那一件操作」（按操作名 + 参数哈希匹配，含 session 内轮次判定），换目标/换操作/整句包含别的诉求都会重新询问；用户回「不要 / 取消」会作废这条待确认。
- 测试：扩展 23 项通过（新增「对话里回确认即授权同一条请求，且真正带 confirmed:true 发往网关」「确认词不能授权不同目标、模糊语句或已被拒绝的请求」）。
- 改动文件：`../pi-tsien-extension/extensions/supervisor/index.ts`、`../pi-tsien-extension/test/supervisor.test.ts`、`frontend/src/features/live-sessions/LiveSessionExtensionUiModal.tsx`、本文件与 `guide/dashboard.md`、SKILL。
- 未做：主 Agent 弹窗单独的「待确认」角标（弹窗 + 对话内确认已覆盖）；真实浏览器验收待用户执行。

## 变更：任务详情页化 + 粘贴截图自动存档（用户反馈）

- 反馈一：点开任务时是右侧抽屉，不够友好；希望点开任务默认就是事件流水账。
  - 改法：`TaskDrawer` → `TaskDetail`（页面），去掉遮罩与右侧 aside；`TasksPage` 在选中任务时**整页渲染详情**（列表让位），顶部只有标题与「← 返回任务列表」。顺序：关于头 → 时间线（默认展开、非 compact、隐藏自身对象链接）→ 监督提示 → 内容 → 任务信息 → 关联会话 → 规划。预览用真实组件渲染截图核对过版式（临时预览文件已删除）。
- 反馈二：事件流水账里看不到自己的截图。
  - 证据：`archive.json` 里该对象两条事件的 `attachmentIds` 都是空数组；`attachments/` 只有 1 个孤儿附件。主会话记录里用户的原始消息也没有 `用户提交的已保存截图 attachmentIds：[…]`（弹窗上传才会带）——即截图是在**面板里直接粘贴**的：模型能看到图，但当时没有任何已存档 id 可引用。
  - 根因修复：pi 的 `before_agent_start` 事件带 `event.images`，扩展现在据此把本轮粘贴的图片通过新的 `attachment_put` 操作存档（`store.uploadImage` 负责魔数/MIME/名称/大小校验），并把 id 作为本轮注入提示交给主 Agent，要求写进 `attachmentIds`。仅用户轮允许（自动巡查轮 403）；弹窗自己上传过的消息不重复存档；单轮最多 4 张，失败只提示不打断回合。
  - 历史缺口：已存在的两条记录仍无图，需要用户把截图重新粘一次并说明补到哪条记录（主 Agent 用 `event_correct` 追加 `attachmentIds`，会弹一次确认）。
  - 测试：后端网关/集成（`attachment_put` 需用户轮、真实图片可存档并被记录引用与读回、非图片被拒）；扩展（粘贴截图存档一次、注入提示含 id、巡查轮与弹窗已上传的消息不重复存档）。
- 改动文件：`frontend/src/pages/tasks/TaskDetail.tsx`（原 TaskDrawer）、`frontend/src/pages/TasksPage.tsx`、`frontend/src/features/supervisor/EventTimeline.tsx`（`hideObject`）、`backend/supervisor/{service,runtime}.ts`、`shared/src/supervisor.ts`、`../pi-tsien-extension/extensions/supervisor/index.ts`、两处测试、本文件与 guide。

## 明确“记录写到哪里”：事件流水，而不是任务描述或任务目录

- 用户提问：主 Agent 知不知道记录该落在时间流水，而不是任务目录或任务描述里。
- 机制事实（已核对代码）：
  - 主会话只加载 15 个监督工具（`backend/supervisor/config.ts` 的 `supervisorTools`），**没有任何文件/命令工具**；`supervisor_inspect` 只读批准文件。所以它没有能力写任务目录或仓库文件。
  - `task_update` 对只读来源直接拒绝：`backend/supervisor/service.ts` 的 `read_only_source`（Task Journal / Jira / Lark 必须走 Task Pilot）。
  - 记录类写入只有 `event_append`（store 的 events 即事件流水账，与 Task 页面共享 UID 时间线）；`record` 不允许写 `working_state` 类型。
- 本轮补充（让模型更容易做对）：SKILL 增加三条明确规则（记录 = 事件流水；只读来源与无文件工具；`supervisor_task_update` 只改可写本地任务的标题/描述/状态且属用户可见变更）；扩展里 `event_append` 与 `supervisor_task_update` 的工具描述同步写明。
- 生效：SKILL 属门禁资源（修改后 `resourceState` 变 pending），工具描述随扩展加载，都需要结束旧主会话并重新启动。

## 变更：写入授权改为“按回合来源”判定（去掉用户可见标记）

- 用户诉求：主 Agent 应当能直接记录，不要特殊的授权标记。
- 问题：旧规则要求写操作挂在本轮用户轮上，而唯一凭据是 Dashboard 弹窗注入的 `[supervisor-user-grant:…]` 标记。用户在会话页/面板里直接说的话没有标记，被当成自动巡查，所有写入 403（实例：主 Agent 想记录 `local:t-383e4c55` 被拒）。
- 新规则：**自动巡查轮**由 Dashboard 在提示前加机器标签 `[supervisor-auto-patrol]`（`SupervisorRuntime.patrol`）；扩展据标签把该轮标为 `userTurn: false`，其余提示一律视为真实用户轮并随请求带 `userTurn: true`（`AUTO_PATROL_TAG`）；后端 `/execute` 用 `payload.userTurn` 放行写入（`userInitiated`）。用户可见的授权标记不再需要；弹窗消息仍带 grantRef，仅用于把用户原话写成事件审计引用（`messageRef`）。模型无法伪造该字段：payload 由扩展构造，模型参数被清洗。
- 保留的安全边界：用户轮会把自己的原话（`userPrompt`，截断 4000 字符）随请求发给网关，网关仍用 `userOperations` 解析**本轮要做什么**：
  「帮我把这个记录到对应任务的记录里 …」「帮我记一下 …」现在都能直接授权 record（解析前会剥掉弹窗信封 `[supervisor-user-grant:…]`、上下文行与附件行）；
  而「不要创建任务」这类否定/提问仍然得不到授权，会退化为针对该动作的一次 UI 确认，而不是直接放行。
  自动巡查轮（带标签）一律拒绝写入；`task_update done`、破坏性 `correct`、`action done` 仍需具体操作的 UI 确认。`source.kind` 仍然区分 `user`/`agent`。
- 改动文件（本次）：`backend/supervisor/runtime.ts`、`backend/__tests__/supervisor-runtime.test.ts`、`backend/__tests__/supervisor-integration.test.ts`、`../pi-tsien-extension/extensions/supervisor/index.ts`、`../pi-tsien-extension/test/supervisor.test.ts`、`guide/config.md`、本文件与扩展文档。
- 测试：扩展 `test/supervisor.test.ts` 20 项（新增“无标签提示即用户轮 + 原话随请求发送”，巡查夹具改用标签）；后端监督 5 个文件 48 项（新增 `userTurn: true` 放行、`userPrompt` 否定护栏、真实措辞授权、`userTurn: false` 拒绝、巡查提示带标签）。两仓库 typecheck 通过。
- 生效条件：后端与主会话都要重启（扩展代码在会话启动时加载）。

## 修复：僵尸进程导致“旧主会话仍在运行”误判，无法启动

- 现象：用户重启服务后，弹窗显示 `pending · 未连接` 且提示“点启动会按新资源启动”，但一点启动就报“原主会话进程仍在运行，请先恢复连接或由用户结束旧主会话，不启动竞争实例。”
- 根因（真实数据）：`~/.pi/dashboard/supervisor/runtime.json` 里记着上次主会话的 `pid: 3625685`。该进程早已退出，但父进程是 tmux server（`tmux new`，pid 539125），没人回收，于是它变成僵尸态 `Zs [pi] <defunct>`。旧判定只用 `process.kill(pid, 0)`，而僵尸仍然占着 pid、信号可发送成功 → 被当成“仍在运行”。与此同时注册表里没有该会话（未连接），于是“启动被权重检查拦住、又没有任何会话可恢复”的死锁。
- 修复（`backend/supervisor/runtime.ts`）：新增导出函数 `processAlive(pid, procRoot='/proc')`：读 `/proc/<pid>/stat` 第三列取进程状态，`Z`/`X` 视为已结束；再读 `/proc/<pid>/cmdline`，若已不是 pi（pid 被复用）也视为已结束；`ENOENT` 视为已结束；只有确实是活着的 pi 进程才拦住启动。`startOnce` 改用它。
- 真实环境验证：对真实僵尸 pid 3625685 返回 `false`（修复前会被拦），对当前进程返回 `true`（真正在跑的会话仍拦住竞争启动），对不存在的 pid 返回 `false`。新增用例用假 `/proc` 目录覆盖四种情况。后端监督测试 5 个文件 46 项通过。
- 影响：僵尸本身无害、无法回收（只有父进程 tmux server 能 reap，不能为它杀 tmux），修复后不再误判。

## 变更：扩展源码移出指纹 + 版本落后提示（用户选项 B）

- 用户决定：`pi-tsien-extension` 是活跃开发仓库，改扩展不应中断在跑的主会话。改为选项 B。
- `backend/supervisor/config.ts`：`validateSupervisorResources` 现在返回两个指纹——`revision`（门禁，= 配置 JSON + 角色/Skill 路径 + 角色/Skill 内容）与 `extensionsRevision`（= 扩展路径 + 扩展内容，不门禁）。`/execute`、`/loaded`、资源状态判定仍只看 `revision`。
- `backend/supervisor/runtime.ts`：`AgentRecord.extensionsRevision` 在启动时记录；`state()` 增加 `agent.extensionsStale`；新增私有 `extensionsStale()`，`context` 操作在落后时返回 `resourceNotice`（让主 Agent 自己说明版本落后，不隐瞒）。扩展源码变化不再让通道 403。
- 前端：监督台「授权范围与采样」与主 Agent 弹窗都显示一句「扩展代码已更新（主会话仍在用启动时的版本）：现在可继续使用，建议结束后重新启动主会话以加载新代码。」
- 测试：后端新增两条（扩展源码变化 → 指纹 `revision` 不变、`extensionsRevision` 变；运行中改扩展 → 读请求仍 200 且 `extensionsStale: true`、`resourceNotice` 出现，而改 SKILL 仍 403）；前端新增一条（页面与弹窗都出现提示）。5 个后端监督测试文件 45 项通过、监督台/工具栏 42 项通过。

## 说明：资源指纹变更后读写通道一起暂停（403）

- 现象：主 Agent 调用任何工具（含只读的 `supervisor_context`）都被网关 403，报文是“资源配置已改变，旧主会话写权限暂停，请重新加载”。用户会以为只是写入被拦。
- 真实机制（`gateway()` → `ensureResourcesCurrent()`，`backend/supervisor/runtime.ts`）：每条 `/execute` 在分发前都先比较“当前资源指纹”与“本主会话启动时记下的指纹”，不一致就直接 403。因此**读和写一起停**，不是只拦写入。
- 指纹 = `sha256(配置对象 + 角色/Skill/扩展的绝对路径 + 这些文件的内容)`。也就是说：改 `dashboard.json` 的监督配置、或改 `role.md`/`SKILL.md`/被加载扩展的源码，都会让在跑的主会话通道失效。恢复方式只有一个：结束旧主会话并重新启动（启动时重写凭据与指纹）；只刷新页面无效，因为扩展在加载时读凭据。
- 修改：报错文案改为“监督资源已变更（配置或角色/Skill/扩展文件被修改）：主会话的读取与写入通道都已暂停，请结束旧主会话并重新启动后再操作。”；新增回归用例断言读、写同时 403 且错误文案不再只说“写入”。
- 已知代价（未改）：被加载的扩展源码也在指纹里，而 `pi-tsien-extension` 是活跃开发仓库，改它会让在跑的主会话通道暂停。是否把扩展源码移出指纹（只在配置/角色/Skill 变化时暂停）待用户决定。

## 变更：内容改动不再停通道 + 写入门槛可关（用户要求：“ts 可以直接写入，不要每次点按钮”）

- 用户报的现象：主 Agent 的写入反复失败；先以为“确认按钮被关掉或选了不允许”，后来网关返回 403“监督资源已变更（配置或角色/Skill/扩展文件被修改）：主会话的读取与写入通道都已暂停”。实测核对：`runtime.json` 记录 `revision=815e8be1…`，按当前磁盘重算为 `38a3888b…`，两者不等（`contentRevision`/`extensionsRevision` 也都变了）——即上一条说明里的指纹门禁在起作用，属于“读和写一起停”，不是点不点按钮的问题。
- 根因拆成两个闸门：
  1. **启动形状闸门**（`ensureResourcesCurrent()`）：任何指纹不一致 → 403，读写全停。原指纹把**角色/Skill 文本**也算进去，导致改一段提示词就得结束会话重启（本次主会话自 10-16 启动，`role.md`/`SKILL.md`/`dashboard.json` 于 10-26 改过，因此一直 403）。
  2. **写入确认闸门**（`gateway()` 里 `userInitiated`）：真实用户轮里，用户原话必须能解析出该操作，否则 403 `explicit_operation_confirmation_required`，扩展据此弹「等你确认」卡片 —— 这才是“必须点按钮”的来源（`record` 只有这一个来源；扩展自己只在完成/破坏性更正/关闭待办时预确认）。
- 修改（`backend/supervisor/config.ts`）：`validateSupervisorResources` 拆成三个指纹——`revision`（门禁：启动形状 + 资源路径）、`contentRevision`（角色/Skill 文本）、`extensionsRevision`（扩展源码）。理由与之前把扩展源码移出门禁一致：**指令文本不是启动参数**，改它不该停通道。`requireWriteConfirmation` 也从门禁 JSON 里剔除（它只影响谁能写，不影响进程能做什么，改它不该触发重启）。
- 修改（`backend/supervisor/runtime.ts`）：内容/扩展落后时不再 403，改为 `supervisor_context` 的 `resourceNotice`（“角色或 Skill 内容已更新……建议重启主会话生效”）；403 文案收窄为“监督配置已变更（工具白名单、扩展清单、模式或名字）”；新增配置项 `agentResources.requireWriteConfirmation`（默认 `true`），设为 `false` 时**真实用户轮不再需要点名操作或点确认**，自动巡查轮仍然不能写。
- 保留：`task_update done`、破坏性 `event_correct`、`action done` 仍由扩展前置确认（不可逆动作）；服务端 `completion()` 的 `confirmed` 校验未改。
- 代价（用户已知情并选择）：`requireWriteConfirmation: false` 后，主 Agent 可以在用户没点名写入的情况下自行落库；审计仍记录 `actor=主 Agent` 与来源会话，但不再有一次人工点击。想恢复严格模式只需把它改回 `true`（不需要重启主会话）。
- 回归：`backend/__tests__/supervisor-runtime.test.ts` 19 项通过（改指纹用例改判“SKILL 改动不打门禁”，新增“配置改变仍 403”和“`requireWriteConfirmation:false` 下真实用户轮免点、巡查轮仍 403”）；`supervisor-service`/`-config-persist`/`-integration` 33 项通过；后端/前端类型检查通过。
- 生效方式：后端代码改动需要用户重启 Dashboard 服务；服务重启后再结束旧主会话并按新代码启动一次（指纹方案换了，旧记录必然对不上）。之后改角色/Skill/扩展代码只需重启主会话（或等提示），不再需要“先结束再启动才能读”。

## 变更：去掉指纹门禁与全部写入确认（用户要求：“搞得太麻烦”“去掉确认动作”）

- 用户反馈三点：指纹比对为什么要有、太麻烦；确认动作去掉；剩下三个不可逆动作也免确认。
- 指纹（`backend/supervisor/config.ts` 的三个哈希：`revision` 启动形状 / `contentRevision` 角色与 Skill 文本 / `extensionsRevision` 扩展源码）**仍保留，但不再拦任何调用**。`gateway()` 里原来的 `ensureResourcesCurrent()` 403 已删除，替换为 `enabled()`（只校验监督功能是否开启）；落后一律通过 `supervisor_context` 的 `resourceNotice` 提示“重启后生效”。理由：原文意图是防止“进程权限与最新配置不一致”，实际代价是改一段提示词就让在跑的主会话整条 403（本次故障即此），用户判定不值得，故降级为提示。`start()`/`clear()` 的“旧会话仍在跑/启动形状变了就别硬来”保护保留——那是“不要同时跑两个”，不是门禁。
- 写入确认全链路删除：
  - 后端 `runtime.ts`：`userInitiated = userTurn || currentUserTurn`。真实用户轮（含弹窗/会话页/面板）直接写，不再解析用户原话是否为该操作、不再返回 `explicit_operation_confirmation_required`；唯一保留的边界是自动巡查轮（`userTurn:false` 且无 grant）→ 仍然 403「本轮不是用户请求」。
  - `shared/src/supervisor.ts`：删掉 `SupervisorContext.confirmed` 与 `agentResources.requireWriteConfirmation`（上一轮刚加的开关一并撤掉，避免死配置）。
  - `backend/supervisor/service.ts`：`completion()` 不再要求 `confirmed`；`task_update done`/`action done` 只保留“必须真实用户轮”的判定，`event_correct` 不变。
  - `pi-tsien-extension/extensions/supervisor/index.ts`：删除 `confirmationFor()`、`askConfirmation()`、`takeTextConfirmation()`、`pendingConfirmation`/`confirmedByText`、`isPlainConfirmation`/`isPlainRefusal`、`confirmationTarget/Marker/Summary`、`withoutRequestId`，以及拿到 403 后弹一次确认重试的分支；工具描述里“requires UI confirmation”的措辞同步改掉（模型会照着描述行动）。
- 连带影响：`[supervisor-confirm]` 机器尾标不再产生，所以监督台的「等你确认」卡片与侧栏「待确认」角标不会再出现（前端代码与其修复保留，处于休眠状态）。`task_update done` 仍要求非空 `evidence`，`event_correct` 仍要求版本与原因——这些是数据质量校验，不是人工确认。
- 取舍（用户已知情并选择）：主 Agent 可以在用户没点名写入的情况下自行落库；审计仍记录 `actor=主 Agent`、来源会话与 `messageRef`，但没有人工点击这一层。要恢复人工确认需要改代码，不是配置项。
- 回归：后端 5 个监督测试文件 56 项通过（改写“未点名也放行”“配置变化只提示”“巡查轮仍拒绝”等用例）；扩展仓库 `test/supervisor.test.ts` 20 项通过；两端类型检查通过。前端的旧确认 UI 单测仍通过（组件保留）。

## 修复：资源指纹变更后无法启动（“等待重新加载”卡死）

- 现象：弹窗显示 `资源状态：pending · 未连接` + 红字“资源发生变更，等待重新加载。请管理员处理旧主会话”，启动按钮灰掉，无法启用。
- 根因：`runtime.json` 里保存的是上一次成功启动时的资源指纹（role/skill/扩展/配置的哈希）。之后 SKILL.md 和配置（新增 goal 扩展、`event_query`）变过，于是 `state()` 判定 `pending`。真正需要人工处理的只有“旧主会话还在跑”这一种情况；但前端把 `pending` 一律当成不可启动，且提示语只写了要管理员处理旧主会话，而实际记录里没有 sessionId/pid、旧会话早已不存在，于是死锁。
- 修复（`frontend/src/features/supervisor/SupervisorAgentProvider.tsx`）：`pending` 只在**旧主会话仍在运行**（`agent.connected === true`）时拦住启动并提示“请先结束它”；旧会话已结束（未连接）时按钮可用，提示改为“点启动会按新资源启动，不会中断其他会话”。后端 `startOnce` 本来就允许这种情况（先探测注册表，无旧会话且记录 pid 已死就继续启动并写入新指纹），因此无需改后端。
- 回归：`bash-6350` 监督台前端测试 26 项通过（新增 2 条：pending+未连接可启动、pending+仍连接被拦）。

## 会话观察改为可读摘要 + 去掉重复入口

- 动机：右栏原来直接贴 live session 的末尾 4000 字，那是写给模型看的文本（含命令、路径、代码块、「喵，…」口头语），人读起来成本高。
- 做法（`backend/supervisor/digest.ts`，纯函数，不调模型）：取最近 8 条 assistant 消息 → 去代码块/行内代码/链接/强调/列表编号/口语前缀 → 按中英文句末标点切句 → 丢掉命令、表格、裸路径、`Background Command` 之类工具行与过短片段 → 产出 `{headline, points≤3, waitingFor, nextStep, coveredMessages, source:'recent_output'}`。headline 优先取最新消息里的“结果/问题”句，其次首句；points 新→旧、去重（含字二元重叠 ≥0.6 的近重复）、排除已在 headline/在等/下一步出现的句子；`当前没有待处理的后续` 这类否定句不再被当成“在等”。
- 契约：新增 `SupervisorSessionDigest`，挂在 `SupervisorSession.digest?`；`observeSession` 各分支同时返回 `lastText`（原文）与 `digest`（摘录），巡查签名一并纳入 digest。全部字段都是原文摘录，只做可读性重写，不产生新事实。
- 展示（`frontend/src/pages/SupervisorPage.tsx`）：标注「最近输出摘要（摘自最近 N 条回复，新→旧，便于阅读；不是任务事实）」+ 结论 + 要点 + 在等 + 下一步，并把原文收进「原始输出（末尾 N 字）」可展开；摘不出句子时仍直接显示原文，不伪装成已总结。
- 同时删除 live session 右侧工具栏里重复的主 Agent 入口（`LiveSessionFeatures.tsx`）：主 Agent 只在导航栏出现一次，通知铃铛保留。
- 回归：`bash-468b` 前端类型检查 + 监督台测试 24 项通过；后端类型检查 + 5 个监督测试文件 42 项通过（新增 `supervisor-digest.test.ts`）；`LiveSessionFeatures.test.tsx` 12 项通过。
- 决策（2026-10-08，用户选 A）：摘要**保持抽取式**，不接模型生成式摘要。理由是零成本、零延迟、可回归、不会编造；代价是偶尔挑句不精准，已用“不是任务事实”标注 + 可展开原文兜底。若日后发现抽取式经常挑错，再考虑改由主 Agent 巡查时生成（选项 B），不在本轮实现。

## 修复：主 Agent 无法启动（`live_pi_registration_timeout`）

- 现象：监督台启动主会话失败，报 `live_pi_registration_timeout: tmux session ... was killed ... without registering`，且报错里没有启动输出。
- 根因（已在真实启动路径上复现并验证）：两个启动参数问题叠加。
  1. 启动参数用了 `--tools ''` 想禁用内置工具，但空允许表会把**扩展工具也一起禁用**，监督扩展发现自己的工具不可用，直接报 `Supervisor profile contains unavailable tools.` 并中止。已改为 `--no-builtin-tools`。
  2. 主会话用 `--no-extensions` 关闭自动发现后，launcher 脚本 `pi-clean` 硬编码追加的 `--goal-continuation` 没有任何已加载扩展注册，pi 以 `Error: Unknown option: --goal-continuation` 立即退出。已把注册该 flag 的 `packages/pi-tsien-goal/src/index.ts` 加进默认 `extensionPaths`（默认三条），并在 guide 记下“launcher 追加的 flag 必须有对应扩展”的规则。
- 另一处诊断障碍：pi 退出后 tmux 会连同会话一起销毁，`paneTail` 取不到任何输出，所以报错看不到原因（只有超时文案）。报错中已补充指向这两个参数的提示；服务器日志里的 `[live-launcher]` 仍会记录失败行。
- 验证（真实进程，非单测）：用 `validateSupervisorResources` 从真实 dashboard.json 生成 argv → 在 tmux 中用同样的 launcher/env 启动 → pi 正常进入 TUI、三个扩展加载、**注册成功**（pane pid 与 `GET /api/live-sessions` 中 pid/idle 会话逐一对上）；旧参数下重现 `Unknown option: --goal-continuation` 与 `unavailable tools`。诊断会话已删除。
- 回归：`bash-d349` 后端类型检查 + 4 个监督测试文件 38 项通过（新增断言：参数含 `--no-builtin-tools`、不含 `--tools`；默认 `extensionPaths` 含 goal 扩展）。
- 用户侧待办：`~/.pi/dashboard.json` 里 `supervisor.agentResources.extensionPaths` 原本是**显式两条**，默认值不生效；已征得用户同意后修改该文件（改前备份 `~/.pi/dashboard.json.bak-20261007-211055`）：扩展补第三条 `packages/pi-tsien-goal/src/index.ts`，`allowedTools` 补 `event_query`（原 14 条不含新工具，否则扩展会把它设为非活动工具）。修改后用真实配置跑 `validateSupervisorResources` 验证：三个扩展、含 `--no-builtin-tools`、不含 `--tools`、允许工具 15 条。注意 `pi-env.ts` 的 `getDashConfig` 会缓存并在 `saveDashConfig` 时整份回写，需重启服务才能读到新配置。

## 后续：记录查询（最小路径已实现）

- 设计：[监督档案记录查询技术设计](supervisor-record-query-tech-design.md)（v2，经独立子 Agent 用不同模型评审，判定“改后再实现”，意见已全部处理）。
- 实现：新增 `query` 操作与 Extension 工具 `event_query`，固定返回 `{events,total,truncated,excludedWithoutTime}`；默认 `limit=50`、`order=desc`、`view=summary`（省 description/originalReply/revisions/payloadHash）；支持 `types`（词表 + 系统类型 + 已存类型）、`since`/`until`（date-only 的 `until` 含当日，无发生时间事件计入 `excludedWithoutTime`）；排序用显式 null-last 比较器，`desc` 才是“最近 N 条”。
- `supervisor_context`/`event_objects` 内嵌事件改为摘要并按默认 50 条截断，返回 `eventsTotal`/`eventsTruncated`；`event_list`/`event_get` 与页面行为不变。Extension `limit` 上限由 100 统一为 200。默认工具白名单加入 `event_query`。
- 顺带修复：`occurred()` 与新增的列表边界校验在非法日历日期（如 `2026-13-01`）会抛 `RangeError`，现返回 400 而不是 500。
- 验证：`bash-ed50` 后端类型检查 + 4 个监督测试文件 38 项通过；`bash-3f4d` 后端全量 613 通过（2 项失败均与本改动无关，见下）；`bash-11a7` 前端类型检查 + 监督 22 项通过；`bash-c953` Extension 类型检查 + 239 通过（1 项既有无关失败）。
- 本轮未做：`load` 耗时/档案字节数度量埋点、按容器分片或月度 rollup、计数模式；阈值触发条件据此暂不可测量，见设计 §10。
- 仍需用户执行 `./run.sh` 后做真实会话验收（含新工具在真实模型下的调用效果）。

## 已实现
- 独立主会话：角色和 Skill 在 `~/repos/pi-dashboard/agent/supervisor/`；专用 Extension 在 `~/repos/pi-tsien-extension/extensions/supervisor/index.ts`，不加入普通会话的自动加载清单。
- 默认关闭，启用观察不自动启动。空任务/会话范围拒绝访问；只有显式 `*` 才授权全部观察。协调必须列出具体会话 ID。
- 全局唯一居中对话入口；监督台、事件流水账和报告只读。启用后 Tasks 创建和抽屉修改转入主 Agent；普通会话原生操作不被取代。
- 私有 Unix 网关、可撤销凭证、资源指纹、按轮用户授权、实际 UI 确认、权限及协调限频审计。
- 明确指令允许普通本地操作；否定、提问或不明确的操作不能靠关键词自动获得写权限。必要时以实际操作内容进行 UI 确认。自动巡查不继承授权，也不能弹出正式完成/破坏性更正确认。
- 已有本地 Task Provider 的真实创建/更新；项目使用带 `project` 标签的本地 Epic，子 Task 保留 parentUid，不另建任务系统。Task Journal/Jira/Lark 来源事实保持只读，正式变更仍走 Task Pilot；外部同步不阻断本地能力。
- 本地观察状态通过专用操作及审计事件保存，阶段/下一步/等待对象与来源正式状态分开；普通流水记录和历史补录不隐式改变观察状态。
- 原子私有档案、请求幂等、修订版本、来源/记录人、原话和持久截图。事件保存对象及祖先快照，来源删除/不可用后，批准范围内的历史、分组、分析、更正和报告仍能读取。
- 文件 API 私有保护覆盖大小写、相对路径、符号链接、缺失子路径及认证控制文件，避免借公开文件接口获取授权凭证。
- 最近有限会话上下文、明确错误和断开状态；后台作业没有实时结果时标明未核实，不凭空闲推断失败或重启。
- 显式链接的阶段/等待区间与投入分钟数分别分析，不从消息间隔推断投入，不把重叠等待简单相加。报告保留输入版本、覆盖范围和缺失项。

## 审查与验证

独立源码审查发现并已处理：大小写文件绕过、空范围隐式全量授权、关键词误授权、失败发送撤销当前授权、离线历史被过滤。随后补齐本地项目容器和用户确认的观察状态。

最终证据：

- `bash-f1a0`：后端类型检查、68 项后端/Task/实际 Extension 贯通回归及 `docs:env-check` 全通过。新增历史截图真实字节读取、归档来源可读和未授权拒绝测试。新增启动 wiring 回归验证实际导入绑定，避免 `server.ts` 的 `@ts-nocheck` 掩盖未定义命名空间。
- `bash-ad1c`：最新前端类型检查、34 项监督/会话 UI 回归通过，包含通知未处理事项筛选、纯图标入口与仅打开草稿、不自动发送/改变任务。
- `bash-80f0`：Extension 工作区类型检查、19 项回归通过，14 个工具、自动巡查禁确认和真实图片内容返回验证完成。历史截图通过 event_get(includeImages=true) 返回图像内容，文本不重复携带 base64；图片限 4 张/6 MiB，传输限 9 MiB，普通响应仍限 2 MiB。
- `git diff --check` 在最终变更上检查；未运行部署构建或启动/重启 Dashboard。

主 Agent 已移入会话右侧工具栏，删除全宽顶部按钮行；新增同栏通知按钮查看最近待处理事项。协调审计保存检查文件路径和会话 ID，而非仅保存失效后无法解释的临时引用。外部文件/会话的完整历史内容并未复制归档。

## 用户实际操作验收及生效方式

本地首版功能代码与自动回归完成，实际操作验收由用户执行。建议按以下顺序试用（以下是验收步骤，不是已发生的运行证据）：

1. 配置并显式启动主会话；右侧纯图标入口打开唯一弹窗，不占顶部整行。
2. 创建本地项目/Epic 与子任务；明确推进任务，核对任务页真实变化与流水记录。
3. 记录协作原话和截图；重开页面并让主 Agent 用事件 ID 复读历史截图，核对具体图片内容。
4. 用户确认阶段、下一步和等待对象；核对本地观察与来源正式状态分开。
5. 查看通知并选择待办检查；只打开草稿，不自动发送或改变任务。
6. 观察模式查看停止/错误和质量证据；协调模式只向批准的具体会话提出建议，不抢控制权。
7. 更正历史记录、做区间分析和报告；核对版本、来源、缺失项及实际投入与历时区分。
8. 正式完成、破坏性更正确认应真实弹出；自动巡查、空授权范围和未授权文件应被拒绝。


- 尚未真实模型联调、实际浏览器视觉/交互验收、生产服务部署验证。
- Jira/Lark 按用户要求不属于本次交付，不作为本地功能阻塞项。Task Journal 来源正式状态按既定设计保持只读，仍须使用 Task Pilot 原生门禁；主 Agent 可记录其本地观察和事件，但不宣称已改动 PM 正式状态。
- 首版是单机可信用户场景；不宣称整个旧 Dashboard 已具备多用户安全隔离。
- 安装配置权威入口为 `~/repos/pi-dashboard/guide/config.md` 和 `guide/dashboard.md`。
- 验证收尾后，由用户执行 `~/repos/pi-dashboard/run.sh`（或自己的启动方式）构建并重启生效；Agent 不代为构建部署或重启服务。
