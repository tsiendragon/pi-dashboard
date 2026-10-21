# PiDash Android 2.8 · build 9

**Debug APK 预发布版**，尚未完成真机端到端验收。

## 本版：正文里的网址可以点了

- `http(s)` 链接改为交给**系统浏览器**打开（`ACTION_VIEW`），不再被静默拦掉。
- 渲染页依旧**永不导航**：只把链接上报给原生 `PiDashNative.openUrl(url)`。
- 只允许 `http(s)`：`javascript:`、`intent://`、`file://`、含空格/控制字符的一律拒绝；
  链接还必须出现在当前已渲染正文中，和文件路径同一套白名单。
- 路径预览（2.7）保持不变。

## 安装

- 包名 `com.sam.pidash`，minSdk 26；同签名覆盖安装保留配置。
- 仍需原有私有 HTTPS 入口授权 + 网页一次性配对码；下载 APK 不等于取得服务器权限。
- 配对身份 30 天那条需要重启一次 Dashboard 才生效。

## 已验证与限制

- 78 项 Android JVM 单元测试通过（新增链接 scheme 白名单：http(s) 通过，javascript/intent/file/含空格拒绝）；
  APK 构建、包版本、签名核验通过。
- 真机点击行为仍待验收。若某段文字或链接仍点不动，请给出**原文片段**（不要发文件内容或 token）。
