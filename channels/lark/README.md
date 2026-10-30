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
   - **卡片按钮**：同一页的 **回调配置** 也选「使用长连接接收回调」→ 添加回调 **`card.action.trigger`**（卡片回传交互）。不配也能看卡片，只是点按钮没反应。
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

### 保活（watchdog）

容器里没有 systemd，网关挂了不会自己起来。`scripts/lark-watchdog.sh` 由 cron 每分钟跑一次：

```cron
# cron 里不展开 $HOME，请换成绝对路径。
* * * * * $HOME/repos/pi-dashboard/scripts/lark-watchdog.sh
```

- 网关不在就拉起（日志照旧写 `~/.pi/logs/lark-gateway.log`），在就什么都不做；只看网关，不碰 dashboard（网关自己会重连 dashboard）。
- 顺带清理父进程已退出的 `dbus-daemon --session`（> 20 个才动手），inotify 实例用到 90% 时记一条 WARN。
- 自己的动作记在 `~/.pi/logs/lark-watchdog.log`；`PI_LARK_GATEWAY=off` 或没有 Lark 账号时直接退出。
- 背景：`acli` 等 CLI 在无 session bus 的机器上每调一次就泄漏一个 dbus-daemon，攒到 inotify 实例上限（128）后网关 `fs.watch` 报 EMFILE 退出。根因已在调用方修掉（`DBUS_SESSION_BUS_ADDRESS=disabled:`），网关也改为 watch 失败时退回轮询；watchdog 是最后一道保险。

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
- 多群多会话：两个群分别绑定 `group-a` / `group-b`，互不干扰

### M4 加固证据

- **断线重连**：mock dashboard 断开 → `[dashboard] reconnecting in 1s/2s` → 恢复后 `[dashboard] ws connected`，自动重新订阅
- **启动容错**：dashboard 未就绪时 `subscribe()` 不抛异常，后台退避重试（指数退避，上限 30s）
- **Cookie 刷新**：入站命令等受保护请求遇 401、或 WebSocket 票据遇 401/403 时，会重新认证并重试一次；重试仍失败时向 Lark 用户提示消息未送达
- **去重**：出站按 `(processInstanceId, sequence)` 单调去重；入站按 `message_id` 去重
- **会话目录（出站的前提）**：`live_session_attached` 同时识别两种载荷——建连帧的 `{ sessions: [...] }` 与会话**后加入**时的单会话 detail（`{ summary, ... }`）。以前只认前者，导致 socket 建立之后才 attach 的会话不在目录里，它的每条回复都被静默丢掉（表现为「Lark 里怎么发都没回复」，`/list` 之后又恢复）。现在目录缺行会打 `[out] dropped: unknown live session <pid> (...)`
- **失败可见、互不牵连**：单个群/分片发送失败只记 `[out] send failed -> <chatId>`，不影响其它群；聊天回复投递失败记 `[out] reply failed -> <chatId>`，并把入站 `message_id` 释放给 Lark 重投；帧处理异常记 `[gateway] frame failed: ...`，不再以 unhandled rejection 直接打死网关进程
- **无传输不再假装成功**：没有活跃 transport 时 `sendText` 抛错（以前是静默 no-op，日志里看起来和已送达一样）

### 排障：Lark 里发了消息，但收不到回复

先看网关日志（默认 `~/.pi/logs/lark-gateway.log`，`LARK_GW_LOG` 可改），按行里的标记定位：

| 日志 | 含义 | 处理 |
| --- | --- | --- |
| 完全没有 `[in]` 行 | 事件没到网关：群里没 @ 机器人；消息不是文本（图片/文件/富文本/合并转发被丢弃）；或长连接正在重连（`[ws] reconnect`）期间丢事件 | 群里 @ 机器人；用纯文本重发；确认有 `[ws] ws client ready` |
| `[in] <chatId>` 而不是 `[in] <chatId>#<threadId>` | 消息来自主聊天；带 `#` 则来自某个话题 | 对不上绑定就看下一行 |
| `[in] …` 后的回复是「尚未绑定会话」 | 这个聊天（或这个话题）确实没有绑定 | `/status` 看作用域，`/list` 后 `/bind`；聊天级绑定对它的所有话题都生效 |
| `[in] ignored (not allowed)` | 白名单不含该 open_id | 改 Settings → Lark 的允许用户（或 `LARK_ALLOWED_USER_IDS`） |
| `[in] duplicate ignored` | Lark 重投了同一条消息 | 无需处理 |
| `[out] dropped: unknown live session …` | 该会话不在网关目录里，回复无法寻址（修复前是静默丢弃） | 先发一次 `/list` 应急；把该行贴出来定位 |
| `[out] send failed` / `[out] reply failed` | 发往 Lark 失败（限流 / 凭证 / `reply_in_thread`） | 看冒号后的错误文本 |
| 群里收到「消息暂时未能送达 Agent」 | 网关 → dashboard 的入站转发失败（cookie / 会话状态） | `/status` 看会话是否在线，必要时 `/list` 后 `/bind` |
| `[in] handling failed` | 处理链路异常 | 冒号后即原因 |
| 回复是「会话正被网页端接管」 | `/compact`、`/abort` 需要独占租约，网页端正持有 | 等 30 秒或先在网页端放手；不影响普通消息（普通输入不需要租约） |
| 回复是「没有匹配/匹配到 N 个模型」 | `/model` 的片段匹配不唯一 | 用 `/model` 看编号，或改成 `provider/id` |
| `/effort` 有回「已下发」但没有结果提示 | 回执只转发命令后 30 秒内的 `extension_ui_notify`；或该会话没加载 thinking-level 扩展（那就只是一句普通提示词） | 看日志有无 `[out] notice -> …`；否则用 `/reload` 重载扩展 |
| `/new` 回「目录不在允许范围」 | `cwd` 不在 `liveSessions.roots` 内 | 改 `~/.pi/dashboard.json` 的 `liveSessions.roots`，或换成其中的目录 |
| `/new` 回「启动卡在 Trust project folder?」 | 目标目录有 `.pi` 资源但未被信任，pane 无法回答该提示 | 在该目录终端跑一次 `pi` 选 Trust，或写进 `~/.pi/agent/trust.json` |
| `/new` 回了「已新建会话（sessionId=…）」但没绑定 | `/start` 返回后列表/收尾失败（列表滞后或 dashboard 抖动） | 用 `/list` + `/bind` 收尾（会话已创建，不要重复 `/new`） |
| `[gateway] failed: …`，或进程不在 | 网关本身没跑起来（lock 冲突 / 凭证错误） | 重新运行 `./run.sh`，确认输出里有 `[gateway] started: transport=lark(...)` |

两条设计上的预期行为，不要当故障：

- 只有 **assistant 文本**（`message_end`，见 `render.ts`）会转发到群；纯工具轮次、被中断的一轮不会有任何消息。
- 群里必须 **@机器人** 才会推送 `im.message.receive_v1`。

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

### 新建会话（`/new`）

`/new <cwd>` 会在 tmux 里起一个新的 Pi，并**直接绑定到当前聊天**（不必再 `/list` + `/bind`）；可选标题用 `|` 分隔：

```
/new ~/apps/foobar
/new ~/apps/foobar | 修 Lark 网关
```

- `cwd` 必须落在 `~/.pi/dashboard.json` 的 `liveSessions.roots` 内（支持 `~` 与 `~/…`）；否则回「目录不在允许范围」而不是 403 原文。
- 接口要等新 Pi 注册上来（中位 ~7s，冷启动见过 30s，上限 120s）才返回，所以网关会先发一条「正在创建…」，再发结果。
- 失败时按原因给可操作的一句话：目录越界 / 卡在 `Trust project folder?`（pane 没键盘，需先信任该目录）/ 注册超时（`PI_DASH_LIVE_START_TIMEOUT_MS`）/ 服务端未启用启动器。
- 万一只建成了没绑定（列表里有延迟），会回 sessionId 并提示用 `/list` + `/bind` 收尾；此时会话**已经创建**了，不要重复 `/new`。

## 会话操作命令（模型 / 压缩 / 中断 / 上下文）

绑定之后，除了发普通消息，还能直接操作这个会话——与网页端 composer 的行为一致：

| 命令 | 作用 | 后端命令 | 需要接管（lease） |
| --- | --- | --- | --- |
| `/model` | 列出可用模型，当前模型标 `← 当前` | `get_models` | 否 |
| `/model <序号>` | 按上次列表的序号切换 | `set_model` | 否 |
| `/model provider/id` | 按全名切换 | `set_model` | 否 |
| `/model <名称片段>` | 模糊匹配（唯一才切，多个会列出候选） | `set_model` | 否 |
| `/compact` | 压缩当前会话上下文 | `compact` | **是** |
| `/abort`（`/stop`） | 中断当前回合 | `abort` | **是** |
| `/context`（`/ctx`） | 上下文用量（token / 窗口占比 / 模型） | `get_context` | 否 |
| `/reload`（`/restart`） | 重载扩展 / 技能 / 提示词 | `reload` | 否 |
| `/name <新名称>`（`/rename`） | 重命名会话 | `set_session_name` | 否 |
| `/effort <档位>` | 调 thinking level（`off\|minimal\|low\|medium\|high\|xhigh\|max`） | `input`（转给 `pi-tsien-thinking-level` 扩展命令） | 否 |
| `/shutdown confirm` | 关闭会话（**必须带 `confirm`**，不带只回风险提示） | `shutdown` | 否 |

几点说明：

- **为什么要“接管”**：`compact` / `abort` 在后端是带独占租约的命令（同一时刻只能一个客户端写）。网关会先 `claim` 一个 30 秒租约 → 执行 → 立即 `release`。这一步期间网页端会短暂看到该会话被接管（1～2 秒）。
- 如果网页端正持有租约，会直接回「会话正被网页端接管……等半分钟或先在网页端放手后再试」，不会硬抢。
- `/compact` 这类耗时命令会先回一条「正在压缩…」再回结果。
- **其它 `/xxx` 不再报「未知命令」**：`/clear`、`/goal`、`/effort`、skill / 扩展命令会原样转给会话（pi 的输入流只 dispatch 扩展命令和 skill，TUI 内置命令如 `/compact` 必须翻译成结构化命令，所以上表这几条由网关先接住）。
- `/model` 的序号依赖「上一次 `/model` 输出」的缓存；换绑定或缓存丢失时用全名/模糊匹配即可。
- **`/effort` 必须带档位**：不带参数时扩展会弹 `ctx.ui.select` 选择框，而 live-session 是 headless（`hasUI=false`），会静默什么都不做 —— 所以网关在无参时直接回用法。
- **命令回执**：扩展的 `ctx.ui.notify`（比如 `/effort` 打完档位后的“已设为 high”）走的是 `extension_ui_notify` 事件，不是 assistant 文本。网关只在**命令后 30 秒内**把它转发到聊天（ℹ️/⚠️/❌ 前缀），长跑任务的背景通知不会刷屏。

## 卡片回复与按钮

Lark 端的回复都以**卡片**（card JSON 2.0）发送，网页/终端端不受影响：

| 内容 | 卡片 | 按钮 |
|---|---|---|
| agent 回答 | 标题为会话名，正文按 markdown 渲染（标题/列表/代码块/表格）；超长自动分成「(1/n)」多张 | — |
| `/list` | 每个会话一行：状态、项目、分支、模型、工作目录 | 每行「绑定」；已绑定的那行为「解绑」；底部 刷新 / 当前状态 / 帮助 |
| `/status`、`/bind` 成功 | 绑定详情 | 上下文 / 模型 / 压缩 / 中断 / 重载 / 解绑 |
| `/model` | 模型列表，当前模型 ✅ | 每行「切换」 |
| `/context` | 用量 + 进度条，≥60% 橙、≥80% 红 | 压缩上下文 / 刷新 |
| 关闭会话命令（不带 confirm） | 红色确认卡 | 「确认关闭」（客户端二次确认）/ 取消 |
| `/help` | 常用命令按钮 + 带参数命令说明 | 列表 / 状态 / 会话操作 |

- **按钮 = 帮你输入命令**：按钮回调值是 `{ cmd: '/xxx' }`，网关按「用户输入这条命令」处理，白名单、话题作用域等规则完全一样。点击立即回一个 toast，结果作为新消息发出（Lark 要求 3 秒内响应，`/compact` 这类慢命令不能同步等）。
- **降级**：卡片被服务端拒绝（或 stdio 本地调试通道）时自动退回纯文本，日志会有 `[out] card failed, sending text`。
- **转义**：回答里 `<`、`>` 在代码外会转成实体，避免被卡片当成 `<at>`/`<font>` 标签吞字；代码块原样保留。
- Lark 客户端低于 7.20 只会看到「请升级」提示，这是 card JSON 2.0 的限制。

### 进度卡（发消息后立即有反馈）

在聊天里发给 agent 的消息（不含 `/` 命令）送达后，网关立刻发一张 **⏳ 思考中** 卡片，然后**原地更新**：

1. 每次工具调用一行（`⏳ bash \`tail -n 50 app.log\`` → ✅/❌），只显示最近 6 步，副标题显示步数和耗时（每 15s 刷新一次）；卡片上有「⏹ 中断」按钮。
2. 回答到达时，**同一张卡片变成回答**：正文 + 默认折叠的「🔧 执行过程（n 步）」+ 页脚（耗时 · 步数 · 模型）。整轮只有一条消息。
3. 一轮里如果有多段回答，后面的工具调用会再开一张进度卡，再被下一段回答接替。
4. 收到 `agent_settled` 但没有任何回答（中断、出错、只跑了工具）时，卡片变灰显示「本轮结束」。

更新频率限制在每张卡 1.5s 一次（Lark 对单条消息的编辑有频控）。不支持卡片的通道（stdio）退回原来的纯文本回答。

### 群聊注意

- 群里必须 **@机器人** 才触发（除非申请「接收群聊中所有消息」权限）。网关会自动剥离 `@_user_1` 这类提及占位符，所以 `@bot /list` 能正确识别为命令。
- agent 的回复会发到**整个群**，全部成员可见。

### 话题群模式（每话题一会话）

Lark 话题群里每条消息属于一个话题（`thread_id`）。网关会把绑定键扩展为 **`chatId#threadId`**，因此：

- 同一个话题群里，**每个话题可以独立绑定一个 session**
- 出站消息通过回复原消息（`reply_in_thread`）发入对应话题，不会到处乱串
- 需要在每个话题里各自 `/list` + `/bind`

两级绑定的关系（也是「第二条消息提示尚未绑定会话」那个 bug 的修复点）：

- **聊天级绑定**（`threadId: null`，普通群 / 私聊 / 在群主聊天里 `/bind`）：对该聊天的**所有消息与话题**都生效；回答直接发在主聊天，**不会**用 `reply_in_thread` 造话题。
- **话题级绑定**（`chatId#threadId`，在某个话题里 `/bind`）：优先级高于聊天级，只对该话题生效；回答锚定回 `/bind` 那条消息，落在该话题内。
- `/status` 会显示当前绑定的「作用域：整个聊天 / 仅本话题」。

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
