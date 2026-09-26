# 扩展配置 UI（已并入 guide/config.md）

> 本文件内容**已整体并入权威配置文档**：[`../guide/config.md`](config.md)（§3 每扩展一份 JSON）。
> 请以 `guide/config.md` 为准；此文件仅保留为历史入口与链接兼容。

原内容概要（现已收录在 guide/config.md §3）：

- 每个扩展在自己的 `<agent dir>/<name>.json` 里存设置，缺失即用内置默认
- dashboard 的 **Settings → general → Extension config** 卡片（`backend/routes/ext-config.ts`）
- 安全约束：白名单文件名、路径必须留在 agent dir 内（防目录穿越）、保存前校验
- 按项目解析的例外：`tsien-memory.json`、`rtk-config.json`（`<cwd>/.pi/`）
- 各扩展配置文件一览与生效时机