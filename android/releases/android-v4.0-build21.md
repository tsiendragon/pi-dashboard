# PiDash Android 4.0 · build 21

**Debug APK 预发布版**，尚未完成真机端到端验收。

## 本版：列表页统一到 3.9 的设计语言

3.9 只重画了会话页；本版把机器列表与会话列表也套上同一套 token。

- **共享小组件** `ui/common/Bits.kt`：`StatusDot`（6/8 dp 圆点）、`InfoPill`（事实）、
  `MetaAction`（11 sp 静音动作）、`SectionLabel`。三处页面不再各写一套。
- **机器卡片**：名称 + 状态圆点（工作中=强调色、已连接=成功色、离线=灰）+ 等宽来源地址 +
  一排 pill（`Live 已连接` `3 个主会话` `1 工作中` `需要配对` `Chat 已连接`）+ 右侧「打开 Dashboard →」。
  原来那三行不同字号、不同颜色的句子去掉了。
- **会话行**：状态圆点 + 标题（14/21 中等字重，可两行）+ `★` 置顶 + 等宽 cwd + pill
  （`已接管` `provider/model` `思考等级` `#标签`）+ 右侧「分组」；分隔线降到 30% 不透明度。
- **分组头**：`▾ 名称 2`，不再是 40 dp 高的 TextButton。
- **全局 shape 尺度**：`extraSmall 6 / small 8 / medium 12 / large 16 / extraLarge 20`。
  Material 的对话框取 `extraLarge`，所以所有 AlertDialog 一次变成 20 dp 圆角，边框卡片与 chip 也统一。
- 设计稿 `docs/design-preview.html` 增补机器卡片与会话行的对照。

## 安装

- 包名 `com.sam.pidash`，minSdk 26；同签名覆盖安装保留配置与配对。

## 已验证与限制

- 135 项 Android JVM 单元测试通过；APK 构建、包版本、签名核验通过。
- **纯视觉改动，未真机验证**：圆点色在暗色下的辨识度、两行标题的截断、窄屏 pill 换行需真机确认。
- 普通 Chat 页（旧 slot 协议）仍是 Material 默认外观，未套新 token。
