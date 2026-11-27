# Android 5.78 (build 109)

## 语音识别技术词上下文

- 开始录音时，App 通过现有 ASR WebSocket 发送一帧 `context`，不放进 URL 或访问日志。
- 上下文包含：
  - 常用技术词表
  - 会话标题和 cwd
  - 当前草稿
  - 最近 3 条用户/助手正文
- 服务端把它写入 Qwen 实时 ASR 的 `session.input_audio_transcription.corpus.text`，帮助纠正 API、session、WebSocket、路径等术语。
- 设置页新增「语音识别参考技术上下文」开关，默认开启；关闭后只发送音频。
- 上下文只用于识别，不替代 5.76 的润色链路；ASR 本身仍需要停止录音后写入草稿。

## 生效

- 需要更新并重启 Dashboard，再覆盖安装 APK。
- 上下文会随音频发送给 DashScope ASR；不发送工具输出或完整历史。
- Debug 预发布，尚未完成真机中英混合、技术词和弱网验收。
