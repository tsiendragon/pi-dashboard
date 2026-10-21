# ③ pi-dashboard Web 服务

> 当前仓库。前端 React + TypeScript + Vite，后端 Express + WebSocket，终端走 node-pty。
> 它为每个会话 slot 起一个 `pi --mode rpc` 子进程，并把 ② 的扩展能力暴露成页面。

- 仓库：`github.com/tsiendragon/pi-dashboard`
- 默认端口：`7777`

---

## 表情包工坊

侧栏「表情包」（`/memes`）是给聊天做表情的小工作台：左边写要求，右边看结果。宽屏是左右两栏，窗口变窄后改成上下排列。

### 界面导览

页面顶部一行标题「表情包工坊」，下面一句副标题「说说你想表达什么，生成一张自己的聊天表情。」宽屏是「左边表单 + 右边结果」的工作台：左栏自己滚动，生成按钮固定在底部常驻，右栏大图和历史不会再被表单挤到屏幕外；窗口变窄后改成上下排列。左栏叫「创作要求」，可滚动区域从上到下依次是：

1. **图片服务**：下拉框选 DashScope 或 Azure；右边的「刷新」按钮会重新读一次服务与模型清单，读不到时会在这里报错。
2. **图片模型**：下拉框列出该服务下已登记的模型。每个选项后面跟着说明：`· 文字/参考图` 表示两种用法都接好了，`· 仅接入文字` 表示不能传参考图；末尾再跟 `· 已出图`、`· 上次失败` 或 `· 未实测`。没配置好的项显示 `· 未配置` 且点不动。
3. **模型说明**：一行小字写真实模型标识（例如 `模型：qwen-image-3.0`），下面一行可展开的「实测：… 详情」：默认只显示状态点和一句话结论，展开后才有两种模式的实测日期、耗时和失败原因。这些只说明接口能返回图片，不代表每次画面和文字都对。
4. **想做什么表情？**：主要输入框，最多 2000 字，右上角有字数计数。灰色示例提示可以写成「一只困得睁不开眼的橘猫抱着咖啡，配字『再睡五分钟』」这种画面加文字的形式。需要出文字就把原句写出来，生成后自己检查错别字。
5. **画风**：六个可直接点的标签——自由发挥、猫猫表情、手绘简笔画、可爱贴纸、夸张搞笑、像素风，选中的高亮。选「自由发挥」就不额外限制风格。
6. **参考图（可选）**：虚线框里点「选择图片」选一张 PNG、JPEG 或 WebP，最大 8 MiB，用来借用照片里人物或宠物的形象。选好后换成缩略图、文件名和「移除」按钮。也可以先复制图片（截图、右键复制都行），在这个页面上直接按 Ctrl+V / ⌘V 粘贴，效果和选文件一样。当前模型没接参考图时，上传区会变灰并提示换模型；换到这类模型时已选的图会被清掉。
7. **费用参考**：卡片写这次大约花多少钱、适用范围、官方价格说明链接和核对日期；没核实到单价时会直接标「单价待核实」。它只是按官方价推算，不含折扣、免费额度和税费，真实金额以账单为准。
8. **生成一张**：固定在左栏底部的主按钮，滚动表单时始终可见（窗口窄时同样钉在视口底部）。描述为空、模型没配好、当前模式不支持、服务列表还在加载或读取出错、参考图还在读取、正在生成时，按钮都是灰的。每点一次只出一张，生成中显示「正在生成…」，出过图后文案变成「再生成一张」。提交后由服务端继续生成，关掉页面也不会中断。

按钮下面一行小字提醒（窄屏隐藏，避免遮住内容）：每次点击可能产生费用、不会自动重试、提交后后台继续执行、离开页面不会中断。

右栏是「生成结果」：

- 标题右边是状态徽标「已生成／生成中／失败」，再往右是「刷新」按钮；下面一行小字写「共 N 条记录 · 保存在 <目录>」，目录默认是 `~/.pi/dashboard/memes`，可以用 `MEME_OUTPUT_DIR` 改，旁边的「复制」会把目录放进剪贴板（显示「已复制」）。
- 还没结果时是一块居中的空状态：写「还没有生成过表情」，并给「再睡五分钟 / 下班啦 / 你说得都对」三个示例按钮，点一下就把那段描述填进输入框。
- 有任务在后台跑时会提示「后台正在生成…，已等待 X 分 Y 秒」，右侧预览区显示转圈和当前模型；页面在有任务运行时每 2.5 秒刷新一次历史，任务结束后停止刷新；窗口重新获得焦点或切换回来时也会立刻刷新一次。
- 出图后是一块大幅预览区（等比缩放不拉伸），下方一行小字写模型、服务商、时间、耗时和文件大小；右边两个动作：「用这条描述再生成」把这条记录的文字、画风和模型填回左侧表单（不自动提交），以及「下载图片」。服务只给临时链接时后者变成「打开原图保存」并提示链接会过期；图片打不开时会提示「图片加载失败，临时链接可能已过期」，不显示破图。再下面是这次用的描述原文。
- 预览区下面是「历史记录」：按时间从新到旧列出全部记录（默认最多显示最近 500 条，超过 60 条时给「加载更早的记录」），每个缩略图下面带日期和时间，点一张就切到那张的预览，选中的有蓝色描边；还在生成的显示转圈，失败过的显示红色叹号，鼠标停在上面能看到状态和完整描述。

出错提示都写在对应位置：浏览器没认证会提示先去「在线会话」页完成认证（错误块里带链接）；没有权限、服务列表读不到、两家服务都没配好（显示「暂无可用的图片服务」）、生成失败，都各给一句话和下一步该怎么办，不会只转个圈。

### 模型、费用与接口

侧栏「表情包」（`/memes`）用于输入描述、选择画风，可选上传一张 PNG/JPEG/WebP 参考图（最多 8 MiB）。后台通过 DashScope 或 Azure 生成，一次一张；服务进程同时只接收一个生成请求，不自动重试付费调用。用户可以先选服务商，再直接选该服务下的已登记模型。当前接入 Qwen 3.0/3.0 Pro/2.0/2.0 Pro、Z-Image Turbo、GPT Image 2.5 Sunburst/2.5 Flare/2/1.5、FLUX.1 Kontext Pro、FLUX 1.1 Pro、FLUX.2 Pro 和 MAI Image 2e。默认选 Qwen `qwen-image-3.0`（非 Pro）与 Azure `gpt-image-2.5-sunburst`。Qwen、GPT Image、FLUX Kontext 和 FLUX.2 Pro 接入文字生成及参考图加文字生成；Z-Image、FLUX 1.1 Pro、MAI 当前仅接入文字生成。FLUX 1.1 Pro 及 FLUX.2 Pro 使用 Foundry BFL 接口，后者参考图为 `input_image` base64，页面已开放上传。追加实测使用英文描述，页面模型说明提示建议英文；没有验证所有中文描述。FLUX.2 Flex 虽出现在目录但实际未找到部署，未加入列表。切换到未接入参考图的型号会清除已选参考图，并禁用上传。模型目录可见不代表已有部署或真实可调用；自定义部署必须先登记到后端白名单，页面不接受随意填写名称。当前默认以官方 [Qwen 图片接口](https://www.alibabacloud.com/help/en/model-studio/qwen-image-generation-and-editing-api-reference) 和 [Azure 图片生成说明](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/dall-e) 为依据，而不是 Toolkit 的旧默认模型。页面显式提交用户选择的 `model`，不必为切换模型修改 `.env`。环境中的旧模型配置只作为未显式传 `model` 的兼容调用默认；初始页面若无法匹配已登记默认值，会选择 Qwen 3.0 或 GPT Image 2.5 Sunburst。配置项见 [配置总览](config.md) 的图片服务环境变量，密钥只在后端读取；沿用 Toolkit 的请求格式，无需安装 Python SDK。DashScope 默认使用新加坡地址，密钥地域必须匹配；其他地域请设置完整图片接口地址，不要填聊天或语音接口。Azure 基础地址不带 deployment 路径，原生 Azure API key 需设置 `AZURE_OPENAI_IMAGE_AUTH=api-key`；默认 `bearer` 用于 Toolkit 风格网关。

生成页面要求先完成现有浏览器认证；未认证时按页面提示，到在线会话页完成认证。参考图和描述会发送给所选第三方服务，不要上传敏感照片。生成在服务端执行：提交后立刻返回一条「生成中」记录，浏览器离开页面、刷新或关掉标签页都不会中断这次请求；回来时页面会从本机历史里读出结果。图片保存在 `~/.pi/dashboard/memes`（可用 `MEME_OUTPUT_DIR` 改），服务商只给临时链接且不在其域名内时，会退化为只保留链接并明确提示。服务进程重启时仍在跑的记录会被标记为失败，因为那次调用已经无法追踪。不写入会话记录。请求超时不等于上游取消，稍后重试可能产生额外费用。

页面在模型名下显示所选模型、模式对应的「费用参考」。按已核实的新加坡标准价：Qwen 3.0 的 1K/2K 输出 US$0.030/张，加一张参考图合计 US$0.033/次；Qwen 3.0 Pro 的 1K/2K 输出分别 US$0.040/0.075，加一张参考图另收 US$0.003；Qwen 2.0/2.0 Pro 分别 US$0.035/0.075 每张输出；Z-Image Turbo 按提示词改写关闭/开启为 US$0.015/0.030 每张。未接入参考图的型号不提供编辑报价。其他地域和 Azure 未核实的资源价格标注待核实，不把 OpenAI API 单价当成 Azure 单价。注明官方来源与核对日期（2026-10-19），不含折扣、免费额度和税费，以账单为准。

后台提供 `GET /api/memes/providers`、`POST /api/memes/generate`、`GET /api/memes/jobs`、`GET /api/memes/jobs/:id` 与 `GET /api/memes/images/:id`，均要求浏览器认证。服务列表包含 `models`（标识、名称、`modes`、是否配置、生成/参考图各自的价格和 `verification`）与 `defaultModel`，旧字段保留。`t2i` 表示文字生成图片，`it2i` 表示参考图加文字生成图片。生成接口接收 `provider`、`model`、`prompt`、可选 `style` 和 `referenceImage`（图片 data URL）；后端校验模型白名单、服务商与模式，不会通过不支持的接口偷偷忽略参考图。校验通过后立即返回 `202` 和一条 `running` 记录，真正的调用在后台继续；同一进程同时只接一单，第二单返回 `429` 并带上正在跑的那条记录。历史接口返回 `{ jobs, outputDir }`，最新的在前，默认 100 条、最多 500 条；记录里的 `imageUrl` 指向本机保存的图片，只有临时链接时给 `remoteUrl`。图片接口按 id 返回保存的文件，支持 `?download=1` 触发下载；id 不合法或文件不存在返回 404。未传 `model` 的旧调用仍兼容环境默认值。所有响应都不返回密钥或原始上游错误。

下拉菜单和模式说明区分别显示已出图、上次失败或未实测，注明核对日期。状态来自一次性真实测试记录，只证明接口返回图片，不保证质量和未来仍可调用。记录按服务地址指纹匹配，换资源地址会显示未实测，不把本机结果套到其他机器；指纹与实际地址不返回浏览器。测试清单和证据见 `docs/meme-model-validation.md`。

可将不含密钥的图片服务地址和模型写入仓库 `.env`（加载顺序见 [环境配置](env-configuration.md)）；密钥继续由启动环境注入，不要提交到 Git。自检显示「已配置」只表示变量齐全，不代表密钥有效、模型可用或真实出图成功。

此改动需要用户自行执行 `./run.sh` 构建前端并重启后端后生效；agent 不代为部署。重启使用的环境也必须包含相应图片服务密钥。真实接口连通性、计费和出图质量需使用实际配置验证。

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
- 正文中的本地路径可点击预览（2.7+）。点击解析是**委托到页面根部**的：代码片段、本地链接、以及普通正文里
  形如 `路径/文件名.扩展名` 的片段都可点（`MarkdownRenderer` 自身只认 code/link，prose 里的路径以前点不动）。渲染页只把路径交给原生：`window.PiDashNative.openPath(path)`，
  原生校验该路径**必须出现在当前已渲染的正文里**，否则丢弃——渲染内容无法诱导 App 读取读者没看见的文件。
  预览走 App 自己的已授权客户端 `GET /api/file-read`（只读，最多 512 KB 尾部），不新增服务端权限。
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

App 版本 2.8 / versionCode 9，包名仍为 `com.sam.pidash`，可覆盖安装。依赖 JDK 17、SDK 35、
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

## 会话颜色与符号

会话行的调色板按钮（桌面悬停或键盘聚焦时显示），以及「⋯ → 会话装扮」，可选择 18 种颜色预设，也可用系统颜色选择器自选颜色；表情提供 8 类快捷选项，还可通过 iPhone 等设备的表情键盘输入或粘贴。快捷选项不是完整的 iPhone 表情库，新表情是否能显示取决于查看设备的系统和字体，不保证旧设备支持。列表与预览中的符号为 12px，选择按钮保持便于点击的大小。弹窗先预览，「保存」才生效；取消不写入。「恢复默认」清空颜色与符号，仍需保存。颜色只显示在行左侧的细条，符号放在标题前，不替代运行状态、不更改名称或分组。保存失败保留弹窗与草稿，允许重试。

沿用 `GET /api/live-session-meta` 与 `PATCH /api/live-sessions/:processInstanceId/meta`，在既有会话元信息中增加可选的 `color`（`#RRGGBB`）和 `emoji`（去掉首尾空白后最多 24 个 UTF-16 单元，不含控制字符）；空字符串清除对应字段，不传则保持不变。数据按持久会话标识保存在现有元信息文件中（路径可由 `PI_DASH_LIVE_SESSION_META` 指定），旧数据无需迁移；装扮不影响标签、置顶或终端关联。它是当前 Dashboard 的共享会话设置，不是各浏览器独立的私有偏好。其他浏览器重新加载列表后可读到相同设置。

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

### 每日代码改动行数

Cost 页有“每日代码改动行数”卡片，数据来自本机 Pi session 文件里 `edit` / `write` 工具调用的写入内容，因此包含尚未提交的改动，和 git 的 diff 统计不是一回事：

- `edit` 的 `newText` 行数计入新增，`oldText` 行数计入删除。
- `write` 第一次写某个文件时把整份内容算作新增；同一 session 内再次写同一文件，只按总行数差额计新增或删除，不会把整文件重复算一遍。
- 按文件扩展名分「代码」和「文档/其它」两桶，卡片右上角可在「仅代码」和「全部文件」之间切换。
- 月份选择器与费用统计共用；首屏扫描约 6–10 秒（缓存后再算约 1 秒），扫描期间卡片会显示“仍在统计历史 session…”并每 3 秒自动重试。
- 后端接口 `GET /api/code-churn?month=YYYY-MM&timezone=…`，会话目录由 `PI_DASH_SESSIONS_DIR` 指定（默认 pi 的 `sessions` 目录）。

行数统计只看 `edit` / `write`，`bash` 里的重定向、`run_code` 里的脚本写文件都不会被计入。

## 子 Agent 触发与成功率

Cost · Time 页第四个标签「子 Agent」统计每次派发和它的结果。数据来源是子 Agent 扩展写的追加式台账 `<agent dir>/subagent-jobs.jsonl`：每次创建子任务写一行、每次结束再写一行，同一个 `workId` 以最后一行为准。

- 卡片：触发次数、成功、失败、成功率。成功率 = 成功 ÷（成功 + 失败）；**主动取消和进程中断不算失败也不计入分母**，它们单独显示。
- 图表：7 天或 30 天的每日堆叠柱（成功 / 失败 / 取消 / 中断 / 进行中）。
- 分组：按 `role`、按 `tier`、按实际运行模型（自动切换后算切换后的那个）。省略 `role` 的记录并入 `code`。
- 工作流按**整次派发**算一条，内部子任务数量（成功/失败）从工作流结果里取出来单独显示，所以「触发次数」不等于子 Agent 进程数。
- 接口 `GET /api/subagent-stats?days=7&timezone=…`，`days` 限制在 1–90。

限制：台账只记本机 Pi 进程的派发，并且只从升级后开始记；升级前的历史派发不在文件里。远程 dashboard 读的是它自己机器上的台账，看不到另一台机器的记录。台账是普通 JSON 行，可以删掉重建，但删了就丢历史。

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
| `POST /api/services/*` | 有 cookie/token 认证（页面上的启停按钮）；其余 `/api/services` 读接口无认证 |

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
| Jira 链接与状态 | 任务卡片和任务详情页都显示可点链接（新标签页打开）。Jira 号来源：`jira_key` → `key` 本身就是号（`PROJ-104`）→ 都没有就不显示（未绑定是正常状态）。卡片上的 Jira 徽章带状态色点与真实状态名（`Development` / `Done`…），详情页额外显示负责人、优先级、读取时间；**Jira 已 Done 但本地未关（或反过来）会标「状态不一致」**。状态来自本地缓存，只有点「刷新 Jira」才会跑 `acli`，且只重读未完成、未归档的单（跳过的继续显示上次结果）。链接前缀 `tasks.jiraBaseUrl`（**不配就不显示链接**，示例 `https://example.atlassian.net/browse/`），细节见 `guide/config.md` §4.2 |
| 阶段与进度 | 任务卡片显示「阶段 3/6」和当前阶段名（读任务目录里的 `stage-dag.yaml`），Epic 卡片显示子任务完成度进度条 `3/5`（后端按 children 汇总）。详情页头部有同样的阶段进度条。没有 `stage-dag.yaml` 的任务不显示这一格 |
| 最近改动 | 卡片右下角显示「2 小时前」：journal 任务取 `stage-dag.yaml` 的 `updated`，缺省用该文件修改时间；本地任务用记录里的更新时间 |
| `/tasks/events?objectRef=<UID>` | 事件流水账（竖轴时间线，见下）与同页复盘分析；按现有 Task/Epic UID 关联。它是 Tasks 的下一级视图：**不在侧边栏占位**，入口是 Tasks 页顶部的「任务清单 / 事件流水账」切换（任务详情页里也有「在流水账中查看 →」）；旧链接 `/events` 会带上查询参数跳到 `/tasks/events` |
| 全局主 Agent 弹窗 | 主 Agent 入口只在导航栏（窄屏在底部标签栏）出现一次，会话页右侧工具栏不再重复这个图标；同栏“通知”查看最近未处理待办与建议，点击检查进入同一弹窗；其他页面通过导航栏进入；显式启动、记录回复截图、创建/更新可写本地任务 |
| `/extensions` | 扩展装载事实 + 管理，见 `guide/extensions-page.md` |
| `/services` | 服务面板：各服务接口是否应答、页面链接、本机服务的启停，见 `guide/services.md` |
| `/live-sessions` | live session 接管/分叉/导航 |
| `/memory` | 记忆页：只读展示 `pi-tsien-memory` 扩展写入的记忆，见下 |
| `/memes` | 表情包工坊：界面导览与模型、费用说明见本文「表情包工坊」 |
| Workbench | 子 Agent 与 Workflow 面板 |
| Settings → 子任务模型 | 把每个模型分到「不用 / 轻量 / 普通 / 强 / 超强」，调整档内顺序和高级设置；读写 `<agent dir>/subagent-models.json`（`GET/PUT /api/subagent-models`，文件被别处改过返回 409，保存前备份到 `<agent dir>/backups/`）。只改档位文件，不碰密钥；修改后扩展在下次选模型时自动读取，无需 `/reload` |
| `guide/api-reference.md` | 后端 API |
| `guide/config.md` | 配置总览（四层地图、每个 config 谁读、怎么改） |

---

### `/memory` 记忆页

只读页面，数据来自 `pi-tsien-memory` 扩展写的本地记忆库：`PI_TSIEN_MEMORY_DIR`（默认 `~/.pi/tsien-memory`）下的 `memory.db`。dashboard 只读打开、从不写入；这个库的结构和写入方都归扩展所有，页面出现空白或结构不识别时先确认扩展版本，不要在页面侧补字段。

页面自上而下：**总览**（各状态条数、待审核的三类问题、索引积压与失败数、自主管理计数，含「系统自动采纳」）、**记忆列表**（按状态筛选或搜内容，显示来源是否已验证、冲突数、被引用次数）、**变更记录**（谁在什么时候把哪条记忆从什么状态改成什么，附原因代码与内容摘要）、**审核队列**（只列候选，按冲突 → 未验证来源 → 全局作用域 → 其它排序）、**召回效果**（近 N 天的召回次数、注入条数、被验证/被纠正次数、平均耗时、最常被用到的记忆）。

读取需要先完成浏览器认证，未认证时页面提示到在线会话页认证。库还没生成时页面说明「先启动一次 Pi 会话让扩展建库」，不显示成零条记忆。这张页不提供改记忆的入口：采纳、纠正、遗忘仍走扩展的 `/memory` 命令与 `memory_*` 工具；旧接口（`/api/memory/preferences` 等）现在返回 410，见 `guide/api-reference.md`。

---

监督资源（配置、角色/Skill 文本、扩展源码）发生变化时**不再暂停任何通道**：正在跑的主会话继续按启动时的版本工作，主 Agent 读取上下文时会拿到一句 `resourceNotice`（例如「角色或 Skill 内容已更新…建议重启主会话生效」），监督台的 `extensionsStale` 覆盖扩展代码这一种。要让新配置真正生效仍是结束旧主会话再启动，但不需要为了能读写而重启。
写入**没有确认弹窗**：主 Agent 在你说话的这一轮里直接落库，包括把任务标成完成、更正事件、关闭待办，都不需要你点按钮或回「确认」。唯一的写入边界是自动巡查轮——那一轮不带用户授权，网关会拒绝任何创建或修改。写入仍会留下审计：性质、来源会话与主 Agent 身份都记在记录里。
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