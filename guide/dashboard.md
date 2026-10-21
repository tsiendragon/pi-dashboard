# ③ pi-dashboard Web 服务

> 当前仓库。前端 React + TypeScript + Vite，后端 Express + WebSocket，终端走 node-pty。
> 它为每个会话 slot 起一个 `pi --mode rpc` 子进程，并把 ② 的扩展能力暴露成页面。

- 仓库：`github.com/tsiendragon/pi-dashboard`
- 默认端口：`7777`

---

## 品牌图标

左上角使用 `frontend/public/logo.png`（512×512），浏览器标签页使用 `favicon.png`（64×64），兼容图标 `favicon.ico` 包含 16/32/48 像素版本；安装图标为 `icon-192.png`、`icon-512.png`。入口附带 `?v=user-pi-2`，避免沿用旧图缓存。旧 `logo.svg` 不再作为标签页入口。

本版使用用户提供并选定的蓝青色 π 与仪表盘图形，不再使用先前生成的橙色版本。本次未调用图片生成 API。原图为 2752×1536，裁切区域为 `(1008, 256, 1744, 992)`，去除外围留白和下方文字，保留完整图标并缩放到各尺寸；已检查 16/32/80 像素预览、PNG 解码和 ICO 尺寸。`logo.png` SHA-256：`fc68c3ced4c1d1d747ee3c3477c2e60450b73abd2ce7a1e6f4320394e9eae5f9`。原图及预览保留在 `/tmp/pi-dashboard-user-logo/`，此临时目录不作为部署依赖。

图标属于前端静态资源，用户执行 `./run.sh` 后生效；本次未构建或重启服务，部署后的浏览器效果待用户检查。

## 普通 Chat 与 Live Pi 是不同会话入口

| 类型 | 网页入口 | 数据接口 | 当前原生 Android |
|---|---|---|---|
| 普通 Chat slot | `/chat` | `/api/chat/slots`、`/api/ws` | 已实现列表、新建、消息与停止 |
| Live Pi | `/live-sessions` | `/api/live-sessions` 及专用 Live WS | 2.1 起已实现；2.2 在本机 Dashboard 内默认进入，需独立手机配对 |

旧 Android（2.0）新建的是普通 Chat slot；2.1 默认 Live Pi，并保留独立 Chat 标签。历史 Chat
不会因 cwd 位于 `liveSessions.roots` 或文件位于 `~/.pi/agent/sessions/` 就自动转成 Live。
Live 列表展示桥接已注册的 Pi 进程，不是扫描所有历史 JSONL。新 App 必须接入真实 Live
协议、认证和租约，不能改标签冒充，也不能因网络已通就放宽权限。

<a id="android-live-pi21"></a>

<a id="android-live-pi24"></a>

## Android Live Pi（2.4）

**代码与本地测试就绪，尚未完成手机端到端验收。** 详细状态、限制与测试证据见
[`android/HANDOFF.md`](../android/HANDOFF.md)。原生支持多服务器列表、cwd 选择/新建、实时文本/思考/工具、
接管/释放/中止、引导/排队、模型/思考等级、标题、置顶/标签、明确确认后的压缩/重载/重启/分叉，以及扩展确认请求。
2.2 的首页为**机器列表 → 本机 Dashboard → Session**：本机支持标题/路径/模型/分组/标签搜索、工作中/子 Agent 筛选，复用网页分组、置顶和保存的区块/会话顺序；支持新建分组、移动/移出会话。分组重命名/合并/删除与拖动排序暂用网页。
会话可切换保守的活动进度与完整对话，并只读展示目标、阶段、真实工作项计数和阻塞；不推测完成百分比，不把工具返回/已回复说成任务验收通过。

机器列表、本机 Dashboard、设置页固定显示由构建元数据生成的 **`v2.2 · build 3`**；它不同于后端 `/api/status` 的服务版本。
普通 Chat 的连接状态和 Live 配对/连接状态分别显示，未授权/断连不当成真正空列表。
上下文与会话树仍为只读 JSON 预览；文件/上传、PTY、完整工作流与目标编辑、图片附件、用量、语音、后台通知及完整图形视图仍使用 WebUI。
完整适配评估、已实现与后续范围见[逐机器 Dashboard 设计](../docs/android-machine-dashboard.md)。

分组/排序复用既有 `GET /api/live-session-groups`、`GET /api/live-session-order`；新建/成员变更复用既有受 Cookie 与 Origin 保护的分组写接口，不新增后端权限。
组织信息前台最多每 30 秒拉取一次，进入本机 Dashboard 或点刷新时立即对账；加载失败单独提示，不把正常 Live 列表误报为空，也不自动改写网页排序。

### 网络与两层授权

沿用原有**私有 HTTPS 入口**与 VPN。手机在家需要 VPN 的现有路线不变，不新增公网入口、Tunnel、DNS 或防火墙规则。
Live 必须 HTTPS，仅本机回环测试允许 HTTP；不跳过证书验证。普通 Chat 的旧 HTTP 兼容设置不能用于传输 Live 配对身份。

1. 服务器连接设置里的原有入口凭据仍负责 `Authorization`；VPN 和 Cookie 不替代逐设备入口授权。本轮没有改 edge 的 DPoP/WS 票据策略。
2. Live 另外使用独立 `pi_live_session` Cookie。先在已登录的网页 `/live-sessions` 点击 **「手机配对」→「生成一次性配对码」**；App 对应服务器点「配对」，粘贴短期码。
3. 不把主机控制 token、Cookie、入口 token 发到聊天或填入配对码栏。配对只授予该 Dashboard 原有 Live 控制身份，不是新增目录授权，也不会创建、接管或停止会话。

码为随机 32 位 hex、最多 3 分钟、单次使用，服务端仅内存保存 SHA-256，容量 32；新码使同一签发者旧码失效。
签发者注销/过期后，其未使用码失效。手机兑换后拥有**独立身份**，注销网页不会连带注销已配对手机；
手机「解除配对」只注销该手机 Live 身份、关闭其 WS、释放其租约，不撤销普通 Chat/入口凭据。
网络失败仍清理本地身份，但不能声称已确认服务端吊销。手机丢失需另按设备授权体系吊销入口访问。

Android 的 Live Cookie 用 AndroidKeyStore AES-GCM 加密并绑定服务器地址/连接凭据；改地址/凭据或密钥丢失后重新配对。
云备份与设备迁移均排除 App 数据；普通覆盖安装保留数据。原有服务器凭据仍由 `BackendStore` 保存，不能把此改动说成全部凭据都已硬件加密。
服务端身份：网页控制令牌登录仍是 **12 小时空闲过期**；手机配对身份是 **30 天空闲过期**（`DEVICE_SESSION_MAX_AGE_MS`），所以配对一次即可长期使用，解除配对/注销仍立即失效。Cookie 状态文件使用 0600 串行原子写，防止并发旧写恢复已注销身份。

新增接口（仍受原有入口鉴权，路径不放入公网例外）：

| 接口 | 限制 |
|---|---|
| `POST /api/live-sessions/pairing-code` | 已有 Live Cookie + 匹配 Origin；返回 `result.code/expiresAt` |
| `POST /api/live-sessions/pair` | 匹配 Origin + 一次性码；兑换独立 Cookie，不需要先有 Cookie |
| `DELETE /api/live-sessions/auth` | 已有 Cookie + 匹配 Origin；仅注销当前身份 |
| `GET /api/live-sessions/start-options` | 已有 Cookie；仅返回与 launcher/broker 相同来源的 `liveSessions.roots` |

认证/配对响应使用 `Cache-Control: no-store`；配对码不进入 URL、日志或存储。网页关闭配对窗口会清除显示；
若复制过，剪贴板由用户清理，码仍由服务端限制有效期和单次消费。选择目录还会合并既有项目候选，
**候选不等于授权**；启动时继续 realpath/roots 校验，roots 为空仍默认拒绝，不自动把目录设为 home。

### 渲染：复用 WebUI，而不是再造一套

会话正文默认由 **WebUI 自己的 React 渲染器**渲染：`frontend/native-renderer/` 复用
`src/components/MarkdownRenderer.tsx`（react-markdown + remark-gfm + rehype-raw + DOMPurify +
highlight.js + mermaid + DiffBlock）与真实主题 CSS，经 Vite 打包进
`android/app/src/main/assets/native-renderer/`。所以代码块、表格、公式、图形、diff、图片在手机上
与网页同一套渲染与配色，而不是 Kotlin 的近似实现。

- 页面从虚拟源 `https://renderer.pidash.local/` 由 `shouldInterceptRequest` 从 assets 读取；
  其他任何请求（网络、`file://`、越界路径）一律拒绝。**页面不含 Cookie、不发请求、不持有凭据**，
  正文数据由 App 通过 `window.PiDashRenderer.render(...)` 推入。
- 手机尺寸差异只在 CSS 层处理：页面自身滚动、卡片左右留白、代码块横向滚动而不换行、
  图片/表格限宽；流式跟随只在读者已贴近底部时生效。
- 步骤与正文遵循 WebUI `ActivityTimeline` 的规则，而不是把所有输出铺开：**工具是一行式步骤条**
  （状态图标 + 已完成/进行中/失败 + 工具名 + 单行摘要），参数和完整输出**默认折叠**在「展开输出」后；
  `run_code` 等归为「Run Code」单独展开。正文超过 12 行或 1200 字先截断，底部渐变 + 「展开全部正文（N 行）」，
  阈値与 `ActivityReplyBody` 一致。
- 无法加载时自动回退到「原生文本」，也可手动切换「WebUI 渲染 / 原生文本 / 活动进度」。
- 只有渲染被复用，**写入仍由原生外壳控制**：输入框、菜单、租约与确认逻辑都不在 WebView 里。

改动渲染器源码后必须先重建 assets，再构建 APK：

```bash
npm --prefix frontend run build:native-renderer
cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug
```

发布脚本会校验 assets 比渲染器源码新，避免发出旧渲染器。

### 图片附件

会话输入框左侧的「＋」可从相册多选图片，限制与 `shared/src/live-sessions.ts` 完全一致：
单张 ≤ 3 MB、最多 4 张、合计 ≤ 6 MB；仅 PNG/JPEG/WebP/GIF。超限图片在本地按长边 2048 缩放并以
JPEG 重新压缩，仍超限则明确报错而不是静默丢弃；原始大小已合规时保留原始字节（GIF/WebP 不失真）。
附件与草稿一样，**发送失败时保留**。服务端仍做同样校验，客户端限制只是提前失败。选中的图片会随消息
发往该 Live 会话，并可在「WebUI 渲染」中以数据 URL 显示。

### 输入不需要“接管”

与 WebUI 完全一致：普通消息（`input`）、改标题、切模型、重载扩展**都不需要租约**，手机、网页和
TUI 可以同时对同一会话输入。只有会打断或改写运行中工作的操作——**中止、压缩上下文、重启进程**——
才要求显式接管；他端持有时直接拒绝，绝不抢占。此前手机端对所有输入都强制先接管，是本轮修正的偏差。

### 构建和用户部署

App 版本 2.5 / versionCode 6，包名仍为 `com.sam.pidash`，可覆盖安装。依赖 JDK 17、SDK 35、
Gradle 8.9、AGP 8.7.3、Kotlin 2.0.21；新增纯 JVM 测试依赖 JUnit 4.13.2，没有升级原有运行依赖。

**2.2 本轮仅修改 Android 与文档；服务端已有 2.1 配对及既有分组接口时，只需覆盖安装新 APK，不需要重建前端或重启后端。**
首次从更旧服务端升级、尚无 2.1 配对接口时，才由用户选择维护窗口，按已有启动方式更新网页/后端；标准入口是仓库根目录的 `./run.sh`。
重启会影响活跃会话，agent 不代执行、不 kill 服务；不要为手机版本或配对排查反复重启，也不要同时启动两个 Dashboard。

构建/安装（从仓库根目录开始；首次需正常获取构建依赖，缓存齐全时可在 Gradle 命令末尾加 `--offline`）：

```bash
cd android
./gradlew :app:testDebugUnitTest :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

安装可使用下述用户已授权的 GitHub Release，或私有本地传输。公开发布的只是通用 App 产物，不包含设备配置/登录身份，也不开放私有 Dashboard 服务。服务器原有配置可保留，首次 Live 使用需短期配对。
若提示签名不一致，先核对签名来源，不要通过卸载旧 App 绕过，以免丢失本地配置与配对身份。

### Android GitHub 发布（每个新可安装版本）

下载入口：[GitHub Releases](https://github.com/tsiendragon/pi-dashboard/releases)。仓库为公开仓库，APK、校验值和更新说明均可公开下载；访问服务器仍需既有入口授权与 Live 配对。
这不是 App 内自动升级，不会自动安装 APK、上传手机数据或变更服务网络。

以后每次 Android 新可安装版本交付均同步发布：

1. 递增 Gradle 中的版本名和 build code；先完成 Android 测试与 APK 构建。发布工具复用已有产物，不擅自重编译/部署服务器。
2. 使用同一签名生成 APK；`android/release-signing-cert.sha256` 仅固定当前公有证书 SHA-256 摘要，**不是私钥**。随机 CI runner 不能重新生成 debug key，否则无法覆盖安装。当前保留原签名，不将私钥上传 GitHub/GitHub Secrets；真正迁移正式签名需另外批准。
3. 编写 `android/releases/android-v<versionName>-build<versionCode>.md`，提交本版本变更，不混入无关在途修改。
4. 使用 Python 3.9+、已登录且有仓库写权限的 `gh`、Git、JDK 17 和 Android Build Tools；`ANDROID_HOME` / `JAVA_HOME` 指向用户已配置的 SDK/JDK。仓库根目录执行：

   ```bash
   # 默认只核验本地 APK、版本、固定证书、源码/测试新鲜度和更新说明，不联网发布
   python3 android/publish.py
   # 明确发布；默认使用 app-debug.apk，可通过 --apk 指定已验证产物
   python3 android/publish.py --publish
   ```

脚本验证包名/Gradle 版本、签名、测试结果、产物与源码时间以及构建源码无未提交变更。先推不可改写的版本 tag（如 `android-v2.2-build3`），再建立预发布草稿；上传版本化 APK、`SHA256SUMS` 与 `build-info.json`，全部成功才公开。
脚本只推版本 tag，不自动推 master、不强推、不删除 tag，不覆盖已公开的同版 APK。中断后保持草稿；重跑只补缺失附件，已有附件须逐字节摘要一致。生产服务和其他工作区文件不受影响。

当前发布仍是 Debug APK **预发布版**，需要真机验收；不能以 59 项 JVM 测试当作手机验收。`build-info.json` 记录版本、来源提交、公有证书摘要、APK SHA-256、单测统计与未完成真机验收标记，不包含主机路径、Cookie、token 或私钥。
未配置无人值守 CI：有新版本时按上述命令同步发布，不承诺每次 commit 自动生成 APK。不要为此在公共 runner 中创建临时签名。

可校验下载文件后覆盖安装；签名冲突时先核对，不能卸载绕过。脚本出错时不得把未公开草稿说成已发布。

### 手机验收顺序

1. VPN 与原有 HTTPS 域名能正常访问，App 服务器连接信息保持正确；网页有 Live 登录状态。
2. 覆盖安装 APK，首页必须看到 `v2.2 · build 3`。服务已具备配对接口时不重启；在机器列表选择正确 Dashboard，必要时网页生成一次性码并在本机配对，不复制主机控制 token。
3. 本机 Live 应看到与网页相同的在线进程及分组/置顶/顺序；验证搜索、Hold 收起/展开、子 Agent 筛选；另一台机器不能混入本机结果。旧 Chat 在本机的单独标签，未配对/断连不是空列表。
   查看活动进度、完整对话和只读目标记录，核对工具失败/未确认状态没有变成“全部完成”；分组变更只在专用测试会话上验证。
4. 「＋」选择服务器和允许的 cwd，新建一个专用于测试的 Live；网页 Live 列表出现同一会话和目录，不新增普通 Chat slot。
5. 发一条测试消息，验证流式/最终正文、工具/思考、模型与输入法；失败应保留草稿，不盲目重复创建。
6. 用测试会话验证明确接管/释放和他端互斥。App 后台会断开 Live 并尽力释放租约，不停 Pi；恢复不自动抢回控制。
7. 验证扩展请求必须明确回答、Cookie 失效后重新配对。压缩/重启等仅在测试会话上按需确认，别拿工作中的会话测试中止。

这些是**待做的真机验收**，本地合成协议/HTTP 测试和 APK 编译不能替代。

## 在线会话重启

列表的重启按钮需要二次确认。仅允许空闲、无在线子 Agent、由 dashboard 管理的 TUI 会话：向原 tmux pane 输入 Pi 内置 `/quit`（按 `keybindings.json` 的 `app.clear` 清空整个输入框，再按 `tui.input.submit` 提交；未配置时分别使用 Ctrl+C、Enter），确认旧进程退出、tmux 消失且在线登记移除后，用 `pi --session <原会话文件>` 恢复。Linux 僵尸进程视为已退出；30 秒内未退出则报错且不启动替代进程，不强杀。无需 bridge 的 `session_shutdown` 能力。支持提交键 Enter、Ctrl+字母和 F1–F12；配置没有可用键时在发送输入前报错，不把 Enter 写死为提交键。此改动需用户执行 `./run.sh` 构建前端并重启后端生效。

## 侧栏密度与分组顺序

会话侧栏使用淡虚线分隔，普通会话行约 35px 高，保留 13px 的会话标题与第二行信息；分组名从原来的 11px 缩到 10px，标题行收紧到约 20px。`Hold`（名称忽略大小写和首尾空格）默认排在未分组之后并折叠；展开或折叠只改变显示，不暂停或关闭会话。搜索和标签筛选会展开匹配分组，避免漏掉折叠中的会话。

在「＋ 任务」面板的「分组顺序」中可上移、下移或移到底部，包括未分组和空分组。置顶会话始终在最前。分组顺序保存在现有 `live-session-order.json` 的可选 `sectionOrder` 数组中（分组 ID 与 `__ungrouped`）；旧文件无需迁移。`GET /api/live-session-order` 返回 `order` 和 `sectionOrder`，`PUT` 只传 `sectionOrder` 时仅改变分组顺序，只传 `order` 时仅改变会话行顺序。两种排序互不覆盖。新增分组默认插入末尾的 Hold 之前；显式移动 Hold 的位置会保留。

需用户执行 `./run.sh` 构建前端并重启后端后生效，agent 不代为部署。

## 任务分组管理与会话菜单浮层

侧栏「＋ 任务」面板现在同时承担新建和管理：列出**全部**分组（包括没有 session、不会出现在列表里的空分组），每个分组可重命名、合并到另一个分组、二次确认删除；合并会把成员并入目标分组后删除源分组，只动分组、不动 session（`POST /api/live-session-groups/:groupId/merge`）。会话行的 `⋯` 菜单改为挂到页面顶层的固定定位浮层：在列表顶部或底部的行不再被滚动容器裁切，空间不足时自动向上翻转并收进视口，滚动或缩放时自动收起。此改动需用户执行 `./run.sh` 构建前端并重启后端生效。

## 侧栏行信息、活动时间与运行时长

会话行尾的「活动」是**最后一次活动**距今多久（悬停可看到绝对时间），不是运行时长。它以前常年显示几秒：浏览器每 10 秒发一次心跳，后端把心跳当“活动”写进了 `lastActivityAt`，于是空闲会话也永远像刚活动过。现在心跳只用于保活（`ConnectionState.lastSeenAt`），`lastActivityAt` 只由真实事件推进，空闲会话会如实显示小时/天。

行上不放 tmux 会话名：`终端` 小标签保持只有图标和文字，tmux 会话名放在行尾「⋯」菜单的「终端 · tmux 会话」只读块里（点击整行即复制 `tmux attach -t …`；外部自己启动的 Pi 没有 tmux，菜单里不出现这一段）。第二行右侧只显示项目路径的 basename（如 `~/repos/pi-dashboard` → `pi-dashboard`），**不再显示分支名**；完整路径在悬停提示里。

会话页状态栏的「◷ 运行 147h46m」是 **Pi 进程**从启动到现在的时间（悬停显示启动时刻），不等于“这次对话”的时长：进程内 `/clear` 或换会话不会归零，只有进程真的重启才会。**这是有意的**（2026-10-14 定）：进程能长期驻留，用户要的是“这个会话开了多久”，不是“这段对话聊了多久”，所以不要把它改成读会话文件首条时间。此改动需用户执行 `./run.sh` 构建前端并重启后端生效。

## Live 会话镜像的重连恢复

dashboard 对每个 live session 的镜像跟随桥接进程的编号（revision/sequence）。当 pi 内执行 `/reload` 等操作重建了桥接进程时，编号会从 1 重新开始；旧逻辑把重连后的第一份快照当成“过期”拒收，并把该会话永久卡在“等待重新同步”状态：此后所有新事件被丢弃、指令也拒绝（返回 `live_session_unavailable`），但心跳仍在，于是侧栏看起来“工作中”、页面却停在旧内容（例如一直显示“思考中”）。现在：新连接上的第一份快照会重新锚定编号；处于“等待重新同步”的会话每 10 秒自动再请求一次快照（可用 `resyncRetryIntervalMs` 调整），不再一次失败就永久卡死。此改动需用户执行 `./run.sh` 重启后端生效。

## 上下文检查（Live 会话）

`/live-sessions/<id>` 顶部工具栏新增「◲ 上下文」按钮。它回答一个平时只能猜的问题：**这个会话到底把什么发给了模型**。

- 数据来源分两种，界面上如实分开标注：**真实请求**＝最近一次 `before_provider_request` 拿到的真实 provider 载荷（已按 OpenAI Responses / Chat Completions、Anthropic Messages、Google、Bedrock Converse 归一）；**近似重建**＝这个进程还没发出过请求（刚启动 / 刚 reload），按当前系统提示、已启用工具与会话分支重建，扩展的 `context` 变换与逐回合改动没有算进去。
- 四个页签：总览（各类别估算 token 与占比、最大的 10 条消息）、系统提示（按 pi 的标记拆成项目说明文件 / 技能清单 / 准则 / 基础提示，各自字符数与占比，并给出正文）、工具（每个工具的定义体积，按大小排序）、消息（搜索、展开全文）、请求字段（模型、推理强度、`tool_choice` 等非内容字段）。
- token 数是估算（ASCII 约 4 字符 1 token，中日韩 1 字符 1 token），用来比较高下；旁边同时给出 pi 按上次响应 usage 上报的占用，两者有差距是正常的。每行都带**真实字符数**，即使正文因体积过大被截断也不会失真。
- 「复制报告」导出一份纯文本结论（来源、各类别占比、系统提示大块头、最大的消息），不含正文，方便直接贴给别人或交回给 agent 做优化。

只读命令，不需要接管会话（别的浏览器持有控制时也能看）。

**旧会话需要重载**：这个能力是 Pi 进程启动时加载的扩展提供的，重启 dashboard 不会换掉已经跑着的 Pi 进程。所以按钮对所有会话都显示，但会话里的 Pi 还在跑旧版扩展时，点开只会看到一句「去重载」（不产生无效请求）；重载后重新打开即可。新开的会话天生就是新版。若会话里的扩展是更早的中间版本，部分字段可能缺失（界面会标注「这份数据来自旧版扩展」，缺失不等于为空）。

数据由扩展侧提供：`pi-tsien-live-session` 的 `get_context` 命令 + `context-view.ts`。本改动需用户执行 `./run.sh` 构建前端并重启后端生效；已在运行的 Pi 会话还需要各自重载（或在「＋ 任务」里批量重载）才会认这条新命令。

## 费用统计

Cost 页的“按模型”表保留模型合计，并按 effort（思考强度）展示子项的费用、Token、输入/输出和实际加权单价（记录费用 / 总 Token × 100 万，包含缓存 Token），不是供应商标价。effort 来自消息字段或会话文件的 `thinking_level_change`，缺失时显示“未知 effort”；重新扫描可访问的历史会话文件会补全已有账本记录，不重复计费。工具摘要没有明确 effort 时也保留在未知项。已删除的会话无法补全。此改动需由用户执行 `./run.sh` 构建前端并重启后端生效。

## 1. 依赖与构建

- 需要 Node.js 22+
- 前端依赖里存在历史 peer 冲突，**请用项目脚本安装**（脚本已带 `--legacy-peer-deps`）：

```bash
npm install --no-audit --no-fund
npm run build-frontend        # 等价于 cd frontend && npm install --legacy-peer-deps && npm run build
```

`node-pty` 需要编译工具（Debian/Ubuntu：`sudo apt install -y build-essential python3`）。

---

## 2. 启动与部署

```bash
# 开发/手动启动：先构建前端，再以 tsx backend/server.ts 前台启动
PI_DASH_PORT=7777 ./run.sh
```

浏览器打开 `http://localhost:7777`。

**服务由用户自己启动/重启**（见仓库根 `AGENTS.md`）：agent 不代跑 `./run.sh` / `./restart.sh`，
也不 kill 正在运行的服务进程。

代码改动的生效方式：

| 改动位置 | 生效方式 |
|---|---|
| `backend/**` | 必须重启服务进程 |
| `frontend/**` | 服务静态托管 `frontend/dist`，构建后即生效（构建与重启仍属用户操作） |

### systemd（开机自启）

```bash
bash scripts/install-standalone.sh -y --service
sudo systemctl status pi-dashboard
sudo journalctl -u pi-dashboard -f
```

unit 写到 `/etc/systemd/system/pi-dashboard.service`，带 `User` / `WorkingDirectory` / `PATH` /
`PI_CODING_AGENT_DIR` / `PI_DASH_PORT`。卸载：

```bash
sudo systemctl disable --now pi-dashboard
sudo rm /etc/systemd/system/pi-dashboard.service && sudo systemctl daemon-reload
```

---

## 3. 环境变量

> **可移植性**：这些变量**默认值已改为 `<agent dir>/...`**（不再含开发机路径），新机器无需设置即可用；
> 仅当你要沿用旧的数据位置时才显式指定。`liveSessions.roots` 默认是**空**（配置驱动），
> 想扫哪些目录就在 `~/.pi/dashboard.json` 里写自己的。完整变量表见 [config.md](config.md) §2。

### 3.1 本服务相关变量

完整的加载顺序、规则和**完整变量表**见 **[config.md](config.md) §2**（本文件不重复，避免两处维护）。
本服务只需记这几条：

| 变量 | 作用 | 默认 |
|---|---|---|
| `PI_DASH_PORT` | 服务端口 | `7777` |
| `PI_DASH_HOST` | 监听地址；设 `127.0.0.1` 收敛暴露面 | `0.0.0.0` |
| `PI_SCRIPT` | 用哪个 pi 可执行文件（fork 构建） | 仓库内 `node_modules/.bin/pi` → `which pi` |
| `PI_DASH_BRIDGE_SOCKET` / `PI_DASH_BRIDGE_TOKEN` | 与 live session 桥接 | 无 |

加载到的变量会被**每一个** pi 子进程继承（`backend/pi-manager.ts` 用 `...process.env` 启动 slot），
所以扩展也能读到；启动日志会打印 `[env] loaded env file(s): …`。

### Token Cost 额度查询（可选）

Token Cost 页面会单独读取 Codex / Claude Code 的 5 小时和周用量窗口：Codex 通过 `codex app-server` 读取当前账户限额，Claude Code 使用 `CLAUDE_CONFIG_DIR`（默认 `~/.claude`）下的 OAuth 凭证查询 Anthropic 用量接口。两者都是可选项，没有相应本地登录时，原有 Token Cost 统计仍可用；API key、Bedrock/Vertex 等 Claude Code 账户不提供此订阅限额数据。凭证只由后端读取，不会下发给浏览器。完整说明见 [config.md](config.md) §2。

---

## 4. dashboard 自身配置（`~/.pi/dashboard.json`）

live session 靠它，Settings 页可改（`/api/dash/config`）：

```json
{
  "liveSessions": {
    "enabled": true,
    "roots": ["/home/you", "/home/you/repos"],
    "launch": {
      "command": "pi",
      "args": [],
      "unsetEnv": ["HF_TOKEN", "AZURE_OPENAI_API_KEY", "…"]
    },
    "disconnectGraceMs": 60000
  }
}
```

| 字段 | 作用 |
|---|---|
| `roots` | live session 可发现的目录范围（**默认为空 → live session 默认关闭**，要用就填） |
| `launch.command` | live session 用哪个 pi（可指向你自己的包装脚本；默认 PATH 上的 `pi`） |
| `unsetEnv` | 启动前从环境里剔除的变量 |
| `launch.approve` | `true` 加 `--approve`、`false` 加 `--no-approve`；不写则保留 pi 自己的行为（工程内有 `.pi/skills` 等资源时会弹信任提问，pane 无人应答就会卡住启动） |
| `disconnectGraceMs` | 断连后的宽限时间 |

另外：`<agent dir>/pi-web-sessions.json` 是 slot 元数据（运行时状态，自动维护）。

---

### 可选出站 WSS 会话索引与受限控制（实验性）

仅当 `<agent dir>/machine-connector.json` 存在且为有效的 0600 私有普通文件时启动。格式和权限见 [config.md](config.md)；不使用环境变量传密钥，默认关闭。认证成功后可处理 `list_sessions`（UUID requestId），回传最多 50 个受限 ASCII ID 及 idle/running/reconnecting 状态；还支持固定结构的租约声明/释放和短文本输入，必须通过机器侧会话与租约校验，重复输入或不确定结果不自动重试；输入在派发给 Pi 前先持久化预留 ID。`$HOME/.pi-dashboard-private/machine-input-replay.json`（及独占 `.lock`）为当前用户所有的 0600 私有文件，仅保留散列 ID，不能通过 HTTP/日志读取；文件损坏、权限不安全或满 100000 条时拒绝控制输入，绝不自动淘汰或清除已接受 ID。崩溃留下的锁需核实进程已退出后人工处理，详见 [config.md](config.md)。列表不包含 cwd、pid、路径或模型；另有选中会话最近最多 8 条已完成用户/助手纯文本的受限预览（不含工具输出和完整 transcript），不支持 HTTP 代理、任意 Pi 命令或图片。预认证帧最大 2048 字节、认证后最大 16384 字节；异常协议直接断链。TLS 证书校验始终启用。此连接**不替代**本服务的入站 HTTP/WS 安全边界。

## 5. 远程访问与安全

**关键前提：dashboard 的 `/api/*` 与 WS 默认无认证**，安全模型是「网络不可达」。

| 接口 | 认证 |
|---|---|
| `GET /api/*` | 无 |
| `POST/PUT/DELETE /api/*`（除 live-sessions / pty） | 无，仅 Origin 检查（防 CSRF，非认证） |
| `WS /api/ws` | 无 |
| `/api/pty`、`/api/live-sessions/*` | 有 cookie/token 认证 |

推荐做法：

```bash
# Tailscale：同一 tailnet 直接访问
http://<tailscale-ip>:7777

# 或 SSH 隧道
PI_DASH_HOST=your-server PI_DASH_USER=you ./pi-dash-connect.sh
```

**不要**把 7777 直接映射到公网；确需公网访问，在前面加 nginx + HTTPS + 认证。
已有的 nginx/Tailscale 反代部署方案见 [remote-access-deployment.md](remote-access-deployment.md)。多机器移动端远程接入尚未实现；远程网关服务端不属于本仓库；目标互通尚未完成，**不能公网发布**。公开实施状态见 [cloudflare-mobile-gateway.md](cloudflare-mobile-gateway.md)。不要把 Tunnel 直接指向 Dashboard 或任何管理服务。

---

## 6. 相关页面与文档

| 页面 / 文档 | 说明 |
|---|---|
| `/supervisor` | 工作监督台：授权会话状态、任务、人工待办、报告 |
| `/tasks` | 任务清单（Tasks 的默认视图） |
| `/tasks/<UID>` | 任务详情页：第一屏是该任务的时间线，见下 |
| `/tasks/events?objectRef=<UID>` | 事件流水账（竖轴时间线，见下）与同页复盘分析；按现有 Task/Epic UID 关联。它是 Tasks 的下一级视图：**不在侧边栏占位**，入口是 Tasks 页顶部的「任务清单 / 事件流水账」切换（任务详情页里也有「在流水账中查看 →」）；旧链接 `/events` 会带上查询参数跳到 `/tasks/events` |
| 全局主 Agent 弹窗 | 主 Agent 入口只在导航栏（窄屏在底部标签栏）出现一次，会话页右侧工具栏不再重复这个图标；同栏“通知”查看最近未处理待办与建议，点击检查进入同一弹窗；其他页面通过导航栏进入；显式启动、记录回复截图、创建/更新可写本地任务 |
| `/extensions` | 扩展装载事实 + 管理，见 `guide/extensions-page.md` |
| `/live-sessions` | live session 接管/分叉/导航 |
| Workbench | 子 Agent 与 Workflow 面板 |
| `guide/api-reference.md` | 后端 API |
| `guide/config.md` | 配置总览（四层地图、每个 config 谁读、怎么改） |

---

监督资源指纹发生变化时，读写通道会一起暂停并提示「结束旧主会话并重新启动」；只有扩展源码更新属于例外——不暂停通道，只在监督台/主 Agent 弹窗提示「扩展代码已更新（主会话仍在用启动时的版本）：现在可继续使用，建议结束后重新启动主会话以加载新代码。」，主 Agent 读取上下文时也会拿到同一句 `resourceNotice`。
需要用户确认的写入（例如把任务标成完成）有两条通道：**主 Agent 弹出的确认窗口里点「允许这次操作」**，或**直接在对话里回一句「确认」**（同意 / 允许 / 可以 等短句同样有效；只认刚刚问过的那一件操作，换目标或换操作都会重新询问）。确认窗口不会因为点页面空白处消失；关掉或点「不允许」只代表这次没通过，主 Agent 应按事实说明「确认未通过」，不得声称用户取消、也不得绕过。
主 Agent 弹窗提供“清空并重新加载”：仅在主会话空闲且未被接管时执行，建立空白会话并由 Pi 自动重新加载扩展、技能等资源；页面等待新会话连接后自动刷新。旧会话文件、本地任务、事件及截图均保留，不重启 Dashboard 或影响其他会话。运行中的旧扩展不含清空命令时，需先结束旧主会话并重新启动一次；扩展待更新时按钮禁用，后端也拒绝操作。

工作监督功能默认关闭，配置与两个仓库资源路径见 [config.md](config.md) §4“主 Agent 工作监督”。会话观察不再直接贴模型原始输出：后端从最近 8 条 assistant 消息里摘出句子，去掉命令、代码块、路径、表格与口语前缀，给出「一句话结论 + 最近要点（新→旧）+ 在等什么 + 下一步」，四者都是原文摘录，界面明确标注“不是任务事实”，并保留可展开的“原始输出”；摘不出可读句子时直接显示原文，不伪造成已总结。事件流水账的「时间线」是**一根竖轴**：每个日期一个节点（左侧日期 + 星期 + 当天条数），右侧是该记录的**简介一行**；点日期可折叠整天，点标题展开单条完整记录（发生/记录时间、参与人、记录人、来源、来源会话、描述、原始回复、下一步、修订历史、事件 id、截图；收起时最多 1 张缩略图，展开后最多 4 张）。默认展开最新一条；记录多于 12 条时默认只展开最新一天，其余折叠并说明折叠了几条。没有可用时间的记录单独列在「时间未知」节点，不被丢弃。工具条可按类型筛选、只看有图片、切换新→旧 / 旧→新。**打开任务是一个页面（不是侧边抽屉）**：`/tasks/<UID>` 第一屏就是该任务的时间线（含子对象），任务内容、任务信息、关联会话、规划依次排在后面，左上角返回列表。Task 详情同时提供“查看事件流水与复盘”链接；流水账可返回原任务。原有 Task 页面和任务来源继续复用，不新建影子任务系统。监督台首页默认只展示在线开发会话关联的未完成任务、未归档 Dashboard 本地任务及其项目/Epic；主管自己的会话不作为开发关联依据。其他任务默认不渲染，点击“显示其他任务”按需展开，不删除任务、不改变状态，也不缩小主 Agent 既有授权访问范围。没有 Task Journal 或在线会话时，本地任务仍可展示。任务关联复用已有会话工作目录、标签和手动关联，不凭消息内容猜任务。

Supervisor API、附件和主 Agent 均需 LiveSession 浏览器认证；通用文件 API 不允许读取监督私有档案或认证控制文件，包括大小写、相对路径和符号链接别名。Task Journal 来源仍走 Task Pilot，Jira/Lark 无兼容工具时标记待处理，不伪装自动同步成功。本次本地功能交付不以 Jira/Lark 为前提。主 Agent 用 event_get(includeImages=true) 复读已授权事件的持久截图，返回真实图像内容而非只有链接；单次最多 4 张、原始图像总计 6 MiB。实际模型及界面操作验收由用户执行。

事件 `type` 受配置词表约束（默认 `progress`/`reply`/`blocked`/`resumed`/`decision`/`result`，可用 `eventTypes` 自定义），写入词表以外的类别会被拒绝并提示可选值，避免自由文本使年末按类别汇总漏项；`working_state`、`suggestion` 是系统专用类型，不受词表限制。一次性事项（面试、临时接的活儿）没有对应任务时，主 Agent 会先找/创建带 `personal-log` 标签的本地「个人记录」容器再记录，不挂到开发任务或只读来源上；新建容器属于可见任务变更，需用户确认。

主 Agent 查事件用 `event_query`（固定返回 `{events, total, truncated, excludedWithoutTime}`，默认最新在前、只回摘要），`event_list` 保留给页面全量视图。`supervisor_context` 内嵌的事件列表也已改为摘要并按默认 50 条截断（`eventsTruncated`），避免一次拉入全部描述与修订；需要正文或截图时按 `id` 调 `event_get`。时间区间过滤会把无发生时间的事件计入 `excludedWithoutTime`，不会被静默丢弃。

后端代码变更需用户执行 `./run.sh`（或自己的启动方式）生效；前端构建也属于用户部署步骤。Agent 不代为重启服务。本机测试通过不等于真实模型和运行中会话联调通过，部署后需要验证一次明确记录、一次状态更新、一次自动观察，检查截图和历史重启后可读。

## 7. 验证

1. `curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:7777/` 返回 `200`
2. 发一条消息能流式返回（说明 `PI_SCRIPT` 与模型凭证都对）
3. 启动日志有 `[env] loaded env file(s): …`
4. `/extensions` 页面可打开，条目数正常
5. live 会话页顶部出现「◲ 上下文」按钮，打开后总览有类别占比；点「刷新」能重新读取。若是会话里的 Pi 还没重载过这款新扩展，窗口会直接提示去重载（重载后重新打开即可）