# 监督档案记录查询：技术设计（记录增长后的高效访问）

关联文档：[PRD](supervisor-agent-prd.md) · [总体技术设计](supervisor-agent-tech-design.md) · [实施记录](supervisor-agent-implementation.md) · 配置见 `guide/config.md` §4

- 状态：设计评审后修订版（v2），**最小实现路径（`limit`+`order`+`context` 投影+恒定形状查询操作）已实现并回归通过**；`types`/`since`/`until`/`view` 亦随实现落地，其余（度量埋点、rollup）未做。
- 评审记录：由独立子 Agent 用不同模型（`dashscope/deepseek-v4-pro-0813`）只读核对源码后给出 12 条 findings + 判定；本版逐条处理见 [§12](#12-评审结论与本版处理)。

## 1. 结论

- 记录“能不能存”已经解决；本设计解决**记录变多后主 Agent 如何低成本访问**。
- 最高杠杆不是查询能力，而是**写入即索引**：容器（本地 Epic）+ 类别子任务 + `type` 词表 + `occurredAt` 在写入时定好，读侧才能一次收敛，零基础设施。
- 真正需要修的**唯一已证契约缺陷是 `limit` 未生效**（外加“最近 N 条”的排序语义）。`types`/时间区间/投影是预防性能力，**在实测阈值触发前可以不做**。
- 关键设计决策（评审后改动）：**不采用“按参数改变返回形状”的多态契约**，改为新增一个**形状恒定**的查询操作给主 Agent；`event_list` 与页面路径保持不变。
- 必须同时修 `supervisor_context`：它现在一次性返回全部可见事件（含 `description`/`revisions`），否则分页与投影打不到主 Agent 的实际流量。
- 明确不做：全文/关键词索引、新增“个人日志”对象类型。理由见 §9。

## 2. 问题与现状（源码核对）

1. `event_list` 工具声明 `limit`（1–100），但服务端未读取 `args.limit`，**每次返回全部匹配事件**；返回体含 `description`、`originalReply`、`revisions`。主 Agent 以为在分页，实际一次吃满上下文。这是**契约缺陷**。
   - `extensions/supervisor/index.ts`（pi-tsien-extension）`limit` 定义与 `event_list` 参数；`backend/supervisor/service.ts` `events` 分支。
2. **`supervisor_context`/`event_objects` 走 `context` 分支，同样返回全部可见事件**（含 `description`/`revisions`）；这是主 Agent 查询流程的第一步，若不处理，L2 的分页与投影形同虚设。
3. `store.load()` 每次请求把整份 `~/.pi/dashboard/supervisor/archive.json` 读入、`JSON.parse` 并 `validateArchive`（含附件交叉校验）；`snapshot()` 亦走 `load()`。图片单独落在 `attachments/`（这点无需改）。
4. 列表排序为 `occurredAt` 升序、无发生时间的排最后；因此“最近 N 条”目前会截断**最旧**记录，语义相反。
5. 事件只支持 `objectRef` 与 `includeChildren` 过滤，没有 `type`、时间区间；流水账页面走同一操作并取全量，因此任何限制必须保证缺省时**行为不变**。
6. 规模现状：本机档案为空（约 4 KB、无事件）。以下所有规模判断是**设计推演，尚无实测负载**。

## 3. 目标与非目标

目标：

- 主 Agent 单次读取只拿到“该看的那部分”，且**能明确判断是否被截断**。
- 一年/一季度后的汇总查询可重复执行，成本不随记录总量线性放大到上下文里。
- 不改变现有授权语义、页面行为与写入确认流程。

非目标：

- 不引入检索引擎、向量库或外部数据库。
- 不改变对象身份模型（事件仍必须挂在稳定任务对象上）。
- 不改 `archive.json` 存储格式；附件仍独立成文件。

## 4. 方案总览

| 层 | 内容 | 作用 | 是否新代码 |
|---|---|---|---|
| L1 写入纪律（约定，已有） | 本地容器 + 类别子任务 + `type` 词表 + `occurredAt` | 结构即索引，读侧收敛的前提 | 无 |
| **L2 查询契约（本次实现）** | 恒定形状查询操作：`limit`、`order`、`types`、`since`/`until`、`view=summary`；并修 `context` 分支 | 单次读取量可控、语义正确 | **有** |
| 用法约定（原 L3，**不算设计层**） | 季度/年度结论用 `supervisor_report` 固化，后续读报告 | 把重复问题从 O(记录数) 降为 O(1) | 无（复用已有） |

最小实现路径：**先只做 `limit` + `order` + `context` 投影**（已证缺陷 + 使其生效），其余参数在实测阈值触发后再加。

## 5. 详细设计（L2）

### 5.1 操作契约

新增一个**面向主 Agent 的查询操作**（暂名 `event_query`，由 Extension 暴露为独立工具），返回形状恒定：

```json
{ "events": [SupervisorEventSummary], "total": 0, "truncated": false, "excludedWithoutTime": 0 }
```

参数：

| 参数 | 取值 | 缺省 | 说明 |
|---|---|---|---|
| `objectRef` | 稳定 UID | 无 | 建议始终指定容器；越权仍 403 `outside_scope` |
| `includeChildren` | boolean | false | 含子任务事件 |
| `limit` | 1–**200** 整数 | 50 | 与工具 schema 上限保持一致（现 schema 为 100，需同步改为 200） |
| `order` | `asc` / `desc` | `desc` | 见 §5.2 的 null 处理 |
| `types` | string[] | 无 | 允许词表取值 + 系统类型（`working_state`、`suggestion`）+ 已存事件的既有 `type`（避免历史类型不可查） |
| `since` / `until` | ISO 或 `YYYY-MM-DD` | 无 | 按 `occurredAt` 过滤；无 `occurredAt` 的事件**不静默丢弃**，计入 `excludedWithoutTime` |
| `view` | `summary` / `full` | `summary` | `summary` 返回显式类型 `SupervisorEventSummary`（见 §5.3） |

`event_list`（页面与 `event_get` 共用）行为**保持不变**：不传 `limit` 仍返回 `SupervisorEvent[]` 全量、升序；新参数只加在新工具上，不做同一操作的多态返回。

### 5.2 排序规则

- 显式比较器，两个方向都保证**无 `occurredAt` 的事件排在最后**；禁止“先升序再整体反转”，否则 null 会被顶到最前、挤占“最近 N 条”。
- 排序键顺序沿用现有实现（`occurredAt` → `recordedAt` → `id`）。
- `order=desc` 截断时才等于“最近 N 条”。

### 5.3 投影与类型

- `SupervisorEventSummary`（新共享类型）显式包含：`id / objectRef / objectSnapshot? / title / type / occurredAt / recordedAt / recorder? / participants / attachmentIds / version / source / interval?`。
- **不含** `description`、`originalReply`、`revisions`、`payloadHash`；需要细节时按 `id` 调 `event_get`（含图片）。
- 汇总视图是**独立类型**，不再“把完整 `SupervisorEvent` 摘字段”，避免必填字段缺失造成的隐式 union 与前端断言破坏。

### 5.4 `context` 分支（必须同时改）

- `supervisor_context`/`event_objects` 是主 Agent 的第一步，当前返回全部可见事件。
- 改动：`context` 返回的 `events` 也使用 `SupervisorEventSummary`，并按 `limit`（默认 50、`order=desc`）截断，附 `eventsTotal`/`eventsTruncated`；未授权对象照旧不可见。
- 或者（更省）配方改为“`supervisor_context` 只取对象 UID 与状态，事件一律走 `event_query`”；二选一，实现时取前者以免依赖模型自律。

### 5.5 授权顺序

顺序固定为：范围过滤（`visible()` / `selectEvents()`）→ `types`/时间过滤 → 排序 → 截断 → 投影。
`types`、区间、`limit` 都不会扩大可见集合；越权 `objectRef` 在授权外且无归档快照时返回 403 `outside_scope`（现有行为）。新参数不触达写路径（`record`/`correct`），不能绕过写入确认。
边界提示：`objectRef` 缺省时 `selectEvents` 返回“全部任务 + 全部归档对象”的并集；跨容器全局查询属预期行为，但 Skill 与工具描述必须说清它与对象模型的区别。

### 5.6 错误契约

| 场景 | 返回 |
|---|---|
| `types` 含词表外取值且非系统类型 | 400 `invalid_event_type`，消息列出允许值 |
| `limit` 非整数或超范围 | 400 `invalid_arguments` |
| `since`/`until` 格式非法或 `since > until` | 400 `invalid_arguments`（明确报错，不用空列表冒充正常） |
| `id` 与过滤参数同时提供 | **不报错**：`id` 优先，其余忽略（保持与现有 `event_get` 兼容，仅排序/截断参数对被忽略时报错会打断既有调用） |

### 5.7 改动点

- `shared/src/supervisor.ts`：`SupervisorEventSummary`、查询参数类型、`{events,total,truncated,excludedWithoutTime}` 视图类型。
- `backend/supervisor/service.ts`：新增查询分支（过滤/排序/截断/投影）；`context` 分支改用 summary + 截断；`types` 校验复用词表并放行系统类型。
- `backend/supervisor/store.ts`：可选最小观测（`load` 耗时与档案字节数），用于 §10 阈值；无观测则该阈值表删除。
- `backend/routes/supervisor.ts`：读取白名单加入新操作；写路径不变。
- `extensions/supervisor/index.ts`：新增查询工具（参数 + 恒定返回形状说明），`limit` 上限与设计一致（200）。
- `frontend/src/pages/EventLedgerPage.tsx`：不改（继续用 `events`，形状未变）。
- `agent/supervisor/skills/dashboard-supervisor/SKILL.md`：更新查询配方（§6）。
- `guide/{config,dashboard}.md`：说明新工具、截断语义与“未记录时间会被单独计数”。

### 5.8 结果复用（约定，非新代码）

- 每季度/年度末对该容器（`includeChildren`）生成一次 `supervisor_report`：类型分组计数、明确区间统计、覆盖范围、缺失项（含“未记录时间”条数）。
- 后续同类问题优先读报告；报告已带 `inputVersions` 与新鲜度警告，源事件被更正或新增会标记，无需重读原始事件。
- 报告不复制敏感原文，只留结论与来源引用。

## 6. 主 Agent 查询配方（写入 Skill）

1. `supervisor_context` 取容器 UID 与状态（事件明细走查询工具，不依赖 context 的事件列表）。
2. `event_query(objectRef=容器, includeChildren=true, types=[...], since/until=本季, order=desc, limit=50, view=summary)`。
3. 仅对需要的 `id` 执行 `event_get(includeImages=true)`（≤4 张/6 MiB），不批量取图。
4. 时长一律用 `supervisor_analyze`，不用消息间隔推算。
5. 结论落 `supervisor_report`，下次直接复用；`excludedWithoutTime > 0` 必须在结论里说明。
6. 写错类别会被拒（`invalid_event_type`）：需要新类别先与用户确认再改配置。

## 7. 兼容性与迁移

- 无数据迁移：不改存储格式与既有事件字段。
- 页面与既有测试：`events` 操作返回形状不变；新能力只在新增操作上。
- 既有历史事件类型不受词表影响；`correct` 时类型未变仍可用（已在实施记录验证）。

## 8. 验证计划

- 单元（`backend/__tests__/supervisor-service.test.ts` 等）：
  - `limit` 生效且 `total`/`truncated` 正确；`limit` 上限与 schema 一致（含 101–200 边界）；
  - `order=desc` 取到最近 N 条；**两个方向**下无 `occurredAt` 事件都排最后；
  - `types` 过滤：词表取值、系统类型（`working_state`/`suggestion`）、历史类型均可查；词表外取值报错；
  - `since/until` 边界、非法格式、`since > until` 报错；无 `occurredAt` 事件计入 `excludedWithoutTime`；
  - `view=summary` 不含 `description`/`originalReply`/`revisions`/`payloadHash`，字段集与 `SupervisorEventSummary` 一致；
  - `context` 分支同样投影并按默认 `limit` 截断，`eventsTruncated` 正确；
  - 缩小 `allowedObjects` 后组合过滤仍不泄漏越权对象；`id` 与过滤参数同传时 `id` 优先。
- 前端：`EventLedgerPage` 既有回归不变（监督 22 项）。
- Extension：新工具参数与极限值测试；`event_list` 保持数组解析。
- 通过门槛：上述全绿 + `npm run typecheck` + `docs:env-check`；不替代用户真实运行验收。

## 9. 不做与理由

- **全文/关键词索引**：要引入索引一致性、删除传播、权限过滤后可见性等问题，收益只是“少写一次 `type`”；个人量级不划算。
- **新增“个人日志”对象类型**：会破坏“事件挂在稳定对象上”的模型，连带影响范围授权、来源快照与归档读取。
- **同一操作按参数改变返回形状**：正确性会压在模型能否分辨两种形状上，且前端已有 `SupervisorEvent[]` 断言；改为新增恒定形状操作。
- **把 base64 图片放进档案**：现有独立附件文件设计更优，保持不变。

## 10. 何时进入下一层（阈值触发）

先加**最小观测**（`load` 耗时、`archive.json` 字节数）再谈阈值；无观测则本表不成立、应删除。满足任一条件再考虑按容器分片或月度 rollup：

- 单次读取延迟 > 300 ms；
- `archive.json` > 20–30 MB；
- 单月新增事件 > 1,000；
- 单容器事件 > 2,000。

在此之前，L2（最小实现）+ 报告约定足够。

## 11. 未决项

- 新操作命名（`event_query`）与工具名需与现有 14 工具命名风格统一后定稿。
- `context` 事件投影 vs 配方自律，取哪一种（本设计倾向投影）。
- 是否需要“只回类型分布、不列条目”的计数模式。
- 季度/年度报告模板是否固化字段（类型分组、区间、覆盖、缺失）待用户确认。

## 12. 评审结论与本版处理

独立评审（不同模型、只读核对 6 个文件）：**6 条现状声明全部与代码相符**；判定 **改后再实现**。逐条处理：

| 评审 finding | 本版处理 |
|---|---|
| [major] `context` 分支返回全量事件，L2 打不到实际流量 | 采纳：§2.2、§5.4、§5.7、§8 增加 context 投影/截断与用例 |
| [major] “仅传 limit 才改返回形状”是关键值控的多态契约 | 采纳：§5.1 改为新增恒定形状操作，`event_list`/页面不变 |
| [minor] `view=summary` 缺必填字段破坏类型契约 | 采纳：§5.3 定义独立 `SupervisorEventSummary` |
| [minor] limit 上限 200 与 schema 100 不一致 | 采纳：§5.1/§5.7 统一为 200，并在 §8 加边界用例 |
| [minor] `types` 会拒系统类型与历史类型 | 采纳：§5.1 读侧放行系统类型与既有 `type` |
| [minor] `order=desc` 与“null 排最后”自相矛盾 | 采纳：§5.2 显式 null-last 比较器，禁止整体反转 |
| [minor] `since/until` 静默漏计无时间事件 | 采纳：§5.1 增加 `excludedWithoutTime`，§6 要求在结论中说明 |
| [minor] 瓶颈未实测，可只做 `limit`+`order` | 采纳：§1、§4 增加最小实现路径 |
| [minor] L3 被抬成设计层 | 采纳：§4 降级为用法约定 |
| [minor] 阈值无埋点、不可测量 | 采纳：§10 以最小观测为前提，否则删表 |
| [minor] `id` + 过滤参数同传报错过严 | 采纳：§5.6 改为 `id` 优先、忽略其余 |
| [minor] 授权顺序无误（无越权风险） | 保留：§5.5 记录该结论与缺省并集的边界提示 |