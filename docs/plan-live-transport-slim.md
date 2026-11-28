# Live 传输瘦身：剥离 turn_end 冗余 context

## 问题

Live Session 快照/事件的体积被 `turn_end.data.context` 占满。该字段是 pi 的
`BoundaryContextPreview`（整份上下文前缀），**每个 turn 复制一次**。

实测（2026-11-28，本机 dashboard `:7777`，控制令牌拉取 `?compact=1`）：

| 会话 | 精简后体积 | `turn_end` 占比 | 其中 `context` |
| --- | --- | --- | --- |
| `da7d9f83…`  | 44.8 MB | 99% | 44.3 MB |
| `8eb73202…`  | 11.2 MB | 98% | 10.9 MB |
| `452c720c…`  | 4.5 MB  | 0%  | 0（该会话是内嵌图片） |
| `a9cf0dac…`  | 0.15 MB | 0%  | 0 |

`57875aae…`（10.3 MB，已关闭）另有完整拆解：47 个 `turn_end` 共 10.25 MB，
`contextEntries` 累计 4497 条但只有 169 个唯一 `sourceEntry.id` —— 同一份上下文
被复制约 26 遍。

**44.8 MB 远超 Android 单帧 16 MB 上限**（`LivePiRepository.kt:391`
`text.length > 16*1024*1024 → webSocket.cancel()`），表现为反复断链重连，
用户侧看到的就是「容量过大 / 响应超出大小限制」。

## 零消费证据（剥离不改变任何可见行为）

| 检查 | 结果 |
| --- | --- |
| 扩展内读 `turn_end.context` | 0 处 |
| `get_context` 命令数据源 | `contextViewJson(contextView(ctx))`，实时计算，不依赖 turn_end |
| Android `contextEntries`/`llmMessages`/`contextMessages` | 0 处 |
| 前端同上 | 0 处 |
| 后端同上 | 0 处 |
| `messageEntryId` / `toolResultEntryIds` / `outcome` / `continue` | 全仓 0 处消费 |

**但 `turn_end` 事件本身必须保留**：`frontend/src/test/liveToolEntries.test.ts:510`
用它作为活动边界标记。只剥 `data.context`，不删事件、不删 `turnIndex`。

## 三层修复

| 层 | 文件 | 作用 | 生效条件 |
| --- | --- | --- | --- |
| 1 | `backend/live-sessions/registry.ts` (`appendTimelineEvent`) | 所有客户端共用入口，剥离后存量+新增都瘦 | 重启 dashboard |
| 2 | `backend/live-sessions/compact.ts` | 兜底已部署的旧扩展（仍会发带 context 的事件） | 重启 dashboard |
| 3 | `pi-tsien-extension/.../index.ts:1283` | 源头不再发送 | 重启每个 pi 会话 |

第 3 层依赖 `extension-parity-baseline.json` 的 `turn_end` 计数断言同步更新，
且必须重启会话才对在线会话生效，因此排在最后。

## 验收标准

- `npm test`（vitest backend）全绿
- `npm run typecheck:backend` 通过
- 新增单测：含 `context` 的 `turn_end` 经 registry/compact 后 `data.context` 不存在，
  且 `turnIndex`、`message`、`toolResults` 仍在
- 真实体积对比：同一批会话 after/before，报出百分比
- 不触碰工作区既有未提交改动（`backend/asr-polish.ts`、`frontend/src/data/modelScores.ts`、`guide/*`）

## 基线（改动前，写入 `/tmp/pi-transport-fix/baseline.txt`）

```
452c720c… full=4651583  compact=4650190
a9cf0dac… full= 458865  compact= 155508
da7d9f83… full=46030244 compact=45767626
8eb73202… full=11778737 compact=11404768
```

## 进度

- [x] 调研根因、零消费证据、基线采集
- [ ] 第 1+2 层（backend）实现 + 测试
- [ ] 独立复核
- [ ] 第 3 层（扩展）实现 + parity 基线更新
- [ ] 用户执行 `./run.sh` 后复测体积