# PiDash Android · 当前交接

> 当前实现：3.1 / versionCode 12。此文件记录进度与验证，不把编译/JVM 测试当作手机验收。
> 安装、依赖、配置及部署唯一入口：[`guide/dashboard.md`](../guide/dashboard.md#android-live-pi31)。
> 功能适配评估与后续范围：[`逐机器 Dashboard 设计`](../docs/android-machine-dashboard.md)。

## 1. 当前状态

- **机器列表 → 本机 Dashboard → Session**；本机默认 Live Pi，Chat 单独保留。旧 App 新建的 home 会话仍是 Chat，历史 JSONL 不会自动转换为 Live。
- 2.2 加入可见版本、Live/Chat 状态分离、机器范围搜索/分组/网页顺序、保守活动视图、只读目标/工作项/阻塞。
- 2.3 正文改用**与 WebUI 同一套 React 渲染器**（离线打包 assets，无网络无凭据），并把普通输入改回
  与 WebUI 一致：只有中止/压缩/重启需要接管。
- 真正接入 Live 启动、列表、详情、实时事件与租约，不是重命名 Chat slot。
- 本轮仅 Android/文档，不需为 2.2 重启服务；只读检查已证实新配对接口与网页按钮在运行，但不能据此认定手机已安装/配对。**未做手机端到端验收，未代用户重启 Dashboard、启动/接管/停止任何生产会话。**
- 原有五个前端在途文件不属于本轮：`MarkdownRenderer.tsx`、`LiveSessionsList.tsx` 及对应两个测试、`modelScores.ts`；不要把它们顺手纳入提交。

## 2. 已实现范围

| 类别 | 当前行为 |
|---|---|
| 会话入口 | 首页选机器，再进入本机 Live/Chat；版本取 BuildConfig；Chat 连接与 Live 配对/连接分开显示，未授权/断连不是空列表 |
| 本机组织 | 标题/路径/模型/分组/标签搜索，工作中/子 Agent 筛选；共用网页分组/置顶/排序，Hold 默认收起；新建分组、移动/移出，不 claim Pi |
| 活动/进度 | 按真实消息保守分段，工具执行/结果/失败；目标/阶段/工作项/阻塞只读，计数不等于验收，不推测百分比 |
| 新建 | 选服务器、服务器提供的 roots/项目候选或手填绝对 cwd；可选标题、模型、思考等级；调用真实 Live launcher |
| 消息 | 详情快照 + WS 增量；文本、思考、工具执行/结果、错误；最终消息替换半成品；序列缺口触发只读快照恢复 |
| 控制 | 打开只读；明确接管/释放，发送时尝试取得租约；他端持有时拒绝、不强抢；中止按钮仅在本机持有时可点 |
| 输入 | 默认/引导/排队模式，channel=`mobile`；失败保留草稿；不自动重试写操作 |
| 设置 | 标题、模型列表与切换、思考等级、置顶/标签 |
| 会话操作 | 压缩、重载、重启、真实用户条目分叉均需确认；重启仍受服务端空闲/tmux/子 Agent 等限制 |
| 只读检查 | 上下文能力存在时才开放检查；会话树为 JSON 预览，不是交互图谱 |
| 扩展请求 | confirm/select/input/editor；明确回答或取消，首个回答生效；复用 WebUI 的不依赖租约答复通道，不自动批准 |

为保护手机内存/排版，时间线展示最近最多 1000 项；单条正文、思考和 JSON 检查预览最多 65536 字符，并明确提示截断。图片仅显示占位说明，完整内容/图谱使用 WebUI。

## 3. 授权边界

两层授权不能混淆：

1. 原有 HTTPS 入口与服务器连接凭据：REST/WS 继续发送已有 `Authorization`。没有新增 DPoP 或改变 edge 票据策略。
2. Live 控制身份：网页 Live 已登录用户明确生成一次性码，手机兑换独立 `pi_live_session` Cookie；不用复制主机控制 token。

码为随机 32 位 hex、最多 3 分钟、一次性；服务端只保存 SHA-256，最多 32 项，新码使同一签发者旧码失效。兑换时签发者仍需有效。码不写 URL、日志或持久化，不生成/接管会话。

- Android Cookie 用 AndroidKeyStore AES-GCM 保存，AAD 绑定 backend ID、地址和连接凭据摘要。地址/凭据变更需重新配对；名称变更无需重新授权。
- HTTP 禁止跟随重定向与自动重试；Live 必须 HTTPS（回环测试除外），不放宽 TLS 校验。
- App 停到后台会断开 Live 轮询/WS 并尽力释放本机租约，不停止 Pi 工作；恢复不自动抢回控制权。前台每 10 秒续租，每 5 秒只读对账。
- 公开 summary 的 leaseId 不代表本机持有；只认明确 claim 的结果，控制写入前向服务器验证租约。
- 解除配对清除本地 Cookie；服务端正常注销会吊销该身份/其未使用码、关闭其 WS、释放其租约，不注销其他手机/网页。网络失败时本地仍清理，但不能声称服务器已确认吊销。
- 服务器 Cookie 状态以 0600 原子、串行写入，避免并发旧写覆盖注销结果。授权保持原有 12 小时空闲过期策略，过期/丢失密钥需重新配对。
- 云备份与设备迁移备份均排除 App 数据；覆盖安装保留原数据。原有 `BackendStore` 连接凭据的存储方式未改成硬件密钥库。
- 手机丢失还需按原有设备授权体系吊销入口访问；App 内 Live 注销不等于吊销普通 Chat/edge 凭据。

## 4. 源码地图

`android/app/src/main/java/com/sam/pidash/`：

| 文件 | 职责 |
|---|---|
| `domain/model/LiveModels.kt` | 独立 Live DTO、展示状态、进程/会话身份 |
| `data/remote/LiveSessionClient.kt` | 入口凭据 + Live Cookie、Origin、真实 Live REST/WS；不使用 Chat slot 接口 |
| `data/remote/LiveProtocol.kt`、`LiveActivities.kt` | 流式/活动投影、真实工具状态、目标解析、快照合并、去重、真实 entryId 分叉资格 |
| `domain/model/MachineDashboard.kt` | 本机范围搜索/筛选，网页分组/会话排序的纯函数投影 |
| `data/local/LiveCookieStore.kt` | Keystore 加密和来源绑定，损坏/恢复后失效关闭 |
| `data/repo/LivePiRepository.kt` | 多后端状态、重连/对账、焦点详情、明确控制与租约 |
| `ui/live/LiveSessionsPanel.kt` | 本机 Live 搜索/分组/筛选、手机配对、新建/路径选择 |
| `ui/live/LiveSessionScreen.kt`、`LiveActivityView.kt`、`LiveDialogs.kt` | 活动/对话、只读目标、设置、检查、危险操作确认、扩展请求 |
| `ui/sessions/MachinesScreen.kt`、`SessionsScreen.kt`、`ui/nav/AppNav.kt` | 机器 → 本机 Dashboard → Live/Chat 详情导航 |
| `ui/common/AppInfo.kt` | 构建版本与 Live 状态文案；不使用普通 Chat 状态替代 Live 授权 |
| `ui/markdown/MarkdownParser.kt`、`MarkdownBody.kt` | 纯 Kotlin Markdown 解析（可单测）+ Compose 渲染；默认会话正文 |
| `ui/live/NativeTranscriptCards.kt` | 步骤一行式（状态·工具名·参数摘要）+ 折叠输出；消息卡按角色着色、12 行截断、Run Code 归组 |
| `data/remote/TranscriptPaths.kt` | `externalUrlAllowed`：只放行 http(s)，拒绝 `javascript:`/`intent:`/`file:` 与空白/控制字符 |
| `MainActivity.kt` | 前台/后台 Live 生命周期 |

服务端：`backend/live-sessions/auth.ts`、`backend/routes/live-sessions.ts`、`backend/server.ts`。
网页：`MobilePairingButton.tsx`，由已认证的 `LiveSessionPage.tsx` 提供入口，即使未选择会话也可配对。

普通 Chat 的 `DashboardClient.kt`、`Dto.kt`、`WsFrames.kt`、`ChatScreen.kt` 继续走原协议；不要把 Live process ID 传给 slot API。保留其已修回归：`chat_done` 提升流式文本、进行中记录裁剪、重连 running 校正、用户消息乐观追加、IME/FAB 避让；这些规则不应直接套在 Live 投影上。

## 5. 验证证据与剩余风险

- Android：`./gradlew :app:testDebugUnitTest :app:assembleDebug --offline` 通过，**85 项单元测试通过**；JUnit 为纯 JVM 合成数据/临时回环 HTTP，无手机、无生产会话操作。
- `LiveProtocolTest`：流式替换、工具合并、序列缺口/陈旧事件、真实 entryId、遥测/扩展 UI、重复合法输入、坏数据、上限。
- 本轮 APK 包元数据核验：`com.sam.pidash` / versionName `2.2` / versionCode `3`；APK 签名验证通过。带版本名副本：`app/build/outputs/apk/debug/pidash-2.2-build3-debug.apk`，与标准 `app-debug.apk` 相同。
  SHA-256：`acc2f932aa5a953debdfed81cea736ba59214e70b8202b757a8e4ae14c2e9031`。
- `ImageAttachmentsTest`：附件数量/单张/合计/mime 上限与服务端协议一致；超出在本地拒绝。
- `LiveTimelineProjectionTest`：一次调用的「发起 + 执行事件 + 结果」合成同一行、参数不进正文、工具专用消息不留空卡片、
  图片是真实内联部件、流式更新按 entryId 替换而不重复。
- 输入语义回归：他端持租约时仍可普通输入；中止/压缩仍需并校验租约；陈旧租约失败不派发命令。
- `MachineDashboardTest`：本机隔离、同 ID 不串机、网页分组/置顶/Hold/排序、sessionId 重启稳定性、搜索/子 Agent 筛选、版本/连接状态文案。
- `LiveActivitiesTest`：真实工具状态、失败不掩盖、部分/中间消息不冒充最终回复、历史窗口、真实 fork ID、只读目标解析。
- `LiveSessionClientTest`：两层凭据/Origin、Cookie、重定向阻断、HTTPS、路径、启动/只读/租约/后台/答复，以及分组接口凭据、无 claim、写入不重试、未确认回执、分组失败不隐藏 Live、认证失效清理组织缓存。
- 以下后端/网页证据来自 2.1 实现验证，本轮未改这些源码，也未重新跑其全套回归。
- 后端新增 `live-session-pairing.test.ts` **19 项通过**：并发单次兑换、失效/容量/哈希、独立身份、注销持久化、Origin/认证/roots、只断开自己的 WS。
- 网页新增 `mobilePairing.test.tsx` **4 项通过**；与现有 Live reducer、侧栏回归合计 **59 项通过**。后端/前端 TypeScript 类型检查、环境变量文档检查通过。
- 含认证消费者的后端相关回归共 **118/119 通过**，唯一失败为下述既有会话树测试。ESLint 无法运行：仓库未提供 ESLint 9 所需配置；未为此改依赖或生成部署构建。
- `backend/__tests__/live-session.test.js` 有 **1 个既有失败**：会话树缺少参数期望 400、实际 404。已在原 HEAD 的独立临时副本复现（31/32 通过），不是把它改绿或冒充全量通过。
- **未验证**：APK 真机安装、手机经 VPN/Caddy 的双层认证、Web/手机看到同一新会话、真实流式/租约/后台恢复/IME。Keystore 与设备备份排除仍需真机或模拟器验证。
- **尚未实现**：文件/上传/PTY、完整工作流与目标编辑、交互会话图谱、历史搜索入口、用量页、图片附件、语音、后台通知、完整 Markdown，以及 WebUI 引用/批注/排队/计划的完整活动推断。分组完整管理与拖动排序暂用 WebUI；普通 Chat 的工具渲染/模型控制也未自动补齐。

## 6. 用户部署和手机验收

只按[权威部署指南](../guide/dashboard.md#android-live-pi31)操作。当前已有配对服务，本轮只需用户覆盖安装新 APK，首页确认 `v2.2 · build 3`，选正确机器并按需使用短期配对码；**不要为本轮再重启 Dashboard**。
2.0 不支持 Live，2.1 有 Live 但无醒目版本与逐机器 Dashboard；服务器是否更新不能替代确认手机实际安装版本。

推荐先以新建的测试 Live 验证发送/接管/释放，再验证多端互斥与后台恢复，不拿正在工作的会话做中止/重启试验。
