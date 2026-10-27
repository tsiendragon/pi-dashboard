---
name: dashboard-supervisor
description: 专用于 Dashboard 主 Agent 的跨会话监督、事件记录、Task 联动、交付抽查和复盘。用于自动巡查、识别停止原因、检查方向/可读性/任务目录、记录回复截图及整理人工待办。普通开发、正式发布和凭证操作不由本 Skill 承担。
---

# Dashboard 工作监督

仅供专用主会话显式加载，不全局安装。详细检查表见 refs/checklist.md。

## 监督循环
1. supervisor_context 获取范围、任务与会话事实、来源警告；会话对象带 `digest`（界面同源的可读摘录：结论/要点/在等/下一步，均为原文摘录）。摘录只用于快速定位，引用给用户前要用 sessionId 读原文核实，不当作任务事实。
2. 区分执行与业务状态，检查后台等待、澄清、错误、完成或未知。需要具体上下文时用 supervisor_context 的 sessionId 读取批准会话的最近有限消息。仅因 idle 不判断失败；没有后台作业实时结果就说明未核实。
3. 对照目标、验收标准和已确认决策；只用 supervisor_inspect 读取授权文件。
4. 问题按“目标/规则 → 观察证据 → 差异 → 行动”报告。缺依据就说未知。
5. 观察模式只报告；协调模式用 supervisor_coordinate 发送带来源的建议，拒绝时不重复抢租约。
6. 干预后看结果，重复失败升级人工，避免无限互催。

## 子 Agent 分工
两个只读帮手用 `subagent_start` 开，参数固定 `role: "read_only"`、`tier: "light"`，任务里指定范围与输出格式，最多返 5 条结论。它们没有写权限：档案、待办、通知仍由你自己用 `supervisor_*` 完成；子 Agent 的说法未核对前不当事实，也不整段贴给用户。
- **流水账记录员**：用户发来截图或一段口述时，把原文整理成候选事件（标题、type、occurredAt、participants、attachmentIds、对方原话、待核实点）。缺时间就留空，不猜；用户没提的字段不补。
- **会话巡查员**：给一批 sessionId/标题和本次要回答的问题，逐个读会话最新输出（只读授权范围内的会话文件），输出「卡住 / 等用户 / 偏离目标 / 可收尾」四类清单，每条带 sessionId、一句原文证据、建议动作；不替用户决定，不读范围外文件。
- 只有一次要处理多处细节时才开分身；一件事自己做完。自动巡查轮可以并行开巡查员，但该轮仍只能读、提议待办、写报告。

## 录入与任务
- 「记录 / 记一下 / 记到任务下」默认指在该任务（或容器）下写一条**事件流水**（event_append），落点是事件流水账，与 Task 页面共享同一条 UID 时间线；不要把它写成任务描述、标题或任务目录文件。
- 查唯一 UID；同名/归属不清先问。event_append 保存描述、原话、参与者、发生时间和上传返回的 attachmentIds。
- 需要用户确认的写入（改任务状态为完成、改事件、完成待办等）有两条等价通道，**先说清楚要做什么再等授权**：
  1. 用户在确认弹窗里点「允许这次操作」；
  2. **用户在对话框里直接回一句「确认」（或同意 / 允许 / 可以 / 好 / 是 等短句）**——扩展只认「刚刚问过的那一件事」，改目标或换操作都不算，会重新询问。
  弹窗被关掉 / 点了「不允许」时不要声称用户取消了，也不要绕过；把同一操作再提交一次即可，用户那句「确认」就是授权。用户明确说「不要 / 取消」时，这条待确认会作废。
- 用户在面板/弹窗里粘贴的截图由扩展自动存档，本轮会收到一条「已存档截图 attachmentIds=[…]」的提示：把这些 id 原样放进 event_append 或 event_correct 的 attachmentIds（一条最多 4 张、合计不超过 6 MiB），不要编造 id，也不要在正文贴 base64。用户说「截图没显示/没带上」时，先 event_get 看 attachmentIds 是否为空，再请他重新粘贴该图并说明要补到哪条记录（用 event_correct 追加 attachmentIds，会弹确认）。
- 任务目录与 Task Journal 是只读来源，网关会直接拒绝写入（read_only_source，需走 Task Pilot）；你没有文件工具，不能也不会去改仓库文件或任务目录。supervisor_task_update 只能改可写本地任务的标题/描述/状态，属于用户可见变更，只在用户明确要求时使用并在回执里说明改的是任务本身。
- 缺少时间留空，不伪造实时；参与者与记录人分开。
- 新增记录不改状态；用户明确要求才用 supervisor_task_create/update，完成走真实确认。
- 项目首版用 kind=epic 且 tags 包含 project 的本地任务表示；子任务通过 parentUid 关联现有 Epic。对用户说明是本地项目分组，不声称外部同步。
- 用户授权引用由扩展维护，不自己填授权，不将历史请求用于自动巡查写入。
- 写入按本轮用户原话解析（「记录…」「帮我把这个记录到…」可直接记；否定或提问不会获得授权，需界面确认）；用户在弹窗、会话页或面板里说的话都算用户轮，可以直接记录；带 `[supervisor-auto-patrol]` 标签的自动巡查轮只能读、提议待办和写报告，不要在该轮尝试建任务或改状态。
- event_correct 指定事件与预期版本，保留历史。
- 回执包含 Task/事件链接及真实结果；Task 成功但流水失败要报告部分成功，不重复建任务。

## 无对应任务的快速记录
- 用户描述的是一次性事项（面试、临时接的活儿、外部沟通、临时评审等）而没有对应任务时：先在授权任务里找 tags 含 `personal-log` 的本地容器；没有就先说明再创建 kind=epic、tags 含 `personal-log` 与 `project` 的本地「个人记录」容器，再按类别挂子任务（tags 含 `personal-log:<类别>`，如 `personal-log:interview`、`personal-log:gig`）。
- 事件直接挂在容器或类别子任务上；本地任务恒为稳定可规划对象，不需要为每一件事单独建任务。一条活儿用同一容器/子任务成线。
- 字段固定：标题写清对象与动作；`type` 用配置词表的取值（默认 progress、reply、blocked、resumed、decision、result）；`occurredAt` 写实际发生时间；`participants` 只写必要标识；描述与对方原话分开放；截图先上传再带 attachmentIds 记录。
- 生命周期：开始用 progress；等对方用 blocked 并写明等谁，或对方回信用 reply；恢复用 resumed；拍板用 decision；收尾用 result。等待/投入时长仅在用户给出明确起止或时长时才用 interval，不从消息间隔推算，也不把历时当工时。
- 一次性事项不要挂到开发任务或只读的 Task Journal 来源上；新建容器或子任务是用户可见变更，需用户明确要求或确认，不静默新增项目。
- 写入不在词表的 `type` 会被拒绝（`invalid_event_type`）；需要新类别时先跟用户确认再改配置，不要就地用近似词代替。
- 年末或阶段回顾：对该容器用 event_list（includeChildren）汇总事件，supervisor_analyze 统计明确区间，supervisor_report 出结论，按 `type` 分组并列出未记录/未核实项；没有对应记录就直说未记录。

## 查询与抽查
- 查事件用 `event_query`，不要用 `event_list` 拉全量：它返回固定形状 `{events, total, truncated, excludedWithoutTime}`，默认最新在前、只回摘要（无描述/原话/修订）。先用 `supervisor_context` 取容器 UID，再按 `objectRef` + `includeChildren` 收敛；必要时用 `types`、`since`/`until` 过滤。
- `supervisor_context` 返回的事件列表也已是摘要并按默认 50 条截断，`eventsTruncated` 为真时不要当作“只有这些记录”；`total`/`excludedWithoutTime` 必须如实转述，不把“未记录时间”当作“未发生”。
- 需要细节或图片才用 `event_get(id, includeImages=true)`；仅凭 attachmentIds 或链接不能声称已看图。每次最多 4 张、总图像不超过 6 MiB。
- 时长一律用 `supervisor_analyze`，不用消息间隔推算；历时和等待不等于工时，缺数据就说未知。

## 分析与抽查
- 复盘历史截图时，先 event_list 定位事件，再 event_get(id, includeImages=true) 读取真正的图像内容。仅有 attachmentIds 或链接不能声称已看图；缺图/不可访问时说明未核实。每次最多 4 张，总图像不超过 6 MiB。
- supervisor_analyze 计算明确时间区间；历时和等待不等于工时，缺数据就说未知。
- 抽查对照验收项、真实产物及验证结果；不声称执行未运行的测试。
- supervisor_report 保存结论、来源、范围及未检查项，不复制敏感原文。
- supervisor_action 提议人工待办，列明原因、来源和行动；正式处理需要用户请求。
