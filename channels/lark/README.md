# pi-lark channel gateway

把 Lark（飞书）群 / 私聊接成 pi-dashboard `live-session` 的又一个端点。

- **出口**：订阅 `live-session` 事件流 → 渲染成 Lark 消息
- **入口**：Lark 消息 → `POST /api/live-sessions/:id/commands`（`channel: 'chatapp'`）

## 设计原则

1. **不改 dashboard 后端**：网关使用与 web 前端完全相同的客户端通道（cookie 认证 + WS 订阅 + commands）。
2. **复用同一抽象**：所有 IM 都是「一个输入通道 + 一个事件流」，Lark 只是第一个 adapter。
3. **绑定键用稳定标识**：`sessionFile`（持久）而非 `processInstanceId`（重启会变）。

## 通道协议（复用现有）

| 步骤 | 请求 |
| --- | --- |
| 认证 | `POST /api/live-sessions/auth` body `{ token }` → `Set-Cookie: pi_live_session=...` |
| 换票 | `POST /api/live-sessions/ws-ticket`（带 cookie）→ `{ result: { ticket } }` |
| 订阅 | `WS /api/live-sessions/ws?ticket=...`（带 cookie + 匹配 Origin） |
| 列表 | `GET /api/live-sessions` → `{ sessions: LiveSessionSummary[] }` |
| 发消息 | `POST /api/live-sessions/:processInstanceId/commands` body `{ command: { type:'input', text, channel:'chatapp' } }` |

`token` 来自 `~/.pi/agent/run/pi-dashboard/live-control-token`。

## 需要的外部依赖

只需要 **App ID** + **App Secret** 两个值。不需要配 API 地址、回调 URL、Verification Token、Encrypt Key —— 因为采用**长连接**模式，事件由网关主动连出去拉取。

> ⚠️ **平台必须选对**：飞书（中国，`open.feishu.cn`）与国际版 Lark（`open.larksuite.com`）是两套开放平台、两套凭证。**长连接按域隔离**——用错域会报 `1000040351 Incorrect domain name`。注意：REST 调用（换 token 等）在两个域都能成功，所以设置页的「测试」**可能仍是绿的**，具有迷惑性。平台在 Settings → Lark 里选择。

## 飞书开放平台配置步骤

1. 打开 [飞书开放平台](https://open.feishu.cn/app) → 开发者后台 → **创建企业自建应用**
2. **凭证与基础信息** → 复制 `App ID` / `App Secret`（Secret 注意不要带多余空格）
3. **添加应用能力** → 添加**机器人**
4. **权限管理** → 添加权限：
   - 「获取与发送单聊、群组消息」(`im:message`)
   - 「以应用的身份发消息」(`im:message:send_as_bot`)
   - 群聊接收还需「接收群聊中@机器人消息事件」相关权限
5. **事件与回调** → 订阅方式选 **「使用长连接接收事件」** → 添加事件 **`im.message.receive_v1`**（可选：**`im.chat.member.bot.added_v1`**，用于入群时自动发用法提示）
6. **版本管理与发布** → 创建版本 → 申请发布 → 管理员审核通过（未发布权限不生效）
7. 在目标群 → 设置 → 群机器人 → **添加该机器人**
8. 回到 dashboard **Settings → Lark**：选**平台**（飞书 / Lark 国际）→ 填入 App ID / Secret → 保存 → 点「测试」验证 → 点「启用」

### 关于 token

不需要手动配置 token：`App ID` / `App Secret` 相当于账号密码，SDK 会自动换取并续期 `tenant_access_token`（2h 有效）。设置页的「测试」按钮就是换一次 token 来验证凭证有效。

> 长连接模式仅支持**企业自建应用**，且**无需公网 IP**。

## 运行与部署

网关**已并入 `./run.sh`**：启动 dashboard 时会自动在后台拉起网关（日志 `~/.pi/logs/lark-gateway.log`），并接管上一次的实例；两者属于同一进程组，停止 dashboard 时一起退出。未配置任何 Lark 账号时自动跳过，不影响 dashboard。

```bash
./run.sh                      # 构建前端 + 启动 dashboard + 后台网关
PI_LARK_GATEWAY=off ./run.sh  # 本次不启动网关
npm run lark:dev              # 单独跑网关（调试用，前台）
npm run lark:probe            # 只验证 dashboard 通道（不需要 Lark 凭证）
```

账号在 dashboard **Settings → Lark** 里配置（新增/测试/启用/删除）。切换启用后网关自动生效，无需重启。
`LARK_APP_ID` / `LARK_APP_SECRET` 环境变量作为后备。

完整设计见 `docs/lark-channel-gateway-tech-design.md`。

## 状态

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| M0 | 通道核心（config / dashboardClient / probe） | ✅ 已验证 |
| M1 | 目录 / 映射 / 命令（stdio 模拟 IM） | ✅ 已验证 |
| M2 | 渲染（事件→文本 / 分片） | ✅ 单测通过 |
| M2.5 | dashboard「Lark」设置 tab + 存储/API + 热更新 | ✅ 已验证 |
| M3 | Lark adapter 真实联调（私聊 + 多群多会话） | ✅ 已验证 |
| M4 | 加固（白名单 / 去重 / 重连自愈） | ✅ 已完成 |
| M5 | 增强（入群欢迎 / 话题群模式） | ✅ 已完成 |

### M0–M2 验证证据

- `npx tsc -p channels/lark/tsconfig.json --noEmit` → 0 错误
- `npx vitest run channels/lark/src/render.test.ts` → 9 passed
- `npm run lark:probe` → attached + 15 snapshot + 实时 event
- stdio 模式：`/list` → `/bind` → `/status` → `/unbind` 全通，绑定持久化

### M3 联调证据（真实飞书/Lark）

- 凭证 `POST /api/lark/accounts/:id/verify` → `{"ok":true}`
- 长连接 `[gateway] started: transport=lark(cli_..., lark)` + `[ws] ws client ready`
- 入站：私聊/群 `[in] <chatId> <userId>: /list` 正常；出站：`[out] <session> -> <chatId>` 正常
- 多群多会话：两个群分别绑定 `ato-gent-analysis` / `kyc-llm`，互不干扰

### M4 加固证据

- **断线重连**：mock dashboard 断开 → `[dashboard] reconnecting in 1s/2s` → 恢复后 `[dashboard] ws connected`，自动重新订阅
- **启动容错**：dashboard 未就绪时 `subscribe()` 不抛异常，后台退避重试（指数退避，上限 30s）
- **Cookie 刷新**：票据请求遇 401/403 时自动重新认证（dashboard 重启后仍能重连）
- **去重**：出站按 `(processInstanceId, sequence)` 单调去重；入站按 `message_id` 去重

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PI_LIVE_URL` | `http://127.0.0.1:${PI_DASH_PORT:-7777}` | dashboard 地址 |
| `PI_LIVE_CONTROL_TOKEN_PATH` | `~/.pi/agent/run/pi-dashboard/live-control-token` | 控制令牌路径 |
| `PI_LARK_MAPPING` | `~/.pi/agent/run/pi-dashboard/lark-mapping.json` | 会话映射持久化路径 |
| `LARK_APP_ID` / `LARK_APP_SECRET` | — | 应用凭证后备（优先用 dashboard 里的账号） |
| `LARK_ALLOWED_USER_IDS` | 空（=不限制） | 白名单**后备**：dashboard 里未配置时使用；逗号分隔 |
| `PI_LARK_GATEWAY` | `on` | 设 `off` 则 `run.sh` 不启动网关 |
| `LARK_GW_LOG` | `~/.pi/logs/lark-gateway.log` | 网关日志路径 |

## 映射模式：多群多会话

绑定表按 **chatId（群 / 私聊 ID）** 索引，所以「一个群 ↔ 一个 session」天然支持：

- **多个群各自绑定不同 session**：群 A `/bind 1`、群 B `/bind 2`，互不干扰
- **一个 session 被多个群绑定**：该 session 的输出会广播到这些群
- 使用者需**在每个群里各自** `/list` + `/bind`

管理命令：`/list`、`/bind <序号或名称>`、`/new <cwd>`、`/unbind`、`/status`。

### 群聊注意

- 群里必须 **@机器人** 才触发（除非申请「接收群聊中所有消息」权限）。网关会自动剥离 `@_user_1` 这类提及占位符，所以 `@bot /list` 能正确识别为命令。
- agent 的回复会发到**整个群**，全部成员可见。

### 话题群模式（每话题一会话）

Lark 话题群里每条消息属于一个话题（`thread_id`）。网关会把绑定键扩展为 **`chatId#threadId`**，因此：

- 同一个话题群里，**每个话题可以独立绑定一个 session**
- 出站消息通过回复原消息（`reply_in_thread`）发入对应话题，不会到处乱串
- 需要在每个话题里各自 `/list` + `/bind`

### 入群欢迎

机器人被拉进群时（订阅了 `im.chat.member.bot.added_v1`），会主动发一条用法提示，新群不用手教程。

## 安全：允许的用户（白名单）

默认**不限制发送者**。任何能给机器人发消息的人都能操作你的 live-session（agent 可读写文件、执行命令），风险很高。生产环境请务必配置白名单。

**推荐：在 dashboard → Settings → Lark → 「允许的用户」里填写**（每行一个 open_id / user_id，或用逗号分隔）。保存后写回 `lark-accounts.json`，网关**热更新**立即生效，无需重启。

环境变量 `LARK_ALLOWED_USER_IDS` 作为后备（仅当 dashboard 里未配置时使用）：

```bash
export LARK_ALLOWED_USER_IDS=ou_xxxx,ou_yyyy
```

两处都为空 = 不限制（任何人都能用）。
