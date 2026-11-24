# Android 5.75 (build 106)

## 模型与服务商

- 设置页新增「模型与服务商」入口。
- 支持添加/编辑服务商和自定义模型：
  - OpenAI、Anthropic、DashScope、OpenRouter、OpenCode Go、DeepSeek、MiniMax、Gemini、Kimi、GLM
  - OpenAI Codex（订阅登录，只读凭据状态）
  - 自定义 OpenAI 兼容服务
- 可配置 Base URL、API 类型、API Key、模型 ID、名称、上下文窗口、最大输出、思考与图片能力。
- API Key 只发送到 Dashboard 并写入主机 `models.json`（0600）；App 和读取接口都不回显 Key。
- 保存会备份并原子写入；新模型会自动加入非空的模型允许列表。
- 订阅/OAuth 登录仍由 pi 管理，本页只显示状态；Claude 消费级订阅不能作为 Anthropic API。这个版本不支持在 App 内完成订阅 OAuth 登录。
- 保存后需要新建或重启 Pi 会话，运行中的会话不会自动加载新模型。

## 依赖

- 需要更新并重启 Dashboard，再覆盖安装 APK。
- 需要 Dashboard 的浏览器登录 Cookie；API Key 写入使用 HTTPS 时最安全。
- Debug 预发布，尚未完成真机长表单、软键盘和真实 Provider Key 验收。
