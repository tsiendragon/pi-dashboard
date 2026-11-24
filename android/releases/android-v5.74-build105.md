# Android 5.74 (build 105)

## 语音润色 fallback 调整

- 移除 OpenCode Go fallback，不再读取或使用 OpenCode Go 额度。
- 主模型仍为 **DeepSeek V4.1 Flash**，thinking high。
- **Claude Haiku 5.5**，thinking medium：仅在配置 `ANTHROPIC_API_KEY` 时尝试。
- **GPT-6 Luna**，thinking medium：使用 pi 的 OpenAI Codex 订阅登录（`auth.json` 的 `openai-codex`）。
- 模型按 DeepSeek → Claude → GPT 顺序尝试；缺少凭据的模型跳过，全部失败、超时或旧 Dashboard 不支持时保留原始识别。
- Claude 消费级订阅不是 Anthropic API 凭据；没有 `ANTHROPIC_API_KEY` 时不会调用 Claude，也不会使用 Claude Code OAuth 伪造第三方 API 请求。
- 仍然只发送最近 3 条用户/助手正文、当前草稿、会话标题和 cwd，不发送录音、思考、工具输出或完整历史。

## 依赖

- 需要更新并重启 Dashboard，再覆盖安装 APK。
- 主模型需要 `DASHSCOPE_API_KEY`；Claude fallback 可选配置 `ANTHROPIC_API_KEY`；GPT fallback 需要本机 pi 的 OpenAI Codex 登录有效。
- Debug 预发布，尚未完成真机、订阅额度和 fallback 时延验收。
