# ① pi 宿主 CLI（fork 构建）

> 这层是**真正跑 agent** 的可执行文件。dashboard 不是自己跑 agent，而是为每个会话 slot
> 起一个 `pi --mode rpc` 子进程；扩展也由它加载。

---

## 1. 为什么用 tsiendragon/pi 的 fork，而不是上游官方版

我们依赖一组**上游尚不存在的扩展 API**。官方 `@earendil-works/pi-coding-agent`（截至 `0.87.1`）
缺少这些 API，会导致：

| 缺失 API | 影响 |
|---|---|
| `executeTool` | `run_code`（Code Mode）直接报错 `Code Mode requires a Pi runtime with executeTool support` |
| `extension_ui` / `respondExtensionUi` / `extension_ui_notify` | live session 断桥，dashboard 远程接管不可用 |
| `aboveStatus` / `fullscreen` | 子 Agent 降级为非全屏布局 |

因此本套**默认装 fork 构建**。本机验证方式：

```bash
ls /home/tsien/local-pi/lib/node_modules/@earendil-works/       # 应有 10 个包
/home/tsien/local-pi/bin/pi --version                          # 0.85.1（对应 Release tag v0.85.1-tsien.1）
grep -rl "executeTool" /home/tsien/local-pi/lib/node_modules/@earendil-works/pi-coding-agent/dist/ | head -1
grep -rl "respondExtensionUi" /home/tsien/local-pi/lib/node_modules/@earendil-works/pi-coding-agent/dist/ | head -1
```

**注意**：并不是所有扩展都需要 fork。扩展侧只有 3 个包用补丁 API
（`pi-tsien-live-session`、`pi-tsien-code-mode`、`pi-tsien-subagent-workbench`）；
其余 23 个在上游原版 pi 上也能跑。但只要用到 dashboard 的 live session / run_code / 子 Agent，就必须装 fork。

---

## 2. 安装来源与结构

- 仓库：`github.com/tsiendragon/pi`
- 构建产物：GitHub Release，默认 tag **`v0.85.1-tsien.1`**，含 **10 个平台 tarball**
- 10 个包：`chord`、`pi-ai`、`pi-agent-core`、`pi-client`、`pi-coding-agent`、`pi-protocol`、
  `pi-server`、`pi-session-backend-sqlite-node`、`pi-telemetry`、`pi-tui`
  （资产名形如 `earendil-works-pi-coding-agent-0.85.1-tsien.1.tgz`）

---

## 3. 安装方式

### 3.1 一键脚本（推荐）

`scripts/install-standalone.sh` 默认就从 Release 装 fork 构建（**不需要查 Release API，命名可预测**），
装到 `<安装根>/pi` 并把 `PI_SCRIPT` 写进 `<agent dir>/dashboard.env`。

```bash
bash scripts/install-standalone.sh -y            # 默认 fork 构建
bash scripts/install-standalone.sh --pi-release tsiendragon/pi@v0.85.1-tsien.1   # 指定构建
bash scripts/install-standalone.sh --official-pi # 改装官方 npm 版（功能降级，不推荐）
bash scripts/install-standalone.sh --skip-pi --pi-prefix ~/pi/bin                # 自备 pi，不装
```

### 3.2 手动安装（等价命令）

```bash
REPO=tsiendragon/pi; TAG=v0.85.1-tsien.1; VER=${TAG#v}
mkdir -p ~/pi-stack/pi ~/pi-stack/pi-tgz
for n in chord pi-ai pi-agent-core pi-client pi-coding-agent pi-protocol pi-server \
         pi-session-backend-sqlite-node pi-telemetry pi-tui; do
  curl -fsSL -o ~/pi-stack/pi-tgz/earendil-works-$n-$VER.tgz \
    "https://github.com/$REPO/releases/download/$TAG/earendil-works-$n-$VER.tgz"
done
npm install -g --prefix ~/pi-stack/pi ~/pi-stack/pi-tgz/*.tgz --no-audit --no-fund
~/pi-stack/pi/bin/pi --version        # 期望 0.85.1-tsien.1
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

live session 走的是另一条链：`~/.pi/dashboard.json` 的 `liveSessions.launch.command`，本机指向
`/home/tsien/.local/bin/pi-clean` → `/home/tsien/local-pi/bin/pi`（同一个 fork 构建）。

---

## 5. 升级 / 切换版本

- 升级：跑一次新的 `--pi-release <repo@tag>`，或手动重装 tgz 到同一 prefix。
- 切换 dashboard 用的 pi：改 `<agent dir>/dashboard.env` 的 `PI_SCRIPT`，重启 dashboard。
- 切换 live session 用的 pi：改 `~/.pi/dashboard.json` 的 `launch.command`。

---

## 6. 验证

1. `<prefix>/bin/pi --version` 能输出
2. `@earendil-works/` 下有 10 个包
3. `executeTool` 与 `respondExtensionUi` 能在 dist 里搜到
4. dashboard 发消息能流式返回；`run_code` 不报 `executeTool` 错误
5. 终端 `pi` 能启动