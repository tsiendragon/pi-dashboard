# 环境变量（已并入 guide/config.md）

> 本文件内容**已整体并入权威配置文档**：[`../guide/config.md`](config.md)（§2 环境变量）。
> 请以 `guide/config.md` 为准；此文件仅保留为历史入口与链接兼容。

原内容概要（现已收录在 guide/config.md §2）：

- 环境文件加载顺序：`$PI_DASH_ENV_FILE` → `<仓库根>/.env` → `<agent dir>/dashboard.env`
- 「已存在的 shell 变量不被覆盖」规则与启动日志 `[env] loaded …`
- `PI_SCRIPT` / `PI_CODING_AGENT_DIR` / `PI_DASH_*` / `PI_TRACE_DIR` 等完整变量表
- 本地手动 / systemd / 纯命令行三种用法
- 可移植性提示（新机器要显式设的 `PI_DASH_*` 数据目录）
- 排查「设了变量但 pi 看不到」