# PiDash Android（原生 Compose 客户端）

一个 **Kotlin + Jetpack Compose** 的原生 Android 客户端，用一个界面**汇总多台机器**上的 pi agent 会话。

> 设计见 [`../docs/android-app-design.md`](../docs/android-app-design.md)。
> 网络接入见 [`../guide/remote-access-deployment.md`](../guide/remote-access-deployment.md)。
> **进度 / 交接 / 验证证据 / 已修问题清单见 [`HANDOFF.md`](./HANDOFF.md)**（唯一权威来源）。

## 与旧版的关系

本目录原先是一个 **WebView 壳**（把 dashboard 的 web 前端套进 WebView，面向 Boox 墨水屏）。
现已改为**纯原生 Compose** 实现（旧实现保留在 git 历史 `b00f94b`，可回退）。

## 当前进度

| 里程碑 | 内容 | 状态 |
|---|---|---|
| A1 | 工程骨架（Compose + 主题 + 导航） | ✅ 代码就绪 |
| A2 | 后端管理（增删改 + 连通性测试） | ✅ 代码就绪 |
| A3 | 会话列表（REST + WS 实时刷新） | ✅ 代码就绪 |
| A4 | 会话页（消息流 + 输入 + 停止 + 流式） | ✅ 代码就绪 |
| A5 | 多后端聚合 + 机器标签 | ✅ 代码就绪 |
| A6 | 重连（已有指数退避）/ 去重 / 通知 | 🟡 重连已有；通知未做 |
| — | 文件 / 终端 / 任务 / 用量 页面 | ⬜ 未做 |
| — | 模型切换、图片附件、标签编辑 | ⬜ 未做 |

详细进度、验证证据、已修问题清单与剩余缺口 → **[`HANDOFF.md`](./HANDOFF.md)**。

> **验证状态**：已在本机用 kotlinc（Kotlin 2.0.21 + Compose 编译器插件 + 序列化插件 + 完整依赖）
> 对全部 15 个 `.kt` 文件做过**纯 Kotlin 编译**：**0 error / 216 class**，仅剩 3 条精简 classpath 造成的假警。
>
> **尚未验证**：AGP/Gradle 真实构建（R 类、资源合并、manifest 合并、dex）与真机运行。

## 版本

| 组件 | 版本 |
|---|---|
| Gradle | 8.9 |
| AGP | 8.7.3 |
| Kotlin | 2.0.21 |
| Compose BOM | 2024.10.01 |
| compileSdk / targetSdk / minSdk | 35 / 35 / 26 |
| JDK | 17 |

> ⚠️ 注意：旧工程的 wrapper 曾是 Gradle 9.5.0 而 AGP 是 8.5.2（互不兼容，构建不了）。
> 现已统一到上表版本。若 Android Studio 提示升级 AGP/Gradle，可接受其建议。

## 构建

用 Android Studio（含 JDK 17 + SDK 35）打开 `android/` 目录，或命令行：

```bash
cd android
./gradlew assembleDebug          # 产物：app/build/outputs/apk/debug/app-debug.apk
```

安装：

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## 看的东西

- 服务器地址与凭据在 App 内配置（A2 起）
- 认证：只需**边缘（nginx）凭据**一个，REST 与 WebSocket 都会带上 `Authorization` 头（token 留空则不带）
- 多台机器：每台一个独立连接，列表里用标签区分来源
