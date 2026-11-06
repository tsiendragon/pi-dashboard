# PiDash Android 5.10 · build 41

Debug 预发布版，尚未完成真机与真实 sudo/PAM 端到端验收，不作为已完成生产安全审计的版本。

## 新增：sudo 单次授权

- Live Pi 的 `sudo_exec` 工具发起专用授权弹窗，展示目标主机、完整可执行文件/参数数组与工作目录；确认后只执行该次命令。
- 密码遮蔽输入、不保存到聊天/偏好/会话缓存；授权窗口禁止系统截图，关闭或切后台清空输入。密码只允许经 HTTPS 提交，不经过模型或普通工具参数。
- 专用请求绑定、首答胜出、120 秒授权期限；未授权时工具取消或桥接断线即撤销。失败不自动重试，结果不明时应先检查会话。
- 保持原有稳定签名，可覆盖安装。Web 本版仅显示管理员请求与取消入口，密码授权在 Android 内完成。

## 必须同步更新

这不是仅靠 APK 就能生效的功能。需要本次 Dashboard 服务端代码与 `pi-tsien-live-session` 扩展源码；旧 npm 扩展没有此能力。由用户运行 `./run.sh` 更新服务，并在 Pi 会话 `/reload` 加载扩展。无需修改 pi 宿主、sudoers 或以 root 运行 Dashboard。

本机配套扩展源码提交：`pi-tsien-extension@59869a075fc9d809e692d8704c9c8fb27baaeb7c`（独立仓库；此 APK 发布不等于该扩展已发布到 npm 或远端）。

示例：让 Pi 使用 `sudo_exec`，执行文件 `/usr/bin/id`，参数 `["-u"]`；不要把 sudo 密码发送到聊天中。

## 限制

- 不自动拦截普通 Bash 的 sudo，不是 root 操作沙箱；授权脚本同时意味着信任脚本当时内容。
- 目标机器需 `/usr/bin/sudo`、Unix socket 与可执行临时目录；需 TTY、MFA 或交互输入的策略不支持。
- 使用一次性私有 askpass socket、`sudo -A -k`；目标 stdin 关闭，不复用或刷新 sudo ticket。执行 120 秒时请求停止，但不能保证 root 子进程全部退出或回滚副作用。
- Dashboard、目标主机及扩展必须可信，反向代理不能记录请求体；运行时内存/系统转储不在应用日志清理保证范围内。

## 验证

- 187 项 Android JVM 测试、35 项后端定向测试、22 项前端定向测试，以及 42 项扩展授权/桥接测试通过；两仓类型检查通过，执行器测试使用假 sudo，不执行真实提权。
- `docs:env-check` 仍被既有 Jira 的 `DBUS_SESSION_BUS_ADDRESS` 文档缺项阻塞，本次未改动该功能。
- 尚未做真机视觉、真实机器 sudo/PAM 策略或完整端到端验收。
