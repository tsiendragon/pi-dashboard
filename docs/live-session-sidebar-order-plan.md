# Plan: Live Pi Sessions 侧栏手动排序（拖动 + 稳定顺序）

用户拍板（2026-09）：
1. 目标是 Live Pi 页左侧 **Live Pi Sessions**（`LiveSessionsList.tsx`），不是 Chat 页的 slot 侧栏。
2. 新 session 落在**底部**。
3. **允许跨分组拖动**，拖过去就自动改该 session 的分组归属。

## 现状（为什么要改）

| 位置 | 现在的规则 | 问题 |
|---|---|---|
| 行内顺序 | `sortSessions()` 按 `startedAt` 升序 | 老 session 一退出，下方所有行整体上移，用户正要点的那行漂走 |
| 分组块顺序 | 按「组内最早 session 的 startedAt」 | 组块随成员生死整块换位置 |
| Pi 重启 | 新的 `processInstanceId` + 新的 `startedAt` | 同一会话换位置，找不回来 |

## 设计

**顺序数据**：新增服务器端顺序表，key = pi `sessionId`（跨 Pi 重启稳定，与 tags/pin 一致），一个 JSON 文件 + 整表 PUT。

**排序规则**（全部稳定，不再看活跃/生死）：
1. 置顶块永远第一 → 用户任务分组（按创建顺序）→ 未分组永远最后。**不再按 startedAt 排分组块。**
2. 块内顺序 = 顺序表下标；不在表里的（新 session、没拖过的）按 `startedAt` 升序接到**块尾**。
3. 筛选/搜索只过滤，不重排。

**交互**：
- 拖动：原生 Pointer Events（零依赖），整行可拖 + 4px 阈值（阈值内仍是点击选中）。插入线为 2px accent。
- 跨块拖动：用现有 `POST /api/live-session-groups/:id/members`（服务端会自动把它从其它组移除）/ `DELETE .../members/:sessionId`；拖入/拖出置顶块 = 切换 `pinned`。
- 菜单兜底（触屏/键盘必须能用）：`⋯` 里加 `↑ 上移` / `↓ 下移` / `⤒ 移到本组顶部`，只在块内移动，边界处不显示。
- 侧栏底部提示行加「↺ 恢复自动排序」= 清空顺序表。

**已知边界（写进交接）**
- 触屏不做拖动（`touch-action` 冲突会让列表无法滚动），用菜单；台式/鼠标/触控笔可拖。
- 空分组不渲染，所以拖不进空分组；空分组仍可用 `⋯ → 加入「X」`。
- 顺序表上限 1000 条，超出截掉尾部（尾部条目退化成自动排序，无害）。

## Slice

1. **后端**：`backend/live-sessions/order.ts`（`LiveSessionOrderStore`，照 `groups.ts` 的 0700/0600 + tmp+rename + 串行写队列）+ 路由 `GET/PUT /api/live-session-order`。
2. **前端纯函数**：`features/live-sessions/sessionOrder.ts`（`buildOrderIndex` / `sortSessions` / `moveInOrder`）+ `useLiveSessionOrder.ts` + `api.ts` 两个方法。
3. **前端交互**：`LiveSessionsList.tsx` 接顺序表、改分组块排序、拖动、菜单项、恢复按钮。
4. **测试**：后端 store 往返 + 路由 403/归一化；前端纯函数单测；`liveSessionsSidebar.test.tsx` 扩菜单移动与恢复按钮（jsdom 没有 `elementFromPoint`，拖动几何只测纯函数，浏览器里人工验收）。

## Verification

1. `cd frontend && npx vitest run src/test/sessionOrder.test.ts src/test/liveSessionsSidebar.test.tsx`
2. `npm run typecheck`（backend，根目录 `tsc`）与 `cd frontend && npx tsc --noEmit`
3. `npx vitest run`（backend 的 live-session-order 测试）
4. 浏览器人工验收拖动/跨组：由用户执行 `./run.sh`（agent 不重启服务）

---

# As-built (2026-09)

四个 Slice 全部完成。

## 改了什么

**后端**
- `backend/live-sessions/order.ts`（新）— `LiveSessionOrderStore`（`{version:1, order:string[]}`，key = `sessionId`，
  `/mnt/workspace/lilong/agent/pi/live-session-order.json`，可用 `PI_DASH_LIVE_SESSION_ORDER` 覆盖，
  0700/0600 + tmp+rename + 串行写队列）；`normalizeOrder` 去重、去空、上限 1000 条。
- `backend/routes/live-sessions.ts` — `GET /api/live-session-order`、`PUT /api/live-session-order`（整表替换，
  照 `requireMutationOrigin` + `requireAuth` 惯例），store 接入 `start()` 生命周期。
- `backend/__tests__/live-session-order.test.js`（新）— store 往返 / 上限 / 损坏文件 / 路由 401、403、非数组载荷。

**前端**
- `features/live-sessions/sessionOrder.ts`（新，纯函数）— `sortSessions`（手动下标优先，未上榜的按 `startedAt` 接尾巴）、
  `materializeOrder`（把「当前显示顺序」并入顺序表，没拖过任何行的用户也能按锚点插入）、`moveInOrder`（只动被拖的 id）、
  `resolveDropTarget`（从 DOM 解析落点：行上半 → 之前，下半 → 之后，块本身 → 末尾）。
- `features/live-sessions/useLiveSessionOrder.ts`（新）— 顺序表加载/乐观保存/回滚 + 「恢复自动排序」。
- `features/live-sessions/api.ts` — `listOrder` / `saveOrder`。
- `features/live-sessions/LiveSessionsList.tsx` — 接入顺序、**分组块顺序固定为 置顶 → 任务组（创建序）→ 未分组**、
  原生 pointer 拖动（4px 阈值，拖完吞一次 click）、跨块拖 = 改分组 / 切置顶、`⋯ 菜单 ↑/↓/⤒`、
  底部「排序：手动 / ↺ 恢复自动排序」。

**测试**
- `frontend/src/test/sessionOrder.test.ts`（新，20 条）— 排序、物化、移动（含越界、空块、没拖过的新 session）、落点解析。
- `frontend/src/test/liveSessionsSidebar.test.tsx` — 新增 6 条：读取已存顺序、未拖过的接尾、菜单上移并落库、
  移到本组顶部 + 边界不显示移动项、恢复自动排序、任务组块排在未分组之前且成员操作不回归。

## 验证结果

- `cd frontend && npx tsc --noEmit` → 0 错；`npm run typecheck`（backend）→ 0 错；`npx eslint src/features/live-sessions ...` → 0 问题。
- `npx vitest run`（frontend 全量）→ 664 条：657 passed / 7 failed；
  这 7 条（App branding/health、LiveSessionFeatures、ToolCallBlock、ToolGroup、ToolSummary、liveToolEntries）
  已在 HEAD 的干净 worktree 里复现（同 7 条失败），属既有 UI 文案漂移，与本次改动无关。
- `npx vitest run --config vitest.backend.config.js` → 22 文件 / 295 passed / 1 skipped / 0 failed。

## 还没验的（需人工）

- 真实拖动几何：jsdom 没有 `elementFromPoint`，拖动手感、插入线位置、跨块拖动需要在浏览器里确认（前端已构建才生效）。
- 触屏：按设计不支持拖动（`touch-action` 与滚动冲突），用 `⋯` 菜单。
- 空分组：分组为空时不渲染区块，拖不进去，仍可用 `⋯ → 加入「X」`。