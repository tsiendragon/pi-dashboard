# Extensions 页面（P1 只读版）

`GET /api/pi/ext/list` + `/extensions` 页面：回答「Pi 到底会加载哪些扩展」。
旧接口 `GET /api/pi/extensions` 只列 `<agent dir>/extensions/*.ts`，**不是**实际加载集合，本页不再用它。

## 数据来源（都是文件，不猜）

| 来源 | 用途 | 可靠度 |
|---|---|---|
| `<agent>/settings.json` 的 `packages[]` / `extensions[]` | 生效清单与顺序；`-`/`+`/`!` 前缀 = 启用状态 | 声明（可靠） |
| `<agent>/extensions.config.json` 的 `packages[]` / `loadOrder[]` | 包 id、受管顺序、与生效清单的 diff | 声明（可靠） |
| 各包 `package.json`（`pi.extensions`） | 条目是否「声明在该包 manifest 里」、包版本与描述 | 声明（可靠） |
| 文件存在性 / 目录列举 | 缺失条目、自动发现未纳管的文件 | 派生（derived） |
| 源码文本扫描（`executeTool`、`respondExtensionUi`、`extension_ui`、`extension_ui_notify`） | 「需要补丁版 pi」标记 | **启发式（heuristic）**，页面显式标注「推断」 |

## 页面结构

- 顶部：7 张汇总卡（packages / 已加载 / 启用・禁用 / 来自 package / 直接路径 / 未纳管 / 异常・需补丁）
- 三组列表：① 由 package 提供（显示包名、版本、declared 状态）② 直接路径（不伪造版本号）③ 自动发现未纳管（严格模式同步会移入 quarantine）
- 每行可展开：`settings.json` 原始写法、解析后的绝对路径、包内相对路径、受管顺序、描述、补丁 API 明细
- 横幅：与声明清单的 drift、读取提示（如 `${VAR}` 无法解析）

## 已知边界

- **禁用 ≠ 卸载代码**：`-` 前缀只让 Pi 不加载该条目，别的条目仍可能 `import` 它的模块（例如关掉 `pi-tsien-auto-compact`，`pi-tsien-live-session` 仍会 import 其 core）。写操作阶段（P2）必须在确认框里写清。
- `drift` 检查依赖 `extensions.config.json` 里包来源可解析；若用 `${PI_TSIEN_EXTENSION_ROOT}` 之类占位符而 dashboard 进程没注入该变量，会跳过检查并给出提示（把变量写进 `dashboard.env` 即可启用）。
- 本页只读；启用/禁用与排序写 `settings.json`（P2），配置值编辑在 Settings → General 的 Extension config 面板。

## 验证

```bash
npx vitest run backend/__tests__/ext-inventory.test.ts   # 5 passed
# 隔离实例（不碰本机配置）：
#   HOME=/tmp/xxx PI_DASH_PORT=7802 npx tsx backend/server.ts
#   curl -s localhost:7802/api/pi/ext/list | jq '.counts'
```
