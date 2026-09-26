# Plan: Sessions Sidebar 改版（tag 可用性 + Pin + 两行密度）

Mockup: `docs/mockups/sidebar-tags-ui.html`（已确认）。
用户拍板：① tag **不**覆盖历史会话（只活动 slot）② **加** Pin 置顶 ③ 保留**两行密度**。

tag 后端已存在（`PATCH /api/chat/slots/:key/tags` + `pi-web-sessions.json` 持久化 + `slot_tags` SSE）。
本次唯一新增后端字段是 `pinned`。

## Slice 1 — 后端：pin 字段贯通（6 处小改）

| 文件 | 改动 |
|---|---|
| `backend/session-store.ts` | `SlotState.pinned?` / `SlotProcess._pinned?` / 两处 persist entry 写 `pinned` |
| `backend/pi-session.ts` | 基类元数据声明 `_pinned: boolean` |
| `backend/pi-sdk-session.ts` | opts + 字段 + ctor |
| `backend/pi-manager.ts` | `PiProcessOptions.pinned?` / `SlotInfo.pinned` / RPC ctor / `listSlots()` |
| `backend/server.ts` | restore 时回传 `pinned` |
| `backend/routes/chat.ts` | 新增 `PATCH /api/chat/slots/:key/pin`（broadcast `slots` + `slot_pinned` + `persistSlots`），照 tags 路由写法 |
| `backend/routes/jobs.ts` | `tags: ['job', id]` → `['job:'+id]`（系统 tag 命名空间） |

验收：`npm run typecheck`（backend）+ 一条 pin→重启持久化测试。

## Slice 2 — 前端 helpers（新文件 `frontend/src/pages/chat/sessionMeta.ts`）

- `tagColorClass(tag)`：hash → 主题 6 色（a/o/w/i/d/m），零配置
- `isSystemTag(tag)`：`job` / `system` / 含 `:` 前缀 → 隐藏、不入分组、不进候选
- `visibleTags(tags)` / `relTime(iso)`（`12m` `3h` `1d` `昨天` `MM-DD`）/ `projectName(cwd)`

## Slice 3 — 前端 ChatSidebar 重写行与交互

行（固定 2 行等高，标题 ellipsis，不再横向滚动）：
- line 1：状态（左沿 2px 色条 + 5px 点）· 标题 ellipsis · 相对时间 → hover 让位给 `⋯`
- line 2：tag 胶囊（≤2 + `+N`）· 项目名（分组模式为 project 时省略，避免重复）· Needs input / Stopping 文字内联 · workspace 徽章

交互：
- `⋯` 菜单：重命名（`PATCH /title`）/ 标签 / 置顶切换 / 在此目录新建 / 关闭（两步确认，不再一点即删）
- 标签编辑器：**已有 tag 联想补全 + 计数**，Enter/点击提交，Backspace 删末尾
- 置顶：`pinned` 会话在**任何分组模式下**先成一组 `📌 Pinned` 置顶，其余按所选模式分组
- tag 筛选条：聚合计数，点行上胶囊或条上 chip = 单选筛选，再点/`esc` 清除
- 分组模式：emoji `<select>` → 4 段 segmented control（localStorage key 不变）
- 主题化：`divide-white/10` → `var(--border)`；分组头 sticky + chevron；移动端 `⋯` 常显

兼容既有测试断言：`Filter sessions…` placeholder、`aria-label="New chat session"`、
`title="Waiting for approval"`、`title="Stopping"`、project 分组头文本唯一（line 2 在该模式下不重复项目名）。

## Verification

1. `cd frontend && npx vitest run src/test/ChatSidebar.test.tsx src/test/dashboardSlice.test.ts src/test/sessionMeta.test.ts`
2. `npm run typecheck`（backend）+ `npx tsc -b frontend`（build 前）
3. 后端 pin 往返：`backend/__tests__` 加一条断言（listSlots.pinned → saveSlotState → 读回）
4. 浏览器肉眼：由用户执行 `./run.sh`（agent 不重启服务）

## Out of scope

- 历史（已结束）会话的 tag 存储
- 拖拽排序、批量操作、tag 重命名/合并管理页


---

# As-built (2026-09-11)

三个 Slice 全部完成，无遗留。

## 改了什么

**后端（只为 Pin 服务，tag 沿用既有链路）**
- `backend/session-store.ts` — `SlotState.pinned` / `SlotProcess._pinned` + 两处 persist entry
- `backend/pi-session.ts` `backend/pi-sdk-session.ts` `backend/pi-manager.ts` — `_pinned` 字段、ctor、`SlotInfo.pinned`、transport 重建时保留
- `backend/server.ts` — 启动 restore 回传 `pinned`
- `backend/routes/chat.ts` — **新增 `PATCH /api/chat/slots/:key/pin`**（`broadcastSlots` + `slot_pinned` + `persistSlots`）
- `backend/routes/jobs.ts` — `['job', id]` → `['job:'+id]`，系统 tag 命名空间

**前端**
- `frontend/src/pages/chat/sessionMeta.ts`（新）— `isSystemTag` / `visibleTags` / `tagColorClass`（hash→5 色，零配置）/ `relTime` / `projectName` / `slotOrder` / `tagCounts`
- `frontend/src/pages/ChatSidebar.tsx`（重写行 + `SlotRow` / `RowMenu` / `TagChip`）
- `frontend/src/types/index.ts` `api/client.ts`（`pinSlot`）`store/dashboardSlice.ts`（`sseSlotPinned`）`hooks/useSSE.ts`（`slot_pinned`）

**行为**
- 两行等高（line1 标题 ellipsis + 相对时间 + `⋯`；line2 📌 / tag 胶囊 ≤2 + `+N` / needs input / 项目名 / workspace）
- 状态由「左沿 2px 色条 + 5px 点」表达，不再独占一行；分隔线走 `var(--border)`
- `⋯` 菜单：重命名 / 标签 / 置顶切换 / 在此目录新建 / 关闭（两步确认）
- 标签编辑带已有 tag 联想 + 计数 + 方向键选择；点 tag = 单选筛选，`全部` 清除
- 分组模式改成 segmented（Date/Project/Tag/Status，localStorage key 不变）；📌 Pinned 组永远置顶，正交于筛选
- 系统 tag（`job:*` / legacy `job`）不进胶囊、不进筛选条、不参与 tag 分组

## 顺手修掉两个真 bug（都由测试暴露）
1. 行 `onKeyDown` 未判 `e.target`，改名输入框里打空格会被行劫持成「切换会话」→ 加 `e.target !== e.currentTarget` 守卫。
2. tag 候选用 `onClick`，而输入框 `onBlur` 会先卸载编辑框 → 浏览器里点候选同样打不中；改为 `onMouseDown + preventDefault`（含 tag 的 × 删除按钮）。

## 验证
- `npm run typecheck`（backend）通过；`cd frontend && npx tsc --noEmit` 通过
- 后端：`npm test` → **18 files / 262 passed, 1 skipped**（含新增 `PATCH /pin` 3 条用例）
- 前端相关：`ChatSidebar.test.tsx`(14) + `sessionMeta.test.ts`(11) + dashboardSlice + apiClient → **全部通过**
- 前端全量：**620 passed / 7 failed**。已用干净 HEAD worktree 做基线对比：`App.test.tsx`（2）与 `LiveSessionFeatures`（1）在 HEAD 上同样失败；`liveToolEntries` / `ToolSummary` 两个文件在 HEAD 上**不存在**（属工作区未提交 WIP 新增）；`ToolCallBlock` / `ToolGroup` 在 HEAD 通过、失败源于同一批未提交 WIP 新加断言。即这 7 条与本次改动无关，未予处理。
- 未做：肉眼视觉确认（当前模型不支持读图）；示意图已同步为落地形态，见 `docs/mockups/sidebar-tags-ui.html`

## 生效方式
后端改动需用户自行执行 `./run.sh` 重启（agent 不代劳、不 kill 现有服务）。

## 明确未做（候选）
- 历史（已结束）会话的 tag 存储（用户决定不要）
- 紧凑模式（侧栏 <240px 时 tag 收成色点）
- 拖拽排序、tag 重命名/合并管理页


---

# Slice 4-6 · Live Pi Sessions 侧栏（2026-09-11，真正的目标）

用户澄清：要改的是 `/live-sessions` 左侧那条 **Live Pi Sessions** 列表（`LiveSessionsList.tsx`），
不是 `/chat` 的 slot 侧栏。上面 Slice 1-3 的成果保留（同一套语言），这一节把它落到 live 侧栏。

## 后端（新增，零协议改动）

| 文件 | 改动 |
|---|---|
| `backend/live-sessions/meta.ts` | 新增 `LiveSessionMetaStore`：`<agent dir>/pi/live-session-meta.json`，按 **pi `sessionId`**（不是 processInstanceId）存 `{tags, pinned, updatedAt}`；0700 目录 / 0600 文件 / temp+rename 原子写 / 串行写队列 —— 与 `groups.ts` 同构；空记录自动裁剪，脏文件不炸 |
| `shared/src/live-sessions.ts` | 新增 `LiveSessionMeta` 类型（**没有**改 `LiveSessionSummary`，protocolVersion 2 不动） |
| `backend/routes/live-sessions.ts` | `GET /api/live-session-meta`、`PATCH /api/live-sessions/:processInstanceId/meta`；复用 `requireAuth` + `requireMutationOrigin`；pid → sessionId 由 registry 解析 |

`normalizeTags`：小写、trim、去重、单 tag ≤32 字符、每会话 ≤12 个、**含 `:` 的用户输入直接丢**（防伪装系统 tag）。

## 前端

| 文件 | 改动 |
|---|---|
| `frontend/src/components/sessionMetaUi.tsx`（新） | `TagChip` / `TagEditor`（联想补全） / `RowMenu`（两步确认） 抽出共享，chat 与 live 两侧共用一份实现 |
| `frontend/src/pages/ChatSidebar.tsx` | 改为消费共享组件（删掉本地重复实现，约 -110 行）；行激活从 `onMouseDown` 改成 `onClick`（`onMouseDown` 只 preventDefault），这样 `fireEvent.click` / 触摸 / 辅助技术都可用 |
| `frontend/src/features/live-sessions/useLiveSessionMeta.ts`（新） | 拉取 + 乐观更新 + 失败回滚重取 |
| `frontend/src/features/live-sessions/api.ts` | `listMeta` / `patchMeta` |
| `frontend/src/features/live-sessions/LiveSessionsList.tsx` | 重写：两行等高、色条状态语言、搜索、tag 筛选条、📌 置顶成节、⋯ 菜单（重命名走 `set_session_name` / 标签 / 置顶 / 加入·移出任务 / 复制 sid）、分组行内改名 + 两步删除，去掉 `window.prompt` / `window.confirm` / 每节的 `<select>＋加入`；emoji 状态（💤🔨🔄）全部换成色条+点 |

live 状态语义映射（与 chat 侧栏刻意不同）：**idle = 活 Pi 的常态 → 保持安静**（只有小灰点），
running = accent 色条 + 呼吸点，reconnecting = warn 色条；🔒 接管标记保留。

## 验证

- `npx tsc -b --force`（frontend）**exit 0**
- 后端 `npm test`：**19 files / 276 passed, 1 skipped**（比上一轮 +14：`live-session-meta.test.js` 11 条 store + 3 条 HTTP，含 401 / 404 / 跨源 403 / 重启后从盘读回）
- 前端 `npx vitest run`：**629 passed / 7 failed**，失败的还是那 7 条既有 WIP 用例（App×2、LiveSessionFeatures、liveToolEntries、ToolSummary、ToolCallBlock、ToolGroup），已用 HEAD 干净 worktree 基线确认与本次无关；新增 `liveSessionsSidebar.test.tsx` 8 条全通过

## 一处需要记住的验证坑

`cd frontend && npx tsc --noEmit` 在这个仓库里**什么都不检查**（`tsconfig.json` 是 `files: []` + project references，真正的配置在 `tsconfig.app.json`，且开了 `strict` + `noUnusedLocals`）。
所以 Slice 1-3 里我报的「前端 typecheck 通过」是空跑。真实门禁是 **`npx tsc -b`**。这个空跑漏掉了
`LiveSessionsList` 里一个 `patch` 未解构的运行时错误（该错误被测试抓到了）。今后前端一律用 `npx tsc -b --force`。

## 保持未动（尊重工作区既有 WIP）

工作区里未提交的改动删掉了 live 侧栏的子 Agent 递归渲染和 ▸/▾ 折叠（子会话只剩「N 子」计数徽章）。
看起来是把子 Agent 挪去了新增的 `LiveSubagentPanel`，所以**我没有恢复递归渲染**，只保留了计数徽章。若这是误删，一句话我加回去。


---

# 追加 · 状态 emoji 回归（用户反馈）

用户反馈：emoji 看状态（工作中 / 等待输入）更直观 → **把状态 emoji 加回两个侧栏**，
其余改动（两行等高、色条、标签、置顶、搜索、⋯ 菜单、去掉 prompt/confirm）保留。

统一映射（chat 侧栏与 live 侧栏同一套语言）：

| 状态 | glyph | 色条 | 出现位置 |
|---|---|---|---|
| 等待输入（pending_approval / live idle） | ⚠️ / 💤 | live idle 不上色条；chat needs-input 上 warn | 行1 行首 |
| 工作中 | 🔨 | accent | 行1 行首 |
| **当前**会话正在跑 | 打字点动效（代替 🔨） | accent | 行1 行首 |
| 未读（跑完没看，chat） | 📬 | info | 行1 行首 |
| 停止中（chat） | ■ (danger) | danger | 行1 行首 |
| 重连中（live） | 🔄 | warn | 行1 行首 |
| 子 Agent 任务 | ⏳🔨✅⚠️⛔❔ | — | 行2 文案前 |

- emoji 带 `role="status"` + `aria-label`（「Session 状态：工作中」），文字标签仍留在第二行，读屏与扫读都不丢。
- 旧版 `needs input` 英文小标改成中文「等待输入」，与 live 侧栏一致。

## 验证（追加轮）

- `npx tsc -b --force` exit 0
- 前端 `npx vitest run`：**631 passed / 7 failed**（仍是同一批既有 WIP 失败，集合未变）
- 定向：`ChatSidebar`(14) + `liveSessionsSidebar`(10) + `sessionMeta`(11) + `liveSessionsUi`(5) = **40 passed**
- 示意图与 PNG 已同步（`docs/mockups/`）
