# Pi Dashboard Token Usage

## Scope

统计 Dashboard 自建 slot 和 terminal/web/chatapp Live Session 的 Pi usage。只记录 token/cost 元数据，不记录 prompt、assistant 正文或工具输出。

## Persistence

默认账本目录：

```text
<agent dir>/token-usage/
├── 2026-09.jsonl
└── 2026-10.jsonl
```

一条记录对应一个 session entry，使用 `sessionFile#entryId` 去重；没有 session file 时使用 Live Session 的 process/session 标识和消息指纹。按记录时间和固定时区写入对应月份文件。费用来自 Pi 写入的 `usage.cost.total` 和本地模型价格配置，按 USD 估算。

## Sources

- Dashboard slot：从已知 `sessionFile` 在启动、session_file、agent_end 时回填/刷新。
- terminal Live Session：连接 snapshot 时回填 sessionFile，新的 assistant/toolResult `message_end` 事件实时记录。
- session 文件中的 assistant message 按 `provider/(responseModel || model)` 分组；compaction、branch summary、tool result 的额外 usage 归到 `Tools/summaries`。

## API/UI

```text
GET /api/usage?month=YYYY-MM
```

返回：

- `daily`：当月每天费用，包含 0 费用日期；
- `models`：按 provider/model 汇总；
- `sessions`：按 session 汇总；
- `total`：token、cache、费用总计。

前端 `/usage` 展示月度每日费用折线图、模型表和 session 表。

## 边界

- 日期使用 Dashboard 进程时区；
- provider 没有 usage 或价格配置时，不伪造费用；
- 不自动切换模型、不自动中断 session、不接供应商账单；
- Dashboard/Extension 重启后依靠账本和 session JSONL 去重恢复。
