# Android 5.76 (build 107)

## 修复

- 从「模型与服务商」列表直接编辑 `openai-codex` 等只存在于 pi auth 的 Provider 时，自动使用预设的 API 类型和 Base URL。
- 之前默认使用 `openai-completions` 加空 Base URL，保存后可能把 Codex 的 SSE/JSON 响应当成普通正文显示。
- 已有错误配置需要重新打开该 Provider，选择 `OpenAI Codex（订阅登录）`，保存后再新建/重启 Pi 会话。

## 说明

- API Key 与自定义模型管理沿用 5.75；Key 只写入 Dashboard 主机，不回显。
- 订阅 OAuth 登录仍由 pi 管理，不在 App 内完成。
- Debug 预发布，尚未完成真机订阅 Provider 验收。
