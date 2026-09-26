# Lark Channel Gateway — Tech Design

- **状态**：Accepted（B 模式：多套配置、单账号启用；配置由 dashboard 管理）
- **涉及仓库**：`<pi-dashboard repo>`（新增 `channels/lark/`）
- **相关工作**：`docs/live-session-multi-endpoint-tech-design.md`（`chatapp` 通道来源）
- **信任模型**：内网 / tailnet；不暴露 dashboard 到公网

---

## 1. 目标与非目标

### 1.1 目标

让 Lark（飞书）群 / 私聊成为 pi-dashboard `live-session` 的**又一个端点**，实现双向通道：

- **出口**：订阅 live-session 事件流 → 把 agent 正文渲染成 Lark 消息
- **入口**：Lark 消息 → `POST /api/live-sessions/:id/commands`（`channel: 'chatapp'`）
- 支持**多个 live-session** 通过绑定关系分别使用 Lark

### 1.2 非目标（本期）

- 不改动 pi-dashboard 后端协议（复用现有客户端通道）
- 不做多平台（Telegram / WeChat）——但架构须为它们留位
- 不做脱离 WebView 的原生 App（另议）
- 不做公网暴露 / webhook

---

## 2. 架构

网关是「**又一个浏览器客户端**」：使用与 web 前端完全相同的公开通道，因此 dashboard 后端零改动。

```
Lark 云  ⇄  [channels/lark 网关进程]  ⇄  pi-dashboard
             │  auth:  POST /api/live-sessions/auth {token}      → cookie(pi_live_session)
             │  订阅:  POST /api/live-sessions/ws-ticket          → WS /api/live-sessions/ws?ticket=
             │  列表:  GET  /api/live-sessions
             └  入口:  POST /api/live-sessions/:id/commands       {type:'input', text, channel:'chatapp'}
```

数据流：

```
入站: Lark 消息事件 → Mapping.match(chatId) → sessionRef → 解析 processInstanceId → sendInput()
出站: WS frame(live_session_event, message_end, assistant) → Mapping.match(sessionRef) → Lark 发送
```

---

## 3. 协议契约（复用现有）

### 3.1 认证

| 项 | 值 |
| --- | --- |
| 令牌文件 | `~/.pi/agent/run/pi-dashboard/live-control-token`（64 hex） |
| 换取 cookie | `POST /api/live-sessions/auth` body `{ token }` → `Set-Cookie: pi_live_session=<hex>` |
| Origin 要求 | 请求 `Origin` 的 host 必须匹配 `Host`（`isOriginAllowed`）；网关设 `Origin = dashboardBaseUrl` |
| cookie 有效期 | 12h（过期后重新登录） |

### 3.2 订阅（出口）

1. `POST /api/live-sessions/ws-ticket`（带 cookie）→ `{ result: { ticket, expiresAt } }`（TTL 30s）
2. `WS /api/live-sessions/ws?ticket=<ticket>`（带 cookie + Origin）
3. 收到的帧（`LiveSessionBrowserEvent`）：

| frame.type | data | 用途 |
| --- | --- | --- |
| `live_session_attached` | `{ sessions: LiveSessionSummary[] }` | 初始化会话目录 |
| `live_session_snapshot` | `LiveSessionDetail` | 某会话的 entries 全量 |
| `live_session_event` | `{ processInstanceId, event: { type, data } }` | 增量事件（见 §6） |
| `live_session_claim_changed` | — | 租约变化（网关不 claim，忽略） |
| `live_session_reconnecting` / `detached` / `error` | — | 状态处理 |

### 3.3 列表

`GET /api/live-sessions` → `{ sessions: LiveSessionSummary[], browserClientId }`

`LiveSessionSummary` 关键字段：`processInstanceId`（**易变**）、`sessionFile`（**持久**）、`sessionName`、`cwd`、`status`、`role`。

### 3.4 入口

`POST /api/live-sessions/:processInstanceId/commands`
body `{ command: { type: 'input', text, channel: 'chatapp', images?, deliverAs? } }`

- 需 `Origin` + cookie
- 多端并发消息进入**同一条 FIFO 串行队列**（已有保证）

---

## 4. 组件设计

```
channels/lark/
  README.md              方案与运行说明（已存在）
  PLAN.md                实施清单
  tsconfig.json          独立类型检查（已存在）
  src/
    config.ts            配置（已存在）
    dashboardClient.ts   认证 + 订阅 + 发命令（已存在）
    probe.ts             连通性探针（已存在）
    mapping.ts           chat ↔ session 绑定（持久化）
    catalog.ts           会话目录（list + 实时更新 + 稳定标识解析）
    render.ts            事件 → Lark 文本 / 卡片
    commands.ts          /list /bind /new /switch /unbind /status
    larkAdapter.ts       Lark 长连接收发（SDK 封装，接口化）
    gateway.ts           编排：连接 dashboard、路由入站/出站
    index.ts             入口 + 单实例锁
```

职责：

| 模块 | 职责 | 关键接口 |
| --- | --- | --- |
| `config.ts` | 读取 env → 配置对象 | `loadConfig()` |
| `dashboardClient.ts` | dashboard 通道 | `login()` `listSessions()` `sendInput()` `subscribe()` |
| `catalog.ts` | 维护会话目录；`sessionFile` → 当前 `processInstanceId` 解析 | `upsert(summary)` `resolve(ref)` `list()` |
| `mapping.ts` | 绑定表：`{platform, chatId} ↔ sessionRef` | `bind()` `unbind()` `lookupByChat()` `lookupsBySession()` |
| `render.ts` | 事件 → 文本；长消息分片 | `renderEvent(event, summary)` |
| `commands.ts` | 解析并执行管理命令 | `handle(text, ctx)` |
| `larkAdapter.ts` | Lark 侧收发（长连接） | `start(onMessage)` `sendText(chatId, text)` |
| `gateway.ts` | 编排与路由 | `start()` |
| `index.ts` | 启动 + 单实例锁 | — |

---

## 5. 会话映射（多 session 的核心）

### 5.1 绑定键：稳定标识

**不能**用 `processInstanceId`（pi 重启即变）。绑定使用：

- **机器主键**：`sessionFile`（pi 会话文件路径，持久）
- **人类可读名**：`sessionName`（`set_session_name`）

绑定记录形如：

```jsonc
{
  "version": 1,
  "bindings": [
    {
      "platform": "lark",
      "chatId": "oc_xxx",            // 群 / 私聊
      "threadId": null,               // 话题群时使用，默认 null
      "sessionFile": "/.../xxx.jsonl",
      "sessionName": "kyc-llm",
      "boundAt": "2026-09-18T..."
    }
  ]
}
```

持久化：`~/.pi/agent/run/pi-dashboard/lark-mapping.json`（原子写 + schema 版本）。

> 注意：`sessionFile` 在部分 session 上可能缺失（`LiveSessionSummary.sessionFile` 可选）。缺失时降级用 `sessionName`，两者都缺则拒绝绑定并提示。

### 5.2 映射模式

| 模式 | 形态 | 说明 |
| --- | --- | --- |
| **① 一群一会话（默认）** | 1 个 chatId ↔ 1 个 sessionFile | 最简单，零歧义 |
| ② 一群多话题 | `(chatId, threadId)` ↔ sessionFile | Lark 话题群；本期预留 `threadId` 字段 |

### 5.3 孤儿绑定清理

- 目录刷新时，若某绑定的 `sessionFile` 不再出现：标记 `stale`，入站消息回复「该会话已结束」并建议 `/bind`
- 提供 `/unbind` 与 `/list` 让用户自行修正

---

## 6. 输出渲染（「只看正文」）

### 6.1 pi 事件类型（`live_session_event.event.type`）

`agent_start`、`message_start`、`message_update`、`message_end`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`。

### 6.2 发送策略（默认 = 精简，对齐手机端「精简阅读」）

| 事件 | 默认行为 |
| --- | --- |
| `message_end`（role=`assistant`） | **发送正文**（核心） |
| `message_update` | 忽略（可选节流流式，本期不做） |
| `tool_execution_*` | 忽略（可选 `/verbose` 模式发一行摘要） |
| `message_end`（role=`user`） | 忽略（回显由 Lark 自己负责） |
| `agent_start` | 可发「🤔 思考中…」占位（可选） |

正文提取复用前端 `LiveSessionPage.tsx` 的 `messageFromEntry` 等价逻辑：从 `content` parts 中取 `text` 部分，跳过 `thinking` / `toolCall`。

### 6.3 长消息分片

Lark 单条文本消息有长度上限。`render.ts` 按上限安全切分（不切断 UTF-8 / markdown 代码块边界优先），按序发送。

### 6.4 （后续）交互卡片

`extension_ui` 请求（confirm / select / input）可渲染成 Lark 卡片按钮，回传 `answer_ui`。本期不做，架构预留。

---

## 7. 命令设计（入站路由）

入站消息先判命令，否则当作 prompt 发给绑定的 session。

| 命令 | 行为 |
| --- | --- |
| `/list` | 列出全部 live-session（名 / 状态 / cwd / 是否已绑定） |
| `/bind <name\|index>` | 把当前 chat 绑到指定 session |
| `/new [cwd]` | `POST /api/live-sessions/start` 新建 session 并绑定 |
| `/switch <name\|index>` | 切换当前 chat 的绑定 |
| `/unbind` | 解除当前 chat 的绑定 |
| `/status` | 显示绑定、连接状态、dashboard 版本信息 |

> `/new` 依赖 `POST /api/live-sessions/start`（`{ cwd, title?, model?, thinkingLevel? }`），需确认已注册且可用。

---

## 8. 认证、安全与单实例

1. **令牌**：网关读取本地 control token 换 cookie；token 文件权限校验由 dashboard 侧负责。
2. **Origin**：所有请求与 WS 握手带 `Origin = dashboardBaseUrl`，满足 `isOriginAllowed`。
3. **单实例锁**：Lark 长连接同一 app **只能有一个 listener**（eagleeye_bot runbook 的硬约束）。`index.ts` 用锁文件（`~/.pi/agent/run/pi-dashboard/lark-gateway.lock`，`flock`）保证单实例；重复启动直接退出并提示。
4. **访问控制**：至少支持 `LARK_ALLOWED_USER_IDS` 白名单；未授权用户消息直接忽略（不进入 session）。
5. **不暴露公网**：长连接模式为出站连接，dashboard 仍在内网 / tailnet。

---

## 9. 配置与运行

### 9.1 账号配置（dashboard 管理，推荐）

在 dashboard **Settings → Lark** 里新增账号（App ID / App Secret）、测试连接、启用、删除。

- 存储：`~/.pi/agent/run/pi-dashboard/lark-accounts.json`（`0600`）
- 支持多套配置，**同一时刻只有一个启用**（B 模式）
- 切换启用后网关 `fs.watch` 热更新，**无需重启**
- 读接口不返回明文 secret（仅 `••••尾号`）；提交脱敏值表示不修改
- 后端 API 与网关共用该文件（gateway 为只读消费者）

### 9.2 运行

```bash
npm run lark:probe   # 探针：只验证 dashboard 通道
npm run lark:dev     # 网关：有启用账号即接 Lark，否则 stdio 本地模式
```

环境变量 `LARK_APP_ID` / `LARK_APP_SECRET` 作为后备（未做 dashboard 配置时使用）。

> 按仓库 `AGENTS.md`：常驻服务的启动/重启由**用户**执行；本网关同理，agent 只交付代码与启动命令。

env：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_LIVE_URL` | `http://127.0.0.1:${PI_DASH_PORT:-7777}` | dashboard 地址 |
| `PI_LIVE_CONTROL_TOKEN_PATH` | `~/.pi/agent/run/pi-dashboard/live-control-token` | 令牌 |
| `PI_LARK_MAPPING` | `.../lark-mapping.json` | 绑定持久化 |
| `PI_LARK_ACCOUNTS` | `.../lark-accounts.json` | 账号配置（与后端共用） |
| `LARK_APP_ID` / `LARK_APP_SECRET` | — | 飞书自建应用 |
| `LARK_ALLOWED_USER_IDS` | 空 = 不限制 | 用户白名单 |

依赖：`@larksuiteoapi/node-sdk`（长连接 + 消息收发）。安装到 repo（`channels/lark/package.json` 或根 `package.json`）需确认。

---

## 10. 外部前置（阻塞项）

1. **飞书自建应用** + `App ID` / `App Secret`
2. 开启**长连接事件订阅**，订阅 `im.message.receive_v1`
3. 机器人能力 + 发消息权限（`im:message`、`im:message:send_as_bot`）
4. **已决策**：新建**独立自建应用**（避免与 `okx_ai_eagleeye_bot` 撞「同一 app 单 listener」）；账号在 dashboard **Settings → Lark** 配置

---

## 11. 分阶段实施与验收

| 阶段 | 内容 | 验收 | 状态 |
| --- | --- | --- | --- |
| **M0 通道核心** | config / dashboardClient / probe | typecheck 0 错误；探针收到 attached + snapshot + 实时 event | ✅ 已完成 |
| **M1 目录+映射+命令** | catalog / mapping / commands（**无需 Lark 凭证**）；提供 CLI 模拟 IM | 本地 CLI 能 `/list`、`/bind`、发消息进 session、绑定持久化 | ✅ |
| **M2 渲染** | render（事件→文本 + 分片） | 单测：给定 message_end 事件产出正确正文与分片 | ✅ |
| **M2.5 配置管理** | dashboard「Lark」tab + 后端存储/API + 网关读配置热更新 | 设置页可增删改/启用/测试；网关切换账号免重启 | ✅ |
| **M3 Lark adapter** | larkAdapter（长连接收发）/ gateway / index（单实例锁） | 真实 Lark 群收发一条消息往返成功 | ⬜ |
| **M4 加固** | 去重、重连、白名单、限流、错误处理 | 断线重连；重复事件不重复发送；未授权用户被忽略 | ⬜ |

---

## 12. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| `processInstanceId` 重启变化 | 绑定用 `sessionFile`；运行时实时解析到当前 id |
| 事件重投导致重复发送 | 按 `(processInstanceId, sequence)` / `message_end` 去重 |
| 单一 Lark app 多 listener 冲突 | 独立新应用 + 单实例锁 |
| Lark 消息长度上限 | `render.ts` 分片 |
| cookie 12h 过期 | 401 自动重新登录 |
| 多端并发输入乱序 | 依赖 dashboard 已有 FIFO |
| 长正文刷屏 | 默认只发 `message_end`，工具/思考不上屏 |

---

## 13. 已决策

| 问题 | 决策 |
| --- | --- |
| Lark 应用 | **新建独立自建应用** |
| 技术栈 | TypeScript + `@larksuiteoapi/node-sdk`（动态加载） |
| 账号模式 | **B：多套配置、单账号启用** |
| 映射模式 | 一群一会话（预留话题群 `threadId`） |
| 依赖位置 | 根 `package.json` |
| 配置方式 | dashboard **Settings → Lark**（本机文件 `0600`，网关热更新） |
