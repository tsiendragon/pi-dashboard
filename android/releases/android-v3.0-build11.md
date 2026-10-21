# PiDash Android 3.0 · build 11

**Debug APK 预发布版**，尚未完成真机端到端验收。

## 本版：默认改用原生渲染

不再默认用 WebView。新增纯 Kotlin Markdown 渲染链路：

- `ui/markdown/MarkdownParser.kt`：标题、围栏代码、有序/无序列表（含层级）、引用、表格（含对齐）、分隔线；
  行内支持粗体、斜体、删除线、行内代码、链接、反斜杠转义。纯 Kotlin，有 9 项单测。
- `ui/markdown/MarkdownBody.kt`：Compose 渲染。代码块**不换行、块内横滚**并带「复制」；表格块内横滚；
  裸链接与本地路径可点，跳转/预览回调与 WebView 模式共用。
- `ui/live/NativeTranscriptCards.kt`：步骤卡与消息卡遵循 WebUI 规则（工具一行式、输出默认折叠、
  Run Code 归组、正文超 12 行/1200 字截断）。
- 会话页视图：**原生渲染（默认）** / WebUI 渲染 / 活动进度。

## 已知差距（因此保留 WebUI 渲染）

- 原生暂无代码语法高亮配色、mermaid 图、KaTeX 公式；这些块仍请切到「WebUI 渲染」。
- 原生渲染不处理原始 HTML（WebUI 用 rehype-raw + DOMPurify）。

## 安装

- 包名 `com.sam.pidash`，minSdk 26；同签名覆盖安装保留配置。
- 仍需原有私有 HTTPS 入口授权 + 网页一次性配对码；下载 APK 不等于取得服务器权限。
- 配对身份 30 天需要重启一次 Dashboard 才生效。

## 已验证与限制

- 87 项 Android JVM 单元测试通过（新增 Markdown 解析 9 项）；APK 构建、包版本、签名核验通过。
- 真机排版（表格宽度、超长代码、中文断行）仍需验收。
