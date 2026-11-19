# PiDash Android 5.47 · build 78

Debug 预发布版，保持原有稳定签名；尚未完成真机验收。

## 说明

这是一个**维护包**：自 5.46 起 Android 侧没有代码变化，版本号和 `versionCode` 递增只是为了与最新 `master` 同步，并提供可覆盖安装的递增版本。功能、界面和数据逻辑与 5.46 完全相同。

本周期合入的改动不在 APK 内：

- Web 端修复单个 `proof_solve` / `proof_solve_status` 工具结果返回后卡片消失的问题，属于 Dashboard 前端，需重新构建前端后生效。
- `vitest.backend.config.js` 纳入 Lark gateway 测试，属于测试配置，不影响 App。

如果你只是要 proof 工具卡片修复，更新 Dashboard 前端即可；这个 APK 不需要重装。

## 验证

- 全部 Android JVM 测试通过。
- Roborazzi 截图校验通过。
- `phoneEndToEndVerified: false`。

## 安装

覆盖安装即可；无需重启服务或重载扩展。
