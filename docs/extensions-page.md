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

## 写操作（P2）

| 方法 | 行为 | 安全设计 |
|---|---|---|
| `POST /api/pi/ext/toggle` `{path, enabled}` | 只改该条目的 `+`/`-` 前缀，**位置不变** | 幂等；`enable` 会把 `-path` 还原成无前缀（往返一致），`!`/`+` 则写成 `+path`（排除必须被强制包含覆盖） |
| `PUT /api/pi/ext/order` `{paths[]}` | 只重排**无前缀**条目；覆盖条目留在原索引 | 提交的集合必须与现有受管条目完全一致（否则 400） |
| `PUT /api/pi/settings` | 整份写（原来的 Settings 页路径） | 已改为走同一个串行 store，不再与上面的写操作互相覆盖 |

统一写入模块 `backend/settings-store.ts`：所有写者共享一个实例 → 串行执行「读 → 备份到 `<agent>/backups/settings-<ts>.json` → 内存改 → 原子写（tmp + rename）」，
响应返回 `before`/`after`/`backupPath`/`diff`；无变化时不写盘、不产生备份。

### 鉴权（必须）

dashboard 默认 `PI_DASH_HOST=0.0.0.0`（网络可达）且**没有全局鉴权中间件**，所以会改机器状态的接口必须自带门禁：

| 接口 | 门禁 |
|---|---|
| `POST /api/pi/ext/toggle`、`PUT /api/pi/ext/order` | 必须带 live-session 浏览器认证（`pi_live_session` HttpOnly cookie）；跨域 Origin → 403，未认证 → 401 + 可操作提示 |
| `PUT /api/ext/config/:name` | 同上 |
| `GET` 系列（清单、配置读取） | 保持开放，与 dashboard 其它只读接口一致 |

实现复用现有信任边界（`backend/live-sessions/auth.ts`，与终端中继 `/api/pty/*` 同一套）：`backend/routes/require-browser-auth.ts`。
首次使用写操作前，需要在 dashboard 的终端/live-session 页粘贴启动日志里的令牌完成一次认证（浏览器随后自动带 cookie）。

隔离实例实测：无 cookie → 401（带提示）、`Origin: http://evil.example` → 403、用 `/api/pty/auth` 认证后 → 200 且 `settings.json` 已改、备份已生成。

页面：每行有「启用/禁用」与 `↑`/`↓`；点击后弹出**确认框**，列出 diff、提示「禁用 ≠ 卸载代码」（别的扩展仍可能 import 它）与备份位置，确认后才写。
写成功后刷新清单并在顶部显示备份路径。

### P2 验收（隔离实例实测）

- 禁用 → `settings.json` 该条目变 `-path` 且**位置不变**，备份文件生成，清单状态变 `disabled`；
- 启用 → 回到无前缀（往返一致）；
- 交换两条受管条目 → 顺序变化、`-`/`+`/`!` 条目索引未变；提交非全集 → 400；未知路径 → 404；
- **并发**：整份 `PUT /api/pi/settings` 与 toggle 同时发出，两份改动都保留（`theme` 保留 + 该条目已禁用）。

## 安装 / 审计 / 回滚（P3）

| 方法 | 行为 |
|---|---|
| `POST /api/pi/ext/install` `{source}` | `pi install <source>`（用 `execFile`，无 shell，杜绝参数注入） |
| `POST /api/pi/ext/remove` `{source}` | `pi remove <source>` |
| `POST /api/pi/ext/update` `{source}` | `pi update <source>`；**拒绝 `self`/`pi`**（那会替换 pi 二进制本身） |
| `GET /api/pi/ext/audit?limit=` | 审计记录（JSONL，最新在前） |
| `POST /api/pi/ext/rollback` `{backupPath}` | 用某份 `backups/settings-*.json` 覆盖 settings.json（回滚前会再备份一次，可回滚回来） |

- 装/卸/更新/回滚都**必须通过浏览器认证**（同 §鉴权）；旧的 `/api/pi/packages/install|remove` 保留给 Settings 页，但已改为同一实现 + 同一门禁。
- 审计文件：`<agent dir>/extension-audit.jsonl`，每条含 `ts / action / target / actor(浏览器 clientId) / ok / backupPath / before / after / output|error`。
- 启停与排序也记审计（action `toggle` / `order`）。
- 回滚路径必须落在 `<agent dir>/backups/` 且形如 `settings-*.json`（越界路径 400）。

### P3 验收（隔离实例实测）

```
未认证安装                    -> 401
认证后安装（探针包）           -> 200，packages 29 -> 30，provided 组出现该包的 manifest 条目
npm 假包                      -> 400 + 审计 ok=false（不执行任何第三方代码）
卸载                          -> 200，从 packages 移除
回滚到「卸载前」               -> 等于安装后状态
回滚到「安装前」               -> 等于初始状态
越界 backupPath (/etc/passwd)  -> 400
pi update self                -> 400 拒绝
审计列表                       -> install/remove/rollback 三条，均带 backupPath 与 actor
```

> 说明：为**不在你的机器上执行第三方代码**，全链路用我们自己的零依赖本地包做验证；npm registry 路径只验证了失败分支。
> 另：`settings.json` 的 `packages[]` 是 **string | object 的联合**（上游 `settings-manager.ts` 的 `PackageSource`）：
> `pi install` 写的是**纯字符串**（相对 agent 目录，等价「加载该包全部资源」）。清单页已按此实现，并把这类包自带的条目列在「③ 由 package 自带（autoload）」组。

## 依赖关系（P4，静态扫描）

`GET /api/pi/ext/deps` —— **刻意独立于清单接口**：它要读几百个文件，放在列表里会让页面卡住（实测过：早期版本 list 直接超时）。

- 解析方式与 Node 一致：相对路径按文件所在目录解析，包名先查 `settings.packages` 的包名，再走 `node_modules`（npm workspaces 软链），因此**不在 settings 里的库**（如 `pi-tsien-shared`）也能解析出来。
- 归属按**最近的 `package.json`**（真实包边界）判定，而不是按路径前缀取第一个匹配（仓库根包会匹配一切，那样会把子包全归到根上）。
- 只统计**显式 import**；动态 import、运行时反射不算。上限：每包 80 个文件、单文件 256KB（超出标 `truncated`）。
- 结果按 `settings.json` 的 mtime+size 缓存（首次约 1s，之后 1ms 级）。
- 第三方依赖（`jsdom`、`tree-sitter` …）单独列为 `externalPackages`，不混进「共享代码」。

**页面用途**：每行显示「被 N 个条目 import」徽章；启用/禁用确认框会写出具体是哪些条目会继续 import 它的模块——把设计文档里「禁用 ≠ 卸载代码」从一句提醒变成可核对的事实。
当前真实结论（本机 25 个条目）：`pi-tsien-shared` 13 个文件被 **7 个条目** import；另有 5 条单文件跨包引用（observation-pack、default-system-prompt、subagent-workbench、trajectory-recorder）。

> 顺带清理：`extensions.config.json` / `settings.json` 里那条 **仓库根** package 声明（扩展搬到 `packages/*` 后已过时）已移除，
> 另加「按目录名兜底匹配」使 `${VAR}` 未注入时仍能认到包 id（否则 `packageId` 与 drift 检查都会失效）。

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
