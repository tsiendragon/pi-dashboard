# 配置盘点（已并入 guide/config.md）

> 本文件内容**已整体并入权威配置文档**：[`../guide/config.md`](config.md)。
> 请以 `guide/config.md` 为准；此文件仅保留为历史入口与链接兼容。

原内容概要（现已收录在 guide/config.md）：

- 四层配置结构：宿主 pi / 扩展 JSON / 进程环境变量 / dashboard 自身
- 每个 config 文件「谁读、是否必须、能否在 dashboard 改」
- 环境变量唯一入口与加载顺序
- 每扩展一份 JSON 的清单与改法
- `pi-web-sessions.json` 为何不并入 `dashboard.json`
- 统一策略与已收敛项