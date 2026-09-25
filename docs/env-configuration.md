# 环境变量：怎么让 dashboard 和它启动的 pi 拿到同一套变量

dashboard 不是自己跑 agent，而是**为每个会话 slot 起一个 `pi` 子进程**（`pi --mode rpc`）。
子进程用 `...process.env` 启动（`backend/pi-manager.ts` 的 `spawnOpts`），所以：

> 只要变量进了 dashboard 进程，它就会被**所有** pi slot 继承，扩展（`extensions/*.ts`）也就能读到。

这就够用了 —— 不需要给每个扩展单独写配置文件，也不用去改 systemd unit 或 launchd plist。

## 加载顺序

backend 启动的最早时刻会读环境文件（`backend/env-file.ts`，由 `backend/env-bootstrap.ts` 在
`server.ts` 的第一行 import 触发）。三个候选位置，按顺序加载：

| 顺序 | 路径 | 说明 |
|---|---|---|
| 1 | `$PI_DASH_ENV_FILE` | 显式指定。**文件不存在会报错**（既然你点名要它） |
| 2 | `<pi-dashboard 仓库>/.env` | 本地 checkout 常用位置（已在 `.gitignore` 里） |
| 3 | `<PI_CODING_AGENT_DIR \| ~/.pi/agent>/dashboard.env` | 机器级；systemd / launchd / Docker 都适用 |

规则：

- 与 dotenv 一致：**已经存在于 shell 环境里的同名变量不会被文件覆盖**。所以 `docker run -e X=…`
  或 `export X=…` 永远优先。
- 文件里已有的变量不会重复加载（后面的文件只补前面没给到的）。
- 启动日志会打印来源，例如：
  `[env] loaded env file(s): /home/you/.pi/agent/dashboard.env (+3)`
- 语法：`KEY=VALUE`，支持 `#` 注释、空行、`export KEY=VALUE`、单/双引号值、`KEY=`（空值视为未设）。

模板见仓库根目录 [`.env.example`](../.env.example)；`scripts/install-standalone.sh` 会自动往
第 3 个位置写 `PI_SCRIPT`。

## 常用变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `PI_SCRIPT` | 用哪个 pi 可执行文件（指向补丁版 fork 构建） | 仓库内 `node_modules/.bin/pi` → `which pi` |
| `PI_TRACE_DIR` | `trajectory-recorder` 的 trace 落点 | `<agent dir>/pi-traces` |
| `PI_TIMING_DIR` | `trajectory-recorder` 的计时账本 | `<agent dir>/pi-timing` |
| `PI_OBSERVATION_DIR` | `observation-pack` 大结果归档目录 | `<agent dir>/archiv` |
| `DASHSCOPE_API_KEY` 等 | 模型 provider 凭证（`bash-digest` 默认摘要模型用它） | 无 |
| `PI_DASH_PORT` | dashboard 端口 | `7777` |
| `PI_CODING_AGENT_DIR` | pi 的 agent 配置目录（决定上面的 `<agent dir>`） | `~/.pi/agent` |

其中 `PI_TRACE_DIR` / `PI_TIMING_DIR` / `PI_OBSERVATION_DIR` 三个扩展的默认值现在都是
**可移植路径**（`<agent dir>/…`），不再依赖任何机器专属目录；只有在你想沿用历史位置时才需要显式设置。

## 三种用法

**1. 本地手动启动**

```bash
cp .env.example .env      # 填上 PI_SCRIPT 和 provider key
./run.sh
```

**2. systemd（脚本 `--service` 会装）**

unit 里只需写好 agent 目录，其余交给环境文件：

```ini
Environment=PI_CODING_AGENT_DIR=/home/you/.pi/agent
```

（`install-standalone.sh --service` 生成的 unit 已经包含这一行。）

**3. 纯命令行用 pi（不通过 dashboard）**

环境文件不会被加载 —— 那是 dashboard 的行为。命令行用法由 shell 自己给：

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # 写进 ~/.bashrc 或 ~/.zshrc
```

## 排查

| 现象 | 检查 |
|---|---|
| 提示 `[env] PI_DASH_ENV_FILE=… does not exist` | 显式指定的路径写错了；改用默认位置或不设该变量 |
| 启动日志没有 `[env] loaded …` | 三个候选位置都不存在，或文件在工作目录之外（第 2 项用的是 repo 根目录，与 shell 的 cwd 无关） |
| 设了变量但 pi 里看不到 | 变量是在 dashboard **启动之后**才 export 的（环境只在启动时继承）；重启 dashboard |
| 想换回官方 pi | `.env` 里去掉 `PI_SCRIPT`，或改成官方路径 |