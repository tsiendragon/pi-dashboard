# 「清空」（/clear）后保住 session 在左侧 sidebar 的位置

用户提问（2026-09）：Live Pi 页点右侧栏「清空」后，能否让该 session 在左侧 **Live Pi Sessions**
侧栏里的位置保持不变。

状态：已实现（待浏览器人工验收）

## 根因（已求证）

侧栏的三份组织数据全部按 pi `sessionId` 存：

- 手动顺序：`backend/live-sessions/order.ts`（`LiveSessionOrderStore`）
- 分组归属：`backend/live-sessions/groups.ts`（`LiveSessionGroupStore`）
- 标签 / 置顶：`backend/live-sessions/meta.ts`（`LiveSessionMetaStore`）

「清空」= 给 pi 发 `/clear` 文本（`LiveSessionFeatures.tsx` → `LiveSessionPage.clearSession()`
→ `dispatch(input "/clear")`）。pi 收到后**在同一个进程里开启新 session**：

- `pi-tsien-extension/extensions/live-session.ts` 的 `pi.on("session_start")` 重建 projector
  并重发 hello / snapshot，`sessionId = ctx.sessionManager.getSessionId()` 变成**新值**；
- `backend/live-sessions/registry.ts` 已识别这件事（`sessionChanged` → 清 lease + 广播），
  但**没有迁移任何按 `sessionId` 存的侧栏数据**。

结果：行还挂在同一个 `processInstanceId` 上（React key 不变），但新 `sessionId` 在顺序表里不存在，
于是掉回块尾的 `startedAt` fallback；同时分组、标签、置顶一起丢。用户看到的就是「位置维持不住」。

## 方案

在**行身份（`processInstanceId`）与存储键（`sessionId`）的配对发生变化**的那一层修，一次覆盖三条路径
（同 entry 重连、entry 被拆掉后重建、`/ls-fork` 原地切会话）：

1. 三个 store 各加 `rekey(from, to)`：内存里原位搬家（顺序保留下标、meta 搬 entry、分组补成员并去重），
   然后走各自的 `persist()`（0700/0600 + tmp+rename + 串行写队列），原有不变量不变。
2. `LiveSessionRoutes` 记住 `processInstanceId → sessionId`；`attached` / `snapshot` 广播里发现同一进程
   换了 `sessionId`（`followSessionSwitch`）就把三个 store 一起 `rekey`。失败只打日志，
   不阻塞会话本身的广播。
3. 前端 `LiveSessionsList` 同样按 `processInstanceId → sessionId` 记住上一次的值；一旦发现同一进程换了
   `sessionId`，就重新拉 meta / order / groups（否则浏览器内存里仍是旧 id，行照样掉到块尾）。

不新增浏览器协议消息、不改排序规则；`/ls-fork`（同一进程原地切到分叉会话）走同一条路径，同样受益。

### 连带修复：换会话时快照游标不再互相踩

`/clear` 在 pi 里是 `session_start` 事件、`reason: "new"`（`agent-session-runtime.js:165`）。
extension 对 fork 以外的 reason 会**拆掉并重建 client**（`pi-tsien-extension/extensions/live-session.ts`），
新 projector 的 `revision`/`sequence` 从 1/0 重来，而 registry 里的游标还是旧会话的计数，
`snapshot.revision <= entry.revision` 会把新会话的第一张快照直接丢掉 → 行先卡在「重连中」，
要等新会话累积的事件数超过旧游标才重新对齐（旧会话跑得越久越久）。

修法：只在「本张快照的 `sessionId` 与 entry 现有 `sessionId` 不同」（= 真换了会话）时跳过游标判断，
其余情况仍然按 revision 去重。安全性：快照先过 `requireConnection`（transport 必须是当前连接），
被替换掉的旧连接无法把旧会话推回来（已加测试）。

## 验证

- 本地探针（临时脚本，已删）：修改前 `accepted(B rev1) = false`、`visible sessionId = session-a`（卡住）；
  修改后同场景接受并切到 `session-b`。
- 后端全量：`npx vitest run --config vitest.backend.config.js` → **31 文件 / 409 passed / 1 skipped / 0 failed**；新增：
  - order store：`rekey` 原位搬家 / 幂等（未知 id、同 id、目标已存在）
  - meta store：`rekey` 带走 tags+pin / 幂等
  - 路由：`snapshot` 事件换 sessionId → 三个 store 全部跟着换键
  - registry：换会话的第一张快照（revision 回到 1）被接受、同会话重复快照仍被拒、旧连接推不回旧会话
- `frontend`：`src/test/liveSessionsSidebar.test.tsx`（22 passed）新增「同一 Pi 原地换 session 触发重拉」；
  `npx eslint` 0 issue；`npx tsc --noEmit` + 根 `npm run typecheck` 0 错。
- `frontend` 全量：789 passed / 5 failed —— 5 条属既有 UI 文案漂移
  （App branding/health、ToolCallBlock、ToolSummary、liveToolEntries），与本次改动无关。

## 还没验的（需人工）

- 真实浏览器验收：点「清空」后行应停在原位（位置 / 分组 / 标签 / 置顶都不变），且不再长时间「重连中」。
  由用户执行 `./run.sh` 生效（agent 不重启服务）。