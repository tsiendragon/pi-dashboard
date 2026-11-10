# PiDash Android 5.39 · build 70

Debug 预发布版，保持原有稳定签名；尚未完成真机验收。

## 需要你处理的请求，改成会话里的卡片

- Agent 停下来提问时不再自动弹出模态框抢走键盘：输入框上方出现一张 `需要你处理` 卡片。
- `confirm` 请求可以在卡片里直接「允许 / 拒绝」；失败原因留在卡片上，不会自动重试。
- `sudo` 请求仍走专用密码弹窗（卡片上写「查看授权」，不会在卡片里收密码）；`select` / `input` / `editor` 打开现有对话框。
- 同时有多个请求时显示「还有 N 个」，按顺序处理；已处理的请求即时消失。
- 后台通知：`confirm` 增加「允许 / 拒绝」动作，点通知就能答复；锁屏只显示不带会话名与请求内容的公共版本，解锁后才出现按钮。`sudo` 与自由文本请求只提供「打开会话」，绝不在锁屏收集密码或文本。

## 排队中的消息可见、可撤回

- 输入框上方显示「排队 N 条 + 第一条内容」，点「查看」打开列表：逐条显示投递方式（引导/排队）、图片数与来源端。
- 每条可单独「撤回」，只撤回还没交给 Pi 的那一条；已开始执行的会写明「正在发送」，不提供假撤回。
- 依赖扩展新增的 `input_queue` capability 与 `get_queue` / `cancel_queue_item` 命令；旧扩展自动隐藏排队条。扩展侧改动需要 `/reload` 生效，Dashboard 需要重启。

## 设计契约与自动门槛

- 新增 `docs/android-ui-contract.md`：底线条款、唯一组件表、文案语气与有意保留的例外。
- `DesignTokenGuardTest` 增加两条自动检查：所有 `AlertDialog` 必须带 `Radii.sheet`；`fontSize` 必须来自 `PiType`（或用 PiType 缩放）。

## 验证

- 全部 Android JVM 测试通过；新增 `ApprovalCardTest`、`QueuedPromptsTest`、通知动作与队列协议测试。
- 扩展侧 336 项测试中 335 通过；唯一失败 `ptc-code-mode` 是既有的本机 Node 不支持 TypeScript 的宿主环境问题，与本次改动无关。
- Dashboard 新增队列命令的协议与租约测试通过（44 项）。
- 截图仅覆盖组件（明/暗/200% 字号），不等于整页或真机验收；`phoneEndToEndVerified` 仍为 false。

## 安装 / 生效

覆盖安装 APK；扩展改动需在 Pi 会话里 `/reload`，Dashboard 后端改动需按用户自己的方式重启 `./run.sh`。
