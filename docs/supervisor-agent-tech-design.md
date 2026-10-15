# 工作监督台与事件流水账：技术设计

- 状态：专用资源路径与加载方案已确认，首版代码已实现并进入集成验证；部署和真实模型/浏览器验收待用户执行。
- 实现与验证记录：[实施状态](~/repos/pi-dashboard/docs/supervisor-agent-implementation.md)。
- 需求依据：[PRD](~/repos/pi-dashboard/docs/supervisor-agent-prd.md)。首版范围为本地监督、协作档案、待办及可写本地任务；来源正式状态不借此绕过原任务系统门禁。
- 记录增长后的高效访问（`limit`/过滤/投影/报告复用）：[监督档案记录查询技术设计](~/repos/pi-dashboard/docs/supervisor-record-query-tech-design.md)。
- 本文保留设计背景；实际接口、配置和验证状态以源码、guide 与实施记录为准。Jira/Lark 不作为本次交付前提，实际操作验收由用户执行。
- 范围：单机、单个受信任 Dashboard 使用者；本机已有任务源和 LiveSession。多用户、远程 Agent、外部自动同步后置。

## 1. 结论与主要选择

1. 复用现有任务聚合、会话运行时和对话附件交互，不再建一套任务或聊天系统。
2. 用户选定一个持久化主 Agent 会话，作为监督与事件记录的唯一入口。其他会话继续工作，监督 Agent 默认只读观察，不抢控制权。
3. Dashboard 后端是事件、附件、人工待办和分析结果的权威存储。Agent 只能通过受限工具提交请求，不能直接编辑存储文件。
4. 增加“事件流水账”页面，按项目/Epic/Task 展示时间线；工作监督台展示当前状态、待办和风险。页面无独立输入框。
5. 首版使用 Node 文件存储，沿用现有原子文件写入方式，暂不引入数据库依赖。将文件访问封装为 Store，数据量增长后可单独迁移。
6. 确定性代码计算时间区间、权限和写入结果；模型只归纳、提出抽查意见和解释卡点，不负责猜工时或裁定权限。
7. 主 Agent 使用独立角色与资源配置：角色说明及专用 Skill 放在 pi-dashboard 仓库的独立目录，专用 Extension 放在 pi-tsien-extension 规范源仓库；由 Dashboard 配置显式加载，不全局安装、不影响普通 Session。

## 2. 当前能力与缺口（源码核对）

| 能力 | 当前依据（绝对路径） | 复用方式 / 缺口 |
|---|---|---|
| 任务聚合和来源能力 | `~/repos/pi-dashboard/backend/tasks/service.ts` | 使用 `snapshot()` 的 tasks/providers/warnings；来源失败不可解释为没有任务 |
| 稳定任务身份、父子关系、规划和会话关联 | `~/repos/pi-dashboard/shared/src/tasks.ts` | 使用 `uid`、`parentUid`、`plannable`、`PlanningEntry.sessionIds`；当前 kind 没有 project |
| 任务 API | `~/repos/pi-dashboard/backend/routes/tasks.ts` | journal 等来源只读；新功能不借现有写 API 绕过任务系统流程 |
| LiveSession 元数据 | `~/repos/pi-dashboard/shared/src/live-sessions.ts` | sessionId、processInstanceId、运行状态、lastActivityAt、父子关系；没有统一业务进度字段 |
| 浏览器认证 | `~/repos/pi-dashboard/backend/routes/require-browser-auth.ts` | 可复用 LiveSession Cookie/Origin 校验；现有 Dashboard 无全局认证，不可假定其他 API 已隔离 |
| 文件/图片接收 | `~/repos/pi-dashboard/backend/routes/files.ts` | upload-files 保存到系统临时目录；save-image 可接收路径，均不适合作为事件档案存储接口 |
| 多运行时与扩展桥 | `~/repos/pi-dashboard/backend/pi-sdk-session.ts`、`~/repos/pi-dashboard/backend/extension-bridge/rpc-server.ts` | 存在 SDK/RPC 差异；当前 bridge 不是可直接复用的通用事件写入接口 |

实现前需进一步验证主入口具体采用 LiveSession 还是 Chat Slot，以及对话图片的提交链路。本设计不假定现有工具已能访问事件服务。

## 3. 总体数据流

```text
唯一主 Agent 对话入口
  ├─ 用户消息、回复、截图 → 附件接收 → 持久 attachmentId
  ├─ 识别对象/时间/来源 → 受限工具适配器 → SupervisorService
  └─ 成功回执 / 必要澄清 / 只读分析结果
                                      │
                        权限、确认、版本、幂等检查
                                      │
                  EventStore / AttachmentStore / ReportStore
                                      │
        任务聚合 + 会话观察 ──→ 监督快照 / 时间计算
                                      │
                  事件流水账页面 / 工作监督台（只读）
```

浏览器和 Agent 通过不同凭证访问同一服务，采用同一对象范围校验。只有服务真实提交成功才产生“已记录”回执。保存事件、更新当前状态、对外同步是不同操作。

## 4. 主 Agent 与工具接入

### 4.1 唯一入口与会话生命周期

- 在现有会话体系中选定/创建主 Agent，保存稳定 `sessionId` 和可用的会话引用；不以会重启变化的 `processInstanceId` 作为长期身份。
- 提供“主 Agent”导航；事件页面的“回到主 Agent”只携带对象 UID 和可选事件 ID，不设置第二个输入框。
- 主入口离线时显示不可用及恢复入口，不自动启动另一个竞争会话、不丢失既有记录。
- 普通新增由用户当前消息明确授权；模糊对象返回候选项，让用户在同一对话确认。页面上下文只是提示，不覆盖用户明确指定对象。

### 4.2 拟议工具边界

| 工具 | 能力 |
|---|---|
| `supervisor_context` | 获取授权范围内任务/会话快照、关联与来源警告 |
| `event_objects` | 查找项目/Epic/Task；创建或关联本地项目容器须用户明确要求 |
| `event_list` / `event_get` | 查询时间线或单条事件/修订 |
| `event_append` | 根据用户明确请求新增事件并关联已上传附件 |
| `event_correct` | 带预期版本更正指定事件，保留修订 |
| `supervisor_action` | 在同一入口提出/处理人工待办及本地状态确认；不写外部任务源 |
| `supervisor_analyze` | 获取确定性时间统计、生成/保存带来源的摘要、复盘或抽查报告 |

工具只暴露结构化参数，不接受任意文件路径、Shell 或任意远程 URL。文件抽查使用额外授权的资源引用，而不是由模型自由选择系统文件。

### 4.3 运行时适配方案

建议新增本机专用工具网关，与浏览器 HTTP API 调用同一 Service。使用权限 0700 目录、0600 Unix socket（本机进程通信通道），按主会话签发可撤销且绑定 scope 的凭证；令牌不进入提示词、报告或日志。首版仅接入主会话，不向其他 session 分发写权限。

Pi 工具注册放在 pi-tsien-extension 规范源仓库的专用 Extension 中，主 Agent 的角色与 Skill 放在 pi-dashboard 专用目录；按 §4.4–4.5 显式加载，Dashboard 不修改已安装扩展副本，也不假定现有 extension bridge 支持本方案。实现前按 Pi 官方文档完成 SDK/RPC/LiveSession 工具注册适配验证；先接入实际选定的一个运行时，其余不冒充已支持。适配层只处理参数/协议，业务校验全部在服务端。

涉及状态变更、覆盖修改、删除的确认不能靠模型传 `confirmed:true`。服务创建绑定 actor、operation、target、payloadHash、version 的一次性确认请求，经现有对话确认交互取得用户确认后消费；普通明确更正以真实用户消息引用和预期版本校验。若所选运行时无法提供可靠用户请求引用/确认交互，该写操作先禁用，不以提示词替代权限门槛。

### 4.4 专用资源目录与职责（已确认方案）

```text
~/repos/pi-dashboard/
  agent/supervisor/
    role.md
    skills/
      dashboard-supervisor/
        SKILL.md
        refs/

<pi-tsien-extension 仓库绝对路径>/
  extensions/supervisor/
    index.ts
```

pi-dashboard 路径为当前仓库；pi-tsien-extension 的实际仓库位置在实现接入时核实，不把示例位置当作已存在路径。以上目录均为拟新增结构，本次仅更新文档，不创建资源文件。

- **role.md**：主 Agent 常驻角色说明，定义监督职责、权限边界、汇报要求，以及需要读取专用 Skill 的场景；不能依赖模型偶然触发 Skill 来遵守关键规则。
- **dashboard-supervisor Skill**：监督和协调的判断流程，包括停止原因、基于已有决策回答澄清、方向偏差、输出可读性、交付证据、目录规范及升级人工。长检查清单放 refs；具体操作权限仍按当前授权模式执行。Skill 与 Dashboard 产品需求一起评审和版本管理，不放在自动发现的 `.pi/skills/`，也不复制到全局 Skill 目录。
- **supervisor Extension**：注册受限监督/事件/任务工具、连接后端、提交运行时加载状态；不自行实现任务源写入或后端权限判定。代码只修改 pi-tsien-extension 规范源仓库，通过配置引用该入口或构建产物，不修改已安装副本。
- **Dashboard 后端**：管理主会话资源配置、身份及权限、触发监督检查和记录操作结果。Skill 不能自行定时唤醒，Extension 加载成功也不意味着获得跨 Session 操作权限。

Extension 子目录不能天然保证隔离：必须核查 pi-tsien-extension 的全局入口、扫描规则及安装清单，确保不通过普通会话已有入口间接加载 supervisor。若现有目录会被自动扫描，应调整专用入口的组织方式，保留独立归属但不得默认对所有 Agent 启用。

### 4.5 Dashboard 配置与显式加载生命周期

在拟议 `dashboard.json` 的 `supervisor` 段下增加 `agentResources`：

| 配置 | 含义 |
|---|---|
| `rolePath` | 主 Agent 常驻角色说明的绝对路径 |
| `skillPaths` | 显式加载的 Skill 目录列表；首项为 pi-dashboard 的专用 Skill 目录 |
| `extensionPaths` | 显式加载的 Extension 文件入口列表；指向 pi-tsien-extension 的专用入口或其构建产物 |
| `allowedTools` | 主会话可用工具白名单；默认不开放任意 Shell 和代码写入工具 |
| `mode` | `observe`（主动观察）或 `coordinate`（在授权范围内协调），默认 observe |

对象/文件/Session 访问范围独立于资源路径配置，在后端权限层校验。配置由有权用户修改，模型不能通过工具增加 Extension 路径或提升 mode/权限。

加载过程：
1. 创建或恢复主 Agent 前，解析并验证绝对路径、文件类型、可读性、Skill 元数据和扩展入口；缺失或不兼容时明确报错，不静默退回普通 Agent 配置。
2. 构造专用资源集合：仅显式配置的 Skill/Extension，加上已评审且为 Dashboard 会话必需的桥接和确认资源。关闭未审核的全局/项目自动发现，不是叠加全部全局资源；也不能误禁用维持主会话连接所需的桥接能力。
3. 角色说明进入当前运行时支持的角色/系统上下文；Skill 由资源加载器注册，Extension 在该运行时中初始化。CLI/SDK/RPC 的实际配置方式按选定入口验证后实现，不把示意配置字段当作 Pi 原生参数。
4. 同时应用工具白名单和后端会话凭证范围；普通 Session 创建流程不读取该专用配置，浏览页面也不将自己变成主会话。
5. 加载完成后保存 `sessionId`、配置 revision、每项资源 realpath/内容指纹、运行时版本与工具注册结果。只有核对通过才显示“资源已生效”；进程重启后重新核对，不能仅凭历史标记恢复写权限。

配置修改不宣称即时生效。Dashboard 分别展示“期望配置”和“当前已加载配置”，不一致时标记待重新加载。首版在用户明确要求并且主 Agent 空闲时重建/重新加载专用运行时，保留稳定会话及业务记录；失败明确显示不可用，不偷偷启动第二个主 Agent。权限收紧立即由后端撤销或限制凭证，不等待重新加载；新授权只能在核对完成后生效。不能为加载配置自动重启 Dashboard 常驻服务。

Skill 与 Extension 独立提交版本；启动核对兼容性，不要求两个仓库每次一起更新。内容变更后重新计算指纹，并记录此次实际生效的版本，支持追溯监督判断使用了哪一套规则。具体发布/安装步骤在实现时进入 guide，不写入本节。

### 4.6 主动观察与授权协调（增补）

监督功能默认关闭；用户显式启用观察模式并启动主会话后，后端低频检查授权会话变化，只在主 Agent 空闲、无待确认交互且未被用户占用时触发巡查。没有新的状态/最后回复变化不重复发起同样的模型检查。自动巡查在提示前带机器标签 `[supervisor-auto-patrol]`，扩展据此把该轮标为 `userTurn: false`，因此只能检查、提出待办和保存报告，不能自行创建或更新任务；其余提示（用户在弹窗、会话页或面板里说的话）都算真实用户轮，后端放行写入，不需要用户可见的授权标记。

真实用户输入由后端生成当前轮的授权引用，限定允许的操作类型；扩展只从当前输入捕获引用，后台巡查和其他 Session 的消息不能冒充用户授权。完成状态和更正通过实际 UI 确认，不接受模型传入的 confirmed 字段。

协调模式需要显式允许目标 sessionId，且工具必须引用已核实的授权文件或任务事件。只允许普通澄清、继续和纠偏建议；目标忙碌、有用户租约或等待扩展 UI 确认时拒绝，不替用户答敏感审批。每次干预后要核查结果；频率和重试次数受限并保留进程重启后的计数。已发送建议记录到人工待办，能可靠关联 Task 时也记入事件流水账，归属不明不猜测。

Skill 对照需求/验收项检查方向、输出可读性、目录规则与完成证据；代码只提供事实和权限，不声称语义判断已经自动证明正确。无法访问的资料、后台作业状态和未检查项必须在报告中列为缺口。

## 5. 对象身份与数据模型

### 5.1 项目与任务

- Task/Epic 使用现有 `TaskFact.uid`；`plannable=false` 的不稳定条目不能直接挂档案，用户可明确新建稳定本地任务后关联。
- 首版项目使用带 `project` 标签的本地 Epic 表示，沿现有 `parentUid` 组织 Task/Epic；复用现有任务 UID，不另建 `project:<uuid>` 容器或第二套任务状态。创建本地 Task/Epic 支持 kind、parentUid、tags；外部项目不伪造为本地自动同步对象。独立项目模型待真实使用后再评估。
- 聚合沿 `parentUid` 展开后按 UID 去重；检测层级循环并报告。事件只存一个所属对象，查询上级时按 eventId 去重。
- 保存时留对象标题/层级快照。源不可用或对象已删除时历史仍可查看，显示孤立/来源不可用，不静默绑定同名对象。关联变化记录审计；默认项目汇总使用当前关系，历史关系可在事件来源中核查。
- 实现首次接入时验证跨 provider/root 的 UID 是否唯一；冲突不能合并，需修复来源身份或显式迁移。

### 5.2 核心记录（逻辑字段）

| 模型 | 核心字段 |
|---|---|
| Event | id、objectRef、objectSnapshot、type、stageId、occurredAt（可空）、timePrecision、recordedAt、timezone、participants、recorder、source、originalReply、userDescription、agentSummary、result、nextStep、attachmentIds、version、revisions、withdrawn |
| Source | user-message/session 引用、本人确认/用户转述/来源引用、源时间与可用状态；“引用”不意味着系统已经核实 |
| Revision | version、serverTime、actor、reason、changedFields；事件有效视图取最新版，原内容保留到按隐私策略执行删除 |
| Attachment | id、owner/scope、originalName、mime、bytes、hash、storageKey、createdAt、status |
| Interval | id、objectRef、stageId、kind（stage/wait/effort）、startEventId、endEventId、participants、reason、confirmed、explicitDuration（仅实际投入） |
| ActionItem | id、objectRef、reason、nextAction、owner（可空）、state、sourceRefs、createdAt、resolvedAt、version；Agent 建议与用户确认区分 |
| Report | id、kind（summary/review/retrospective）、scope、sourceRefs、coverage、missing、inputVersions、generatedAt、modelId、analysisVersion、conclusions、status |
| WorkingOverlay | objectRef、用户确认的本地当前阶段/下一步/等待对象、updatedAt、sourceEventId、version；不覆盖 provider 事实状态 |

事件类型建议包括发起、进展、回复、决策、交接、阻塞、恢复、结果、完成。参与者与记录人分开；角色只是描述，不是用户账号或权限。只有日期的补录保留精度，不能强造精确时间用于小时统计。

### 5.3 会话状态

`idle/running/reconnecting` 是执行状态，不是业务完成度。监督快照分别展示 provider 完成状态、用户确认的 WorkingOverlay、运行状态和规则推断的可能停滞，彼此不能覆盖。

每个来源返回 sampledAt、lastActivityAt（若可用）、available、warnings。首版直接读 registry 与任务聚合，不主动发 claim/input/abort/resync。重启后无可靠活动记录的会话显示未知，不以启动时间作为进展时间。

## 6. 存储、附件与一致性

首版根目录：`~/.pi/dashboard/supervisor/`，子目录保存 objects、events、attachments、actions、reports；0700 目录、0600 文件。第一版单服务进程持有写锁，多实例访问同一根目录时第二实例拒绝写入。

- 每个事件文件包含全部修订及其 idempotencyKey；新增/更正通过写临时文件、fsync、rename，再同步目录。内存索引启动时从有效文件重建，不作为权威数据。
- 每条写请求带 requestId、幂等键和规范化 payloadHash。同键同内容返回原结果，不重复追加修订；同键不同内容返回冲突。保存后的回包丢失可以安全重试。
- 更正/待办状态使用 expectedVersion，冲突返回最新版本，由用户决定，不自动覆盖。
- 对象创建、事件、状态更新分步执行，返回逐步结果；不声称跨文件事务。当前状态更新的审计事件和新值放在同一个 overlay 文件原子提交，查询时将审计记录并入时间线。
- 解析失败显示明确损坏告警并拒绝相关写入，不当空库；部分来源失败与存储损坏分别处理。
- 排序：occurredAt 优先，未知时间单独展示；同时间按 recordedAt、id 稳定排序。游标包含排序键及查询条件版本；补录后提示重新加载，不假定旧游标是冻结快照。

### 附件链路

统一对话发送截图时先进入新持久附件服务，拿到 attachmentId；发送给模型的图片仍走已有对话链路，事件只关联持久 ID。截图进入档案与仅发送给对话应有明显用途提示。不得把临时目录路径直接写入长期事件。

服务生成 storageKey，不接受客户端路径。验证真实文件类型、大小与数量；首版建议 JPEG/PNG/WebP，单文件上限 3 MiB、每次最多 4 张且总量 6 MiB（与当前 LiveSession 限额对齐，最终以所选入口校验为准），不支持可执行 HTML/SVG。文档先用链接，不在首版扩展任意文件解析。

附件先原子保存，再提交引用事件；上传失败不得报告证据已保存。事件失败后附件保留为未关联，按配置宽限期清理；同哈希去重仅限同一授权范围。删除附件返回“证据已删除”，不产生死链接；需要硬删除敏感内容时同步清理修订、报告副本和缓存，记录不含原文的删除审计。持久文件备份与删除策略在上线前确认。

## 7. 拟议 HTTP API 与错误契约

前端读 API 和 Agent 工具共享 Service；HTTP 写接口仅供统一入口调用，不因此增加表单。

| 方法与路径 | 用途 |
|---|---|
| `GET /api/supervisor/context` | 来源警告、会话/任务状态、人工待办 |
| `GET /api/supervisor/objects` | 对象选择和层级 |
| `POST /api/supervisor/projects` | 经用户请求建立本地项目容器 |
| `GET /api/supervisor/events?objectRef=&includeChildren=&cursor=&limit=` | 筛选时间线，默认 50、最多 100 条 |
| `GET /api/supervisor/events/:id` | 有效内容与修订 |
| `POST /api/supervisor/events` | 幂等新增 |
| `PATCH /api/supervisor/events/:id` | 带版本更正 |
| `POST /api/supervisor/attachments` | 统一入口上传持久附件 |
| `GET /api/supervisor/attachments/:id` | 鉴权读取原图/缩略图 |
| `POST /api/supervisor/actions`、`PATCH /api/supervisor/actions/:id` | 建议/处理人工待办 |
| `POST /api/supervisor/working-state` | 用户确认后的本地当前状态更新 |
| `GET /api/supervisor/analysis` | 确定性区间分析与缺口 |
| `POST /api/supervisor/reports`、`GET /api/supervisor/reports/:id` | 保存/读取按需分析结果，不自动开启模型作业 |

新增请求至少包含 objectRef、type、userDescription、sourceUserMessageRef、idempotencyKey；occurredAt 不明确允许未知并标记。服务返回 eventId、version、persistedAt、deepLink。write 成功与 report 生成成功分别返回，不捆绑虚假全成功。

错误：400 字段/时间无效；401 未认证；403 范围或确认不足；404 对象/附件不存在；409 UID歧义、版本/幂等冲突；413 超限；503 来源或存储暂不可用。返回 requestId、可读原因、是否可重试，不回传令牌或内部敏感路径。

## 8. 确定性时间计算与模型分析

- 阶段和阻塞区间由明确 start/end 事件引用建立；模型发现候选节点只能提出建议，用户确认后进入正式统计。
- end 早于 start、节点精度不足、来源缺失或更正后不一致时标记不可计算，不夹成 0 或偷偷修正。
- 已结束历时为 end-start；未结束显示 now-start 和统计时点。多个重叠等待区间对总等待取区间并集，分类统计说明可能重叠，不能相加作为总量。
- 未知区间不记为零；补录/更正后基于当前有效事件重算，旧报告保留输入版本并标记已过期。
- 实际投入只接受明确 duration/可靠计时来源，并保留唯一记录 ID；无记录就显示未知。
- 长短期视角复用现有 lanes/planning，不引入第二套 bucket；补充的目标/依赖/截止时间存本地对象规划信息，外部来源保持只读。
- 模型输入为有限数量的状态、明确授权事件/交付和计算结果；输出结论引用 sourceRefs，并说明遗漏。按需运行、一个请求一个分析范围，不默认全量读历史或启动周期任务。
- 抽查输入必须有验收项、批准的资源和实际验证结果；仅对照资料的检查不声称执行测试。报告保存模型 ID、来源版本、抽样范围和缺口，抽查通过不触发任务完成。

## 9. 前端设计

- `/supervisor`：当前状态、人工待办、风险、近期行动/长期目标及最近报告；“主 Agent”导航回唯一对话。
- `/events`：对象选择、筛选、时间线；`/events/:eventId` 深链可直接定位单条记录。
- 事件卡片展示发生时间/录入时间、参与者/记录人、原始回复与归纳、结果、下一步、附件和修订标识。截图展开原图，未知/过期/用户转述有明确标签。
- 合作方“预计明天完成”呈现为计划/转述，不显示为已完成。来源事实状态与本地观察状态并列。
- 首版使用普通分页与现有前端请求方式；无需新增 WebSocket 协议。工具成功回执、切换页面和用户刷新触发重新查询。
- 返回主入口时携带对象引用，用户消息可表达不同对象；浏览上下文不能形成隐式修改授权。移动端沿用现有导航布局，避免增加多个输入区。

## 10. 安全与权限

现有认证只有浏览器身份，不等于完整多用户角色系统。首版只支持同一受信任使用者，在此边界下所有新读写/附件/报告 API 都要认证；不能只保护写操作。Cookie 写请求校验 Origin，附件响应 private/no-store，禁止未经认证的静态托管。

Agent 凭证由后端绑定主会话及允许的对象/资源范围；工具参数中的 actor、scope、sourceUserMessageRef 不直接信任模型，由服务验证。撤销凭证或主会话被替换后立即失效。截图/外部回复作为资料，不执行其中的指令。

敏感源排除规则在采集前生效，不是生成后仅隐藏 UI。避免报告复制完整回复/图片文本；发送给模型前控制必要内容。导出默认不含附件，外部分享另行确认。

必须证明截图不能通过现有公开文件读取路径绕过新认证；若通用文件 API 可读取新档案目录，应增加受保护目录排除规则，否则禁止上线。实际同 OS 用户运行的 Agent 仍可能具有 Shell/文件权限，本方案不承诺对恶意本机进程的强隔离；强隔离及多人使用需另做安全设计。

## 11. 实现拆分与验证门槛

| 阶段 | 产出 | 最小验收 |
|---|---|---|
| A：接入验证 | 确定主入口运行时、专用资源显式加载、权限与确认链路、稳定任务 UID | 真用户请求可验证；主 Agent 重启身份恢复；对象歧义不写入；普通 Session 不加载监督资源 |
| B：过程档案 | 事件/附件存储、幂等更正、受保护 API、时间线 | 回复和截图留存；补录/更正可追溯；服务重启后仍可打开；无独立输入框 |
| C：监督与人工待办 | 任务/会话快照、本地状态、待办及基础目标追踪 | 离线未知不冒充实时；主 Agent 不 claim 其他会话；状态变更确认可验证 |
| D：分析与抽查 | 区间计算、按需摘要/复盘/抽查报告 | 卡点结论有依据；未知工时不填零；缺证据报告信息不足 |

阶段顺序是实现建议，不删除 PRD 的其他场景；单独完成 B 不能宣称全部需求已交付。

资源加载专项验收：配置指定的角色/Skill/Extension 能在主会话加载；普通 Session 不加载监督资源；必需桥接仍可用；无路径、错误元数据、重复入口和不兼容版本不能冒充加载成功；配置变更明确标记待生效，忙碌时不强制重载；恢复后核对指纹；撤销授权立即阻止后续写操作。所有资源版本可追溯，主 Agent 不能修改自己的路径或权限配置。

测试重点：同键重试/不同内容冲突、并发更正、崩溃恢复、上传与事件分步失败、补录分页、源不可用/UID冲突、上级汇总去重、附件越权/路径穿越、修订后报告过期、重叠等待、日期精度、无工时记录、授权确认及未检查范围。

端到端使用“发起 → PM 回复截图 → 后端开发 → 联调阻塞 → 修复验证”，加入一次补录与更正；确认同一入口完成操作，页面可复盘，数据重启不丢，失败不报成功。模型不参与的测试优先使用固定样例，不为设计运行推理或构建。

建议新增模块：`backend/supervisor/` 下 store/service/analysis/auth，`backend/routes/supervisor.ts`，`shared/src/supervisor.ts`，`frontend/src/pages/SupervisorPage.tsx` 与 `EventLedgerPage.tsx`。专用 Skill/角色在 `~/repos/pi-dashboard/agent/supervisor/` 实现，工具扩展在 pi-tsien-extension 规范源仓库的专用入口实现，按 §4.4–4.5 由主会话显式加载。按实际改动合并小模块，不提前建空文件或通用框架。

## 12. 配置、部署与未决项

拟议 `dashboard.json` 的 supervisor 段：enabled、mainSessionRef、allowedObjects、excludedSources、retentionPolicy，以及 §4.5 的 agentResources（rolePath、skillPaths、extensionPaths、allowedTools、mode）；无配置默认关闭，不新增环境变量。详细配置须在实现提交同步到 `~/repos/pi-dashboard/guide/config.md` 和对应 guide 入口，安装/部署步骤不得散落本文。实现未引入额外依赖或环境变量；实际配置说明已同步 guide。

部署由用户自行执行 `~/repos/pi-dashboard/run.sh` 或自己的启动方式；Agent 不构建部署、不重启常驻服务。本次已修改前后端代码，需用户部署后生效；Agent 没有执行构建部署或重启。

上线前必须确认：
1. 首版采用哪种主入口及其工具/确认注册方式；核实 pi-tsien-extension 的绝对路径与自动发现规则，验证专用资源显式加载和隔离、附件接入是否端到端可行。
2. 本地项目容器与现有 Epic/Task 关系是否满足实际项目组织方式。
3. 可读取的对话/文件范围、数据保存位置、保留周期、备份和隐私删除策略。
4. 单用户边界是否符合部署现状，以及现有文件 API 的保护目录隔离结果。
5. 停滞阈值、提醒频率和成功指标目标值。默认关闭；用户显式启用并启动主会话后，按配置周期进行变化触发的低频巡查，不自动启动主会话。

上述属于实现前门槛或产品配置；代码和本机自动验证不能代替部署验收；真实模型/浏览器、运行中服务升级、数据保留/删除策略及人工纠错效果尚需明确或验证。当前仍可继续评审，不声称已在现有会话中实际运行监督。
