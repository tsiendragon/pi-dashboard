# 会话重启修复

- 目标：通过 Pi TUI 的 `/quit` 退出，确认退出后用 `pi --session <原文件>` 恢复。
- 范围：仅 dashboard 管理的空闲 TUI；保留文件、进程身份及子会话检查；不强杀、不部署。
- 验收：测试覆盖退出顺序、恢复原文件、僵尸进程、退出失败不启动；自审差异。
- 已完成：TUI `/quit`、保留 `--session` 恢复、Linux 僵尸退出判定、空闲限制、部署说明。
- 真实验证发现并修复：本机 Enter 是换行，提交是 Ctrl+R / F12；现在读取 Pi `keybindings.json`，使用实际清空及提交键，不写死 Enter。
- 验证：独立测试 Pi 使用本机 Ctrl+R 配置，两轮 `/quit` 均正常退出，第二轮仍使用同一测试会话文件；包括多行草稿清空。证据 `/tmp/pi-quit-real-pHy2DS/evidence.json`。未操作用户现有会话，完整 dashboard 在线登记链路仍需部署后验收。
- 生效：用户自行执行 `./run.sh`，随后重启一个空闲会话进行实际验收。
