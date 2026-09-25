# 在 dashboard 里改扩展配置

pi 的每个扩展把自己的设置放在 agent 目录下一个独立 JSON 里（`<PI_CODING_AGENT_DIR | ~/.pi/agent>/<name>.json`），
文件不存在就用扩展内置默认值。dashboard 提供了一个统一入口，免得手改文件 —— 也可以完全不用它，两者等价。

## 从哪进

**Settings → general → Extension config**（由插件 `pi-extension-config` 通过 `settings-section` 槽位贡献）。

每个配置卡片显示：名字、文件名、是否已存在、一行说明、可编辑字段、原始 JSON 预览和它的绝对路径。

## 覆盖的配置

| 名称 | 文件 | 关键字段 |
|---|---|---|
| `bash-digest` | `bash-digest.json` | 启用、摘要模型、阈值、超时、并发、排除的命令正则 |
| `observation-pack` | `observation-pack.json` | 启用、归档目录、阈值、召回上限、清理与保留天数 |
| `large-read-pack` | `large-read-pack.json` | 启用（默认关）、阈值、头尾字节、最小节省比例 |
| `auto-compact-target` | `auto-compact-target.json` | 启用、目标 token、窗口比例、按模型覆盖 |
| `compact-thinking` | `compact-thinking.json` | 摘要标题、预览行数、动画间隔 |
| `capability` | `capability.json` | 额外能力根目录 |
| `claude-code-style` | `claude-code-style.json` | 模式、thinking 标题、预览行数、排除渲染器 |

不在列表里（有意）：`theme.json`（可选覆盖文件）、`tsien-memory.json` / `rtk-config.json`
（按项目 `<cwd>/.pi/` 解析，不是机器级配置）。

## 生效时机（重要）

扩展在**加载时**读取配置，所以：

- 保存后需要 `/reload`，或**重开 session**（实测 `/reload` 不会重载扩展代码，已存在的 live session 仍跑旧代码）；
- dashboard 里正在聊的 slot 需要新开会话才会用上新配置。

## 安全与实现

- 浏览器不直接碰文件系统：前端调 `GET /api/ext/config`、`PUT /api/ext/config/:name`
  （`backend/routes/ext-config.ts`）。
- 后端只接受**白名单**名字，路径必须落在 agent 目录内；body 必须是 JSON 对象；写入用
  「临时文件 + rename」原子替换，失败不会留下半截文件。
- 非法名字或非对象 body 返回 400。

## 「文件不存在」怎么办

点卡片上的 **创建并保存**：会用与该扩展内置默认值一致的内容建出文件（等于显式写出默认值，行为不变），
之后你就能在同一个卡片里微调。也可以直接不管它 —— 不建文件时扩展用内置默认值，效果相同。

## 相关

- 环境变量（provider 凭证、`PI_SCRIPT`、数据目录）：[env-configuration.md](env-configuration.md)
- 扩展装载清单（装哪些扩展、加载顺序）：`pi-tsien-extension/config/examples/extensions.config.example.json`
  与同目录 README
- 配置盘点（哪些文件、谁读、哪些是历史包袱）：见本仓库 `docs/config-inventory.md`