# PiDash Android（原生 Compose 客户端）

一个 Kotlin + Jetpack Compose 外壳，加上**离线打包的 WebUI 渲染器**。**2.6 / build 7：机器列表 → 本机 Dashboard → Session**；本机默认 Live Pi，普通 Chat 保留在独立标签中，不把旧 Chat slot 假装成 Live 进程。机器列表、Dashboard、设置页显示实际构建版本。

- **APK 下载与每版更新说明**：[GitHub Releases](https://github.com/tsiendragon/pi-dashboard/releases)（当前为预发布版；下载后由用户确认覆盖安装，不是 App 内自动更新）
- **部署、构建、手机配对与验收**：[`guide/dashboard.md`](../guide/dashboard.md#android-live-pi26)
- **当前进度、测试证据与限制**：[`HANDOFF.md`](HANDOFF.md)
- **功能适配与边界评估**：[`逐机器 Dashboard 设计`](../docs/android-machine-dashboard.md)
- 历史设计：[`docs/android-app-design.md`](../docs/android-app-design.md)

## 当前功能（代码已实现，未做真机端到端验收）

| 功能 | Live Pi 2.2 |
|---|---|
| 机器列表、本机 Dashboard、与网页共享在线会话 | 已实现，专用 REST + WS；分开显示 Live 配对/连接与普通 Chat 连接 |
| 搜索、工作中/子 Agent 筛选、分组与顺序 | 已实现；共用网页分组/置顶/排序；可新建分组和移动会话；完整分组管理与拖动排序暂用网页 |
| 活动进度 / 完整对话、只读目标/工作项/阻塞 | 已实现保守投影，不编造百分比，不把工具返回或最终回复等同任务完成 |
| 默认新建 Live Pi、选择服务器和工作目录 | 已实现：服务器 roots / 项目候选 / 手填绝对路径；服务器最终校验权限 |
| 文本渲染（Markdown/表格/代码高亮/公式/图形/图片） | 默认用 **WebUI 同一套 React 渲染器**（react-markdown + GFM + highlight.js + mermaid + DiffBlock），离线打进 APK，无网络无凭据；「原生文本」可切回 |
| 流式/思考/工具进度/错误 | 已实现；工具卡显示名称、执行中/失败状态，正文同样走 WebUI 渲染 |
| 输入（与网页、TUI 同时输入） | 已实现：普通消息/改名/切模型/重载**不需要接管**，与 WebUI 规则一致 |
| 图片附件 | 已实现：相册多选（最多 4 张），本地校验并压缩到协议上限（单张 3 MB、合计 6 MB），失败保留草稿与附件 |
| 中止、压缩、重启 | 需要显式接管，不抢占他端；他端持有时直接拒绝 |
| 标题、模型、思考等级、置顶/标签 | 已实现 |
| 压缩、重载、重启 Pi、真实用户条目分叉 | 已实现；危险操作需确认，服务器可拒绝 |
| 扩展确认/选择/输入/编辑请求 | 已实现，必须明确回答，不自动确认 |
| 上下文/会话树 | 只读 JSON 预览，不是完整图谱 |
| 文件/上传、PTY、完整工作流、目标编辑、用量、图片附件、语音、后台通知 | 尚未实现，请用 WebUI；目标只读摘要不等于管理能力 |

普通 Chat 仍使用原来的 `/api/chat/slots`、`/api/ws` 与独立对话页。Live Pi 使用 `/api/live-sessions`，不会回退创建普通 Chat。

## 授权与网络

服务器原有连接凭据仍用于入口认证。**Live Pi 另需网页生成的一次性手机配对码**；不要把主机控制 token 填进 App。配对身份相互独立，打开列表/会话不会接管。

Live 要求 HTTPS（仅本机回环测试可用 HTTP），没有跳过证书校验。可沿用现有私有 VPN 和域名；不会自动配置隧道、公网入口或 DNS。已退休的实验性远程接入客户端不在本应用内。

Live Cookie 用 AndroidKeyStore AES-GCM 加密，并绑定服务器地址/连接凭据；不迁移到其他设备。App 禁止云备份及设备迁移备份；直接覆盖安装 APK 则保留原有 App 数据。原有服务器配置仍由 `BackendStore` 管理，不宣称全部凭据已迁移到硬件密钥库。

## 构建产物与版本

产物：`android/app/build/outputs/apk/debug/app-debug.apk`。构建与安装命令以[部署指南](../guide/dashboard.md#android-live-pi26)为准。**渲染器源码在 `frontend/native-renderer/`，改动后先 `npm --prefix frontend run build:native-renderer` 再构建 APK。**

| 组件 | 版本 |
|---|---|
| App | 2.6 / versionCode 7 / `com.sam.pidash` |
| Gradle / AGP | 8.9 / 8.7.3 |
| Kotlin / Compose BOM | 2.0.21 / 2024.10.01 |
| compileSdk / targetSdk / minSdk | 35 / 35 / 26 |
| JDK / JUnit（测试） | 17 / 4.13.2 |

不要为了部署本功能随意升级构建工具；本机已完成离线 Gradle 单元测试与 APK 构建，但这不等于手机安装、TLS/入口认证、实时会话控制都已验收。
