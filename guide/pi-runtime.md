# ① pi 宿主 CLI（fork 构建）

> 这层是**真正跑 agent** 的可执行文件。dashboard 不是自己跑 agent，而是为每个会话 slot
> 起一个 `pi --mode rpc` 子进程；扩展也由它加载。

---

## 1. 为什么用 tsiendragon/pitsien 的 fork，而不是上游官方版

我们依赖一组**上游尚不存在的扩展 API**。官方 `@earendil-works/pi-coding-agent`（截至 `1.6.1`）
缺少这些 API，会导致：

| 缺失 API | 影响 |
|---|---|
| `executeTool` | `run_code`（Code Mode）直接报错 `Code Mode requires a Pi runtime with executeTool support` |
| `extension_ui` / `respondExtensionUi` / `extension_ui_notify` | live session 断桥，dashboard 远程接管不可用 |
| `aboveStatus` / `fullscreen` | 子 Agent 降级为非全屏布局 |

因此本套**默认装 fork 构建**。按实际 fork 安装目录验证（示例使用 `$HOME/pi-fork`）：

```bash
PI_PREFIX="${PI_PREFIX:-$HOME/pi-fork}"
ls "$PI_PREFIX/lib/node_modules/@earendil-works/"       # 应有 11 个包
"$PI_PREFIX/bin/pi" --version                           # 版本以实际安装为准
grep -rl "executeTool" "$PI_PREFIX/lib/node_modules/@earendil-works/pi-coding-agent/dist/" | head -1
grep -rl "respondExtensionUi" "$PI_PREFIX/lib/node_modules/@earendil-works/pi-coding-agent/dist/" | head -1
```

**注意**：并不是所有扩展都需要 fork。扩展侧只有 3 个包用补丁 API
（`pi-tsien-live-session`、`pi-tsien-code-mode`、`pi-tsien-subagent-workbench`）；
其余 23 个在上游原版 pi 上也能跑。但只要用到 dashboard 的 live session / run_code / 子 Agent，就必须装 fork。

---

## 2. 安装来源与结构

- 仓库：`github.com/tsiendragon/pitsien`
- 构建产物：GitHub Release，默认 tag **`v1.6.1-tsien.1`**，含 **11 个 npm tarball**
- 11 个包：`chord`、`pi-agent-core`、`pi-ai`、`pi-codemode`、`pi-coding-agent`、`pi-durable`、
  `pi-env`、`pi-mcp`、`pi-schema`、`pi-telemetry`、`pi-tui`
  （资产名**带构建 hash**，如 `earendil-works-pi-coding-agent-1.6.1-tsien.1-b93ff5fb7614.tgz`，
  所以只能枚举资产，不能按「包名 + 版本」拼 URL）

**安装路径只有 Release tag，没有"从源码分支构建"这一条。** `scripts/install-standalone.sh` 的
`--pi-release <repo@tag>` 只从 Release 下 tgz，不 clone 仓库、不跑构建；本文档也不提供源码构建
步骤。开发机若自己 clone fork 源码并 build，那份构建不受本套脚本和文档约束，需要自己保证
`executeTool` / `respondExtensionUi` / `aboveStatus` 这几个 API 在本套 release 对应的范围内
（`guide/stack-update.md` 的 `branch` policy 就是给这类开发机用的，生产机不要用分支）。

---

## 3. 安装方式

### 3.1 一键脚本（推荐）

`scripts/install-standalone.sh` 默认就从 Release 装 fork 构建（**先枚举 Release 资产：资产名带构建 hash，拼不出可预测 URL**），
装到 `<安装根>/pi` 并把 `PI_SCRIPT` 写进 `<agent dir>/dashboard.env`。

```bash
bash scripts/install-standalone.sh -y            # 默认 fork 构建
bash scripts/install-standalone.sh --pi-release tsiendragon/pitsien@v1.6.1-tsien.1   # 指定构建
bash scripts/install-standalone.sh --official-pi # 改装官方 npm 版（功能降级，不推荐）
bash scripts/install-standalone.sh --skip-pi --pi-prefix ~/pi/bin                # 自备 pi，不装
```

### 3.2 手动安装（等价命令）

```bash
REPO=tsiendragon/pitsien; TAG=v1.6.1-tsien.1
mkdir -p ~/pi-stack/pi ~/pi-stack/pi-tgz && cd ~/pi-stack/pi-tgz
# 资产名带构建 hash（earendil-works-<pkg>-<ver>-<hash>.tgz），只能枚举后下载：
gh release download "$TAG" -R "$REPO" --pattern '*.tgz'
# 没有 gh 时用匿名 API 取 URL（每天 60 次限额）：
#   curl -fsSL "https://api.github.com/repos/$REPO/releases/tags/$TAG" \
#     | grep -o 'https://[^"]*\.tgz' | xargs -n1 curl -fsSLO
npm install -g --prefix ~/pi-stack/pi ~/pi-stack/pi-tgz/*.tgz --no-audit --no-fund
~/pi-stack/pi/bin/pi --version        # 期望 1.6.1-tsien.1
ls ~/pi-stack/pi/lib/node_modules/@earendil-works/ | wc -l   # 期望 11
mkdir -p ~/.pi/agent && printf 'PI_SCRIPT=%s\n' ~/pi-stack/pi/bin/pi >> ~/.pi/agent/dashboard.env
```

### 3.3 官方 npm 版（仅用于对照/降级）

```bash
npm install -g @earendil-works/pi-coding-agent
```

装上后 dashboard 的 live session / run_code / 子 Agent 会降级，仅适合不需要这些能力的场景。

---

## 4. 怎么让 dashboard 用上这个 pi

`backend/pi-manager.ts` 启动 slot 时按 `PI_SCRIPT` 决定可执行文件，**顺序为**：

1. `PI_SCRIPT`（推荐，由安装脚本写入 `<agent dir>/dashboard.env`）
2. 仓库内自带官方 pi：`node_modules/.bin/pi`
3. `which pi`

`dashboard.env` 由 backend 启动时加载，并传给每个 pi 子进程（见 `guide/config.md` §2）。

live session 走的是另一条链：`~/.pi/dashboard.json` 的 `liveSessions.launch.command`
（可指向你自己的包装脚本，例如一个先 unset 部分变量再 exec pi 的脚本），默认直接用 PATH 上的 `pi`。

若 `run_code` 报 `Node.js is not compiled with TypeScript support`，或 Code Mode 启动时提示沙箱探测失败，先检查该会话实际使用的 Node，而不只看终端里的 `node -v`。安装版 Pi 若已有使用配套 Node 的启动入口，请用该入口恢复原会话：Dashboard 管理的空闲会话可在详情里重启，保留原会话记录。`/reload` 只重载扩展，不能更换当前进程的 Node；其他会话不必重启。

---

## 5. 升级 / 切换版本

- 升级：跑一次新的 `--pi-release <repo@tag>`，或手动重装 tgz 到同一 prefix。
- 切换 dashboard 用的 pi：改 `<agent dir>/dashboard.env` 的 `PI_SCRIPT`，重启 dashboard。
- 切换 live session 用的 pi：改 `~/.pi/dashboard.json` 的 `launch.command`。

`backend` 自己也有 npm 依赖（`SessionManager` / SDK 路径）：`package.json` 里的
`@earendil-works/pi-coding-agent` 和它同级的 `chord`、`pi-agent-core`、`pi-ai`、`pi-telemetry`、`pi-tui`
直接锁同一个 Release 的 tgz，**必须和宿主的 fork 版本同步升级**。上游 npm 的同号版本（如 `1.6.1`）
缺少 fork 增补的导出（例如 `pi-ai` 的 `retryDelayMs`），混装会让 backend 在导入时直接报
`does not provide an export named ...`。`npm install` / `npm ci` 需要能访问 GitHub Release 资产。

> **现状（尚未同步）**：宿主 Release 已到 `v1.6.1-tsien.1`，但仓库 `package.json` 里那 6 个 tgz 仍钉在
> `v0.85.1-tsien.1`。要跟上 1.6.1，除了把 URL 换成带资产 hash 的新名，还得补 3 个新的内部依赖
> （`pi-schema`、`pi-codemode`、`pi-mcp`：`chord` / `pi-ai` / `pi-coding-agent` 用精确版本引用它们），
> 然后跑 `npm install` + `npm run typecheck` + `npm test` 验收——不能只改 `PI_RELEASE_TAG`。

---

## 6. 验证

1. `<prefix>/bin/pi --version` 能输出
2. `@earendil-works/` 下有 11 个包
3. `executeTool` 与 `respondExtensionUi` 能在 dist 里搜到
4. dashboard 发消息能流式返回；`run_code` 不报 `executeTool` 错误
5. 终端 `pi` 能启动