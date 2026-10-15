# 会话任务锚点（Session Task Anchor）

> 交互原型：`docs/mockups/session-todo-anchor.html`（4 个场景 × 现状/建议对照）
> 状态：已实现，待真人验收。

## 1. 解决什么

长会话跑久了，用户和 agent 都会忘记三件事：还剩哪些事、哪些已经做完、最初的要求是什么。

pi 核心**没有内置待办**（README 的 Philosophy 明确说不做）。用户环境里管这件事的是 `pi-tsien-goal` 扩展，它把目标写成会话记录里的
`customType: 'goal-state'` 条目，内容包括：目标原文、工作项（含状态）、验收标准、约束、阻塞项、来源文档、进度。

这些内容原本只在实时会话页的「目标」弹窗里能看到，而且**工作项藏在「更多详情」的折叠里**，等于看不到完成度。本改动只做「可见性 + 过期提醒」，不改数据产生方式。

## 2. 三个表面

| 位置 | 内容 |
|---|---|
| 会话右侧动作条「目标」按钮 | 角标显示 `已完成/总数`；有阻塞需要你处理或清单过期时变黄 |
| 「任务锚点」弹窗 | 目标原文 / 工作项（默认可见，带状态与依赖）/ 当前在哪一步 / 阻塞项（需要你处理的排在最前）/ 更多详情（验收标准、约束、来源文档）/ 更新于 + 同步按钮 |
| 会话列表行 | 小角标：`2/5`、`:x: 需核对`；没设目标的会话不画角标 |

历史会话（已结束、进程不在了）也能看：会话图谱页的节点详情里有「查看该会话的目标与清单」，走 `GET /api/session-goal?file=`。

## 3. 数据流与两处实现细节

```
pi-tsien-goal 扩展  →  会话记录里的 goal-state 条目
        ├── 实时：bridge 快照 → registry 缓存 anchor → summary.goal（角标）+ detail.goal（弹窗）
        ├── 实时：goal 保存 → 扩展事件总线 → bridge 去抖重推快照（进程加载了新代码时）
        ├── 实时：registry 每 5s 增量扫会话文件 → goal_changed 推给浏览器（不依赖会话进程新旧）
        └── 历史：GET /api/session-goal?file= → 直接读会话文件
```

1. **anchor 在 registry 里缓存**（`Entry.goal`）。不能只从 `entries` 窗口现算：registry 只保留最近 1000 条，bridge 还有字节预算，
   长会话会把自己早先的 `goal-state` 条目挤出窗口；那时若现算，页面会谎称「这条会话没有设目标」——恰好是最需要它的长会话场景。
   会话切换（`/clear`、`/ls-fork`）时清空缓存。
2. **快照增量只覆盖“会主动推”的进程**。已在跑的会话不会因为扩展代码变新而自动升级：会话中途新建（或替换）的目标要等重连/resync 才出现在快照里。
   所以 registry 另开一条兜底链路：`session-goal-tracker.ts` 按字节增量尾随每个会话文件（一次 `stat` + 只读新增字节），每 5s 跑一轮，
   新目标/进度/清空都由此发现；该路径用自己的 `goal_changed` 浏览器事件下发，不受快照 `revision` 门檻限制（revision 只在会话自己推快照时前进）。
   两条链路用 `goal-state` 条目时间戳去重：旧数据不允许覆盖新数据。
3. **解析逻辑放在 `shared/src/goal-anchor.ts`**，前后端共用一份：解析、`done/total/needsUser` 计数、过期判定、`messagesSinceUpdate` 计数。
   前端 `frontend/src/features/live-sessions/sessionGoal.ts` 只是一层改名兼容层（旧名字继续可用）。

## 4. 过期提醒（两条规则，都只是提示，不写数据）

| 规则 | 判定 | 文案 |
|---|---|---|
| `complete_with_open_items` | 目标状态是完成，但还有工作项没勾 | 「目标已标记「已完成」，但 N 个工作项还没勾选」 |
| `no_recent_update` | 还有未勾选的工作项，且最后一次目标更新之后的对话条数 ≥ 阈值 | 「工作项已 N 条以上对话记录没有更新」 |

阈值 `GOAL_STALE_MESSAGE_THRESHOLD = 300`，**来自本机真实数据**：抽查 46 个用过目标的会话文件，未再更新目标的会话其
`messagesSinceUpdate` 落在 119–1790，第一版设 15 会让几乎每个长会话都报警（狼来了），故调高。这是可以随时再调的常数，不是物理量。

**不做什么**：不替 agent 勾选、不改目标原文与验收标准、不在历史会话里放任何写操作。验收标准没有单条状态，弹窗里如实标注「只读展示，不伪造完成度」。

## 5. 涉及文件

| 文件 | 作用 |
|---|---|
| `shared/src/goal-anchor.ts` | 解析 + 计数 + 过期判定（新） |
| `shared/src/live-sessions.ts` | `LiveSessionSummary.goal`、`LiveSessionDetail.goal`（新增可选字段） |
| `backend/live-sessions/registry.ts` | 缓存 anchor，输出 `summary.goal` / `detail.goal`；每 5s 触发文件扫描并广播 `goal_changed` |
| `backend/live-sessions/session-goal-tracker.ts` | 增量尾随会话文件读 anchor（新） |
| `backend/live-sessions/session-goal.ts` | 从会话文件读 anchor（新） |
| `backend/routes/live-sessions.ts` | `GET /api/session-goal?file=` |
| `frontend/.../goal/GoalAnchorDialog.tsx` | 弹窗组件，实时与历史共用（新） |
| `frontend/.../LiveSessionFeatures.tsx` | 用共用组件替换原弹窗；按钮加角标 |
| `frontend/.../LiveSessionPage.tsx` | 传响应式 anchor；「让 agent 同步清单」 |
| `frontend/.../LiveSessionsList.tsx` | 列表行角标 |
| `frontend/.../graph/BranchDetailPanel.tsx` | 历史会话入口 |

## 6. 已知边界

- 「让 agent 同步清单」往会话里发一条固定提示词（用户点击才发），走已有的 `input` 命令通道；busy 时禁用。
- 超大会话文件只读尾部 16 MiB，返回 `partial: true`，弹窗里如实说明「更早的历史没有读取」。实测抽查的文件大多命中这个窗口。
- 过期的第二条规则只是启发式：它无法区分「agent 忘了更新」和「工作项确实还没做完」。