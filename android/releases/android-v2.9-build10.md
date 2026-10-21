# PiDash Android 2.9 · build 10

**Debug APK 预发布版**，尚未完成真机端到端验收。

## 修复：向左滑动会把整页拖走

「WebUI 渲染」里只要有一行超长代码、宽表格或 mermaid 图，页面就会比屏幕宽，WebView 于是允许**整页横向平移**。
现在从两侧同时收紧：

- 页面：`html` / `body` / `#root` 禁止横向溢出；表格与代码块各自在卡片内横向滚动；mermaid SVG 限宽；
  `touch-action: pan-y` 只接受纵向手势。
- WebView：关闭 `overScrollMode`、横向/纵向滚动条，`useWideViewPort=false`、`loadWithOverviewMode=false`，
  不再放大或整页平移。

现在横向手势不会移动整页；需要看长代码时在该代码块内横滑即可。

## 安装

- 包名 `com.sam.pidash`，minSdk 26；同签名覆盖安装保留配置。
- 仍需原有私有 HTTPS 入口授权 + 网页一次性配对码；下载 APK 不等于取得服务器权限。
- 配对身份 30 天需要重启一次 Dashboard 才生效。

## 已验证与限制

- 78 项 Android JVM 单元测试通过；APK 构建、包版本、签名核验通过。
- 实机滚动手感（尤其超长代码块、mermaid 大图）仍需真机验收。
