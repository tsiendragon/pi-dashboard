# ③ pi-dashboard Web 服务

> 当前仓库。前端 React + TypeScript + Vite，后端 Express + WebSocket，终端走 node-pty。
> 它为每个会话 slot 起一个 `pi --mode rpc` 子进程，并把 ② 的扩展能力暴露成页面。

- 仓库：`github.com/tsiendragon/pi-dashboard`
- 默认端口：`7777`

---

## 1. 依赖与构建

- 需要 Node.js 22+
- 前端依赖里存在历史 peer 冲突，**请用项目脚本安装**（脚本已带 `--legacy-peer-deps`）：

```bash
npm install --no-audit --no-fund
npm run build-frontend        # 等价于 cd frontend && npm install --legacy-peer-deps && npm run build
```

`node-pty` 需要编译工具（Debian/Ubuntu：`sudo apt install -y build-essential python3`）。

---

## 2. 启动与部署

```bash
# 开发/手动启动：先构建前端，再以 tsx backend/server.ts 前台启动
PI_DASH_PORT=7777 ./run.sh
```

浏览器打开 `http://localhost:7777`。

**服务由用户自己启动/重启**（见仓库根 `AGENTS.md`）：agent 不代跑 `./run.sh` / `./restart.sh`，
也不 kill 正在运行的服务进程。

代码改动的生效方式：

| 改动位置 | 生效方式 |
|---|---|
| `backend/**` | 必须重启服务进程 |
| `frontend/**` | 服务静态托管 `frontend/dist`，构建后即生效（构建与重启仍属用户操作） |

### systemd（开机自启）

```bash
bash scripts/install-standalone.sh -y --service
sudo systemctl status pi-dashboard
sudo journalctl -u pi-dashboard -f
```

unit 写到 `/etc/systemd/system/pi-dashboard.service`，带 `User` / `WorkingDirectory` / `PATH` /
`PI_CODING_AGENT_DIR` / `PI_DASH_PORT`。卸载：

```bash
sudo systemctl disable --now pi-dashboard
sudo rm /etc/systemd/system/pi-dashboard.service && sudo systemctl daemon-reload
```

---

## 3. 环境变量

> **可移植性**：这些变量**默认值已改为 `<agent dir>/...`**（不再含开发机路径），新机器无需设置即可用；
> 仅当你要沿用旧的数据位置时才显式指定。`liveSessions.roots` 默认是**空**（配置驱动），
> 想扫哪些目录就在 `~/.pi/dashboard.json` 里写自己的。完整变量表见 [config.md](config.md) §2。

### 3.1 本服务相关变量

完整的加载顺序、规则和**完整变量表**见 **[config.md](config.md) §2**（本文件不重复，避免两处维护）。
本服务只需记这几条：

| 变量 | 作用 | 默认 |
|---|---|---|
| `PI_DASH_PORT` | 服务端口 | `7777` |
| `PI_DASH_HOST` | 监听地址；设 `127.0.0.1` 收敛暴露面 | `0.0.0.0` |
| `PI_SCRIPT` | 用哪个 pi 可执行文件（fork 构建） | 仓库内 `node_modules/.bin/pi` → `which pi` |
| `PI_DASH_BRIDGE_SOCKET` / `PI_DASH_BRIDGE_TOKEN` | 与 live session 桥接 | 无 |

加载到的变量会被**每一个** pi 子进程继承（`backend/pi-manager.ts` 用 `...process.env` 启动 slot），
所以扩展也能读到；启动日志会打印 `[env] loaded env file(s): …`。

### Token Cost 额度查询（可选）

Token Cost 页面会单独读取 Codex / Claude Code 的 5 小时和周用量窗口：Codex 通过 `codex app-server` 读取当前账户限额，Claude Code 使用 `CLAUDE_CONFIG_DIR`（默认 `~/.claude`）下的 OAuth 凭证查询 Anthropic 用量接口。两者都是可选项，没有相应本地登录时，原有 Token Cost 统计仍可用；API key、Bedrock/Vertex 等 Claude Code 账户不提供此订阅限额数据。凭证只由后端读取，不会下发给浏览器。完整说明见 [config.md](config.md) §2。

---

## 4. dashboard 自身配置（`~/.pi/dashboard.json`）

live session 靠它，Settings 页可改（`/api/dash/config`）：

```json
{
  "liveSessions": {
    "enabled": true,
    "roots": ["/home/example/projects"],
    "launch": {
      "command": "/home/example/.local/bin/pi",
      "args": [],
      "unsetEnv": ["HF_TOKEN", "AZURE_OPENAI_API_KEY", "…"]
    },
    "disconnectGraceMs": 60000
  }
}
```

| 字段 | 作用 |
|---|---|
| `roots` | live session 可发现的目录范围 |
| `launch.command` | live session 用哪个 pi（本机指向 fork 的 `pi-clean` 包装脚本） |
| `unsetEnv` | 启动前从环境里剔除的变量 |
| `disconnectGraceMs` | 断连后的宽限时间 |

另外：`<agent dir>/pi-web-sessions.json` 是 slot 元数据（运行时状态，自动维护）。

---

### 可选出站 WSS 会话索引与受限控制（实验性）

仅当 `<agent dir>/machine-connector.json` 存在且为有效的 0600 私有普通文件时启动。格式和权限见 [config.md](config.md)；不使用环境变量传密钥，默认关闭。认证成功后可处理 `list_sessions`（UUID requestId），回传最多 50 个受限 ASCII ID 及 idle/running/reconnecting 状态；还支持固定结构的租约声明/释放和短文本输入，必须通过机器侧会话与租约校验，重复输入或不确定结果不自动重试；输入在派发给 Pi 前先持久化预留 ID。`$HOME/.pi-dashboard-private/machine-input-replay.json`（及独占 `.lock`）为当前用户所有的 0600 私有文件，仅保留散列 ID，不能通过 HTTP/日志读取；文件损坏、权限不安全或满 100000 条时拒绝控制输入，绝不自动淘汰或清除已接受 ID。崩溃留下的锁需核实进程已退出后人工处理，详见 [config.md](config.md)。列表不包含 cwd、pid、路径或模型；另有选中会话最近最多 8 条已完成用户/助手纯文本的受限预览（不含工具输出和完整 transcript），不支持 HTTP 代理、任意 Pi 命令或图片。预认证帧最大 2048 字节、认证后最大 16384 字节；异常协议直接断链。TLS 证书校验始终启用。此连接**不替代**本服务的入站 HTTP/WS 安全边界。

## 5. 远程访问与安全

**关键前提：dashboard 的 `/api/*` 与 WS 默认无认证**，安全模型是「网络不可达」。

| 接口 | 认证 |
|---|---|
| `GET /api/*` | 无 |
| `POST/PUT/DELETE /api/*`（除 live-sessions / pty） | 无，仅 Origin 检查（防 CSRF，非认证） |
| `WS /api/ws` | 无 |
| `/api/pty`、`/api/live-sessions/*` | 有 cookie/token 认证 |

推荐做法：

```bash
# Tailscale：同一 tailnet 直接访问
http://<tailscale-ip>:7777

# 或 SSH 隧道
PI_DASH_HOST=your-server PI_DASH_USER=you ./pi-dash-connect.sh
```

**不要**把 7777 直接映射到公网；确需公网访问，在前面加 nginx + HTTPS + 认证。
已有的 nginx/Tailscale 反代部署方案见 [remote-access-deployment.md](remote-access-deployment.md)。多机器移动端远程接入尚未实现；远程网关服务端不属于本仓库；目标互通尚未完成，**不能公网发布**。公开实施状态见 [cloudflare-mobile-gateway.md](cloudflare-mobile-gateway.md)。不要把 Tunnel 直接指向 Dashboard 或任何管理服务。

---

## 6. 相关页面与文档

| 页面 / 文档 | 说明 |
|---|---|
| `/extensions` | 扩展装载事实 + 管理，见 `guide/extensions-page.md` |
| `/live-sessions` | live session 接管/分叉/导航 |
| Workbench | 子 Agent 与 Workflow 面板 |
| `guide/api-reference.md` | 后端 API |
| `guide/config.md` | 配置总览（四层地图、每个 config 谁读、怎么改） |

---

## 7. 验证

1. `curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:7777/` 返回 `200`
2. 发一条消息能流式返回（说明 `PI_SCRIPT` 与模型凭证都对）
3. 启动日志有 `[env] loaded env file(s): …`
4. `/extensions` 页面可打开，条目数正常