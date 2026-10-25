---
name: pi-stack-install
description: 在新机器上从零装齐 pi 工作台三层（fork 版 pi 宿主 + pi-tsien-extension 扩展 + pi-dashboard 网页服务），或在已有机器上补齐、升级、排查其中一层。用户说「装一套 pi dashboard」「新机器部署」「一键安装」「升级到新版」「装完没生效」「扩展没加载」「dashboard 起不来」时使用；只做安装、配置与验证，不负责业务开发、UI 改版、模型效果调优。只想比较安装形态、只要文档建议、或机器已装好只想改功能时不要执行本 skill。
---

# pi 工作台三层安装与配置

## 这套东西由三层组成

| 层 | 是什么 | 从哪来 | 为什么必须装它 |
|---|---|---|---|
| ① pi 宿主 | 真正跑 agent 的 `pi` 可执行文件 | `github.com/tsiendragon/pi` 的 GitHub Release（默认 tag `v0.85.1-tsien.1`，10 个 npm 包） | 上游官方版缺 `executeTool` / `extension_ui` / `aboveStatus`，`run_code`、live session、全屏子 Agent 会报错或降级 |
| ② 扩展 | `pi-tsien-extension`（26 包 / 25 扩展入口） | `github.com/tsiendragon/pi-tsien-extension` | live session 桥、子 Agent 工作台、Code Mode、长期记忆、任务结果过滤都在这里 |
| ③ dashboard | 本仓库：Express + WebSocket 服务、网页与 iOS 前端 | 当前仓库 | 界面本体；每个会话 slot 起一个 `pi --mode rpc` 子进程 |

**一条命令就能装齐三层**：`bash scripts/install-standalone.sh`。它按顺序做：检查依赖 → 取扩展仓库 → 装扩展依赖 → 同步扩展清单进 `<agent dir>/settings.json` → 装 dashboard 依赖并构建前端 → 从 Release 装 fork 版 pi 并写 `PI_SCRIPT` →（可选）systemd 或后台启动。

所以本 skill 的作用不是「替用户敲一条命令」，而是：**先体检、再选对路径、装完逐条验证、失败按症状处理**。

---

## 不做什么（硬边界）

- 不代跑 `sudo`。要装 systemd 时，把命令交给用户自己执行。
- 不读、不写用户的凭证内容。只给出写凭证的命令模板，让用户自己填密钥。
- 不重启、不 kill 用户已经在跑的 dashboard 或别人的会话；不擅自 `./run.sh`、不 `systemctl restart`。
- 不 push、不删远端分支、不改 git 历史。
- 不装组织内部或专有市场的包；本套只装公共通用能力。
- 磁盘或网络受限时，先如实说明限制，不靠猜测硬装。

---

## 阶段 1：体检（只读，先跑这一组）

```bash
node -v; uname -sm
command -v pi && pi --version || echo "no pi on PATH"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"; echo "agent dir: $AGENT_DIR"; ls "$AGENT_DIR" 2>/dev/null | head -20
ls ~/pi-stack 2>/dev/null || echo "no install root yet"
curl -sS -o /dev/null -w 'npm %{http_code}\n' --max-time 6 https://registry.npmjs.org/ || echo "npm unreachable"
curl -sS -o /dev/null -w 'github %{http_code}\n' --max-time 6 https://api.github.com/ || echo "github unreachable"
lsof -i :7777 -sTCP:LISTEN -n -P 2>/dev/null || ss -ltnp 2>/dev/null | grep ':7777' || echo "port 7777 free"
```

把这些事实列成结论，再决定路径：

| 结论项 | 判据 |
|---|---|
| Node 是否够 | 需要 **22+**；不够就先解决 Node，不要继续 |
| 平台 | Linux / macOS、x86_64 / arm64 —— 决定 `node-pty` 能否直接编译（需 `python3`、`make`、`g++`） |
| 是否已有 pi | 有没有、什么版本；区分官方版还是 fork 版（见阶段 4 的包数与 `executeTool` 检查） |
| 是否已装过一半 | `~/pi-stack` 是否存在、`<agent dir>/settings.json` 里有没有扩展条目 |
| 网络 | npm registry 和 GitHub 都能通 → 走阶段 2 的 A；任一不通 → 只能走 D |
| 端口 | 7777 被占用时后面要换端口 |

---

## 阶段 2：选一条路径

| 路径 | 什么时候用 | 怎么走 |
|---|---|---|
| **A 全新联网安装**（默认） | 机器干净、npm 与 GitHub 都通 | `bash scripts/install-standalone.sh --dry-run` 看步骤，确认后加 `-y` 重跑 |
| **B 补齐缺的那层** | 已有 pi 或已有扩展，只补 dashboard / 只补扩展 | `--skip-pi` 只装 dashboard（注意：此时脚本**不会**写 `PI_SCRIPT`，要自己把 `PI_SCRIPT=<你的 pi 路径>` 写进 `<agent dir>/dashboard.env`，否则 dashboard 按「仓库内 `node_modules/.bin/pi` → `which pi`」找）；`--skip-extension-sync` 不动扩展清单；`--ext-dir <已有扩展 checkout>` 复用现成扩展；`--pi-prefix <目录>` 配合 `--pi-release` 指定装到哪 |
| **C 手上只有官方 pi** | 暂时拿不到 fork 构建 | 先用官方版把 dashboard 跑起来，同时明确告知：`run_code`、live session、全屏子 Agent 会降级；装到 fork 版后用 `--pi-release tsiendragon/pi@v0.85.1-tsien.1` 补上 |
| **D 目标机没有网络** | npm 或 GitHub 不通 | 本仓库不附带离线包。不要硬装：先确认能否拿到离线包（三层的依赖产物 + 校验值 + 安装脚本），拿到再装；拿不到就把阻塞如实报出来 |
| **E 升级已有安装** | 三层都装好了，只想升某一层 | pi：重跑 `--pi-release <repo@tag>`；扩展：在扩展目录 `git fetch --tags && git checkout <tag>` 后跑同步器；dashboard：本仓库 `git pull` + `npm install` + `npm run build-frontend` |

常用变体（都来自 `--help`，不要自己编参数）：

```bash
bash scripts/install-standalone.sh -y                  # 免确认
bash scripts/install-standalone.sh -y --start          # 装完后台启动
bash scripts/install-standalone.sh -y --service         # 装 systemd（需要 sudo，命令交给用户执行）
bash scripts/install-standalone.sh --dir ~/tools --port 8899
bash scripts/install-standalone.sh --ext-dir ~/src/pi-tsien-extension
bash scripts/install-standalone.sh --skip-pi        # 自备 pi，只装 dashboard 与扩展
bash scripts/install-standalone.sh --pi-release tsiendragon/pi@v0.85.1-tsien.1 --pi-prefix ~/pi-stack/pi
```

---

## 阶段 3：执行安装

1. 先 `--dry-run`，把将要执行的步骤读给用户看。
2. 确认后加 `-y` 真正执行；长任务放后台跑，不要空等，期间可以做只读检查。
3. 安装根目录默认 `~/pi-stack`，扩展落在 `<安装根>/pi-tsien-extension`，pi 落在 `<安装根>/pi`。
4. 结束时把三件事记下来：安装根、`PI_SCRIPT` 写在哪个 `dashboard.env`、扩展条目写进了哪个 `settings.json`。

---

## 阶段 4：逐条验证（必须全过，才能说「装好了」）

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PREFIX=${PI_PREFIX:-$HOME/pi-stack/pi}          # 换过 --dir/--pi-prefix 就指到实际位置
EXT_DIR=${EXT_DIR:-$HOME/pi-stack/pi-tsien-extension}

node -v                                                                    # 1) 要 22+
"$PREFIX/bin/pi" --version                                                 # 2) 要 0.85.1-tsien.1
ls "$PREFIX/lib/node_modules/@earendil-works/" | wc -l                     # 3) 要 10
grep -rl executeTool "$PREFIX/lib/node_modules/@earendil-works/pi-coding-agent/dist/" | head -1        # 4)
grep -rl respondExtensionUi "$PREFIX/lib/node_modules/@earendil-works/pi-coding-agent/dist/" | head -1 # 4)
node "$EXT_DIR/scripts/pi-extension-sync.mjs" --agent-dir "$AGENT_DIR" \
  --config "$EXT_DIR/config/extensions.standalone.json"                    # 5)
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:7777/           # 6) 要 200
```

1. `node -v` 是 22 或更高。
2. `pi --version` 输出 `0.85.1-tsien.1`。
3. `@earendil-works/` 下正好 10 个包。
4. 上面两条 `grep` 各自至少命中一个文件（说明是 fork 构建，不是官方版）。
5. 同步器输出 `Pi extensions already match the ordered user config.`
6. 首页返回 200；返回 `401/403` 反而正常（浏览器认证没走），说明服务活着。
7. 在终端里开一次 `pi`，确认 `/sidebar`、`/effort`、`/schedule` 这些命令存在——存在就说明扩展真的加载了。
8. 打开 `http://<host>:7777/extensions`：条目数与 `settings.json` 一致、`drift` 为空。

任何一条不过，进阶段 6，不要用「应该没问题」收工。

---

## 阶段 5：配凭证、启动、交接

凭证三种写法，效果一样，让用户自己选并自己填密钥：

```bash
# 1) 写进环境文件（推荐，重启后仍有效，systemd 也适用）
cat >> ~/.pi/agent/dashboard.env <<'EOF'
DASHSCOPE_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
EOF

# 2) 在 pi 里交互式登录：pi 然后 /login
# 3) 导出到启动 dashboard 的那个 shell
```

启动（**这一步由用户执行**，不要代跑）：

```bash
cd <pi-dashboard 目录>
PI_DASH_PORT=7777 ./run.sh        # 先构建前端，再起服务
```

- 首次访问要做一次浏览器认证：把启动日志里的令牌粘到页面提示处。
- 想减少暴露面：`PI_DASH_HOST=127.0.0.1`；不要把 7777 直接暴露到公网。
- 开机自启：让用户自己执行 `sudo systemctl enable --now pi-dashboard`。

交接给用户时必须说清四件事：

1. 装在哪：安装根、扩展目录、pi 前缀、`dashboard.env`、`settings.json`。
2. 怎么重启：改后端要重启进程；只改前端要重新构建。
3. 怎么升级：重跑安装脚本换 pi；扩展换 tag 后跑同步器；dashboard `git pull` 后重建前端。
4. 生效前提：**扩展代码在 Pi 进程启动时加载**，装完或更新后只有新会话用新代码，老会话要 `/reload` 或重开会话进程。

---

## 阶段 6：排障（症状 → 诊断 → 动作）

| 症状 | 先查 | 再动 |
|---|---|---|
| 脚本报 Node 版本过低 | `node -v` | 切到 22+ 再跑；不要把要求降到 18 |
| `node-pty` 安装/编译失败 | 有没有 `python3`、`make`、`g++` | 装构建工具后重跑；离线机器只能靠预编译产物 |
| `NODE_MODULE_VERSION` 不一致 | 依赖是用哪个 Node 编的、现在跑的是哪个 | 用同一 Node 版本重装依赖 |
| `GLIBC_2.xx not found` | `ldd --version` | 目标机系统库比构建机老，换匹配的构建产物，别硬跑 |
| pi 启动卡在 `Trust project folder?` | 工程目录里有 `.pi/skills`、`.pi/settings.json` 等资源 | 在交互终端里跑一次 `pi` 并选 Trust（写进 `~/.pi/agent/trust.json`）；dashboard 的 pane 无人应答会一直卡，所以先信任再启会话 |
| 同步器报 `Cannot resolve ${…ROOT}` | 用的是哪份清单 | 独立安装必须用**扩展仓库**里的 `config/extensions.standalone.json`（安装脚本默认就取 `<扩展目录>/config/extensions.standalone.json`），不要用带外部市场引用的配置 |
| 同步器说某个 extension 不存在 | 扩展仓库版本 | 在扩展目录 `git fetch --tags` 后切到匹配 tag 再跑 |
| dashboard 起来了但会话说找不到 pi | `echo $PI_SCRIPT`、`ls "$PREFIX/bin/pi"` | 写对 `dashboard.env` 的 `PI_SCRIPT`，或重跑安装脚本 |
| 页面 200 但发消息报错 | 凭证与网络 | 配一家可达的 provider；看启动日志 `[env] loaded env file(s):` 确认环境文件被读到 |
| `/api/*` 返回 401/403 | 是否已做浏览器认证 | 正常行为，先认证 |
| 扩展命令/面板没生效 | 会话是什么时候起的 | 在 pi 里 `/reload` 或重开会话进程；`/extensions` 页的启停同样要重载 |
| 端口被占用 | `lsof -i :7777` / `ss -ltnp` | 换 `--port`，不要 kill 别人的进程 |
| 想让 Pi 配置回滚 | `<agent dir>/extension-sync-backups/<时间戳>/` | 用备份覆盖回去；删记录前先确认没有别的机器/项目共用这些路径 |

---

## 细节去读这些（不要凭记忆编命令）

- 三层总览与安装顺序：[`guide/README.md`](../../../guide/README.md)
- 逐条手动安装、systemd、卸载：[`guide/standalone-install.md`](../../../guide/standalone-install.md)
- fork 版的必要性、验证与升级：[`guide/pi-runtime.md`](../../../guide/pi-runtime.md)
- 扩展三种装法、生效条件、功能与包的对应：[`guide/extensions.md`](../../../guide/extensions.md)
- 扩展管理页：[`guide/extensions-page.md`](../../../guide/extensions-page.md)
- 配置四层地图与全部环境变量：[`guide/config.md`](../../../guide/config.md)
- 接口清单：[`guide/api-reference.md`](../../../guide/api-reference.md)
- 页面功能导览：[`docs/features.md`](../../../docs/features.md)