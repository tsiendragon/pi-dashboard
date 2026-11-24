# Android 5.73 (build 104)

## 语音润色模型路由

- 主模型改为 **DeepSeek V4.1 Flash**，thinking high。
- 主模型失败后依次尝试：
  1. **Claude Haiku 5.5**，thinking medium
  2. **GPT-6 Luna**，thinking medium
- Claude/GPT 使用 OpenCode Go 凭据：优先 `OPENCODE_API_KEY`，否则读取 pi `auth.json` 的 `opencode-go` key。
- 单次润色总等待上限约 35 秒；三路都失败、超时或旧 Dashboard 不支持时，自动使用原始识别文本。
- 仍然只发送最近 3 条用户/助手正文、当前草稿、会话标题和 cwd；不发送录音、思考、工具输出或完整历史。
- 设置页的「识别后润色」和「润色参考最近对话」开关继续生效。

## 依赖

- 需要更新并重启 Dashboard，覆盖安装本 APK。
- 主模型需要 `DASHSCOPE_API_KEY`；fallback 需要 OpenCode Go 凭据。任一模型不可用都会继续尝试下一路，最终失败则保留原文。
- Debug 预发布，尚未完成真机弱网、模型额度和 fallback 时延验收。
