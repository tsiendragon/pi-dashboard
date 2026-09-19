# 远程访问部署方案（公网服务器 + Tailscale 反代）

目标：**手机 App 不进家里的内网、不常开 tailscale，也能通过 HTTPS 访问各台机器上的 pi-dashboard。**
本方案只改服务器网络层，**pi-dashboard 零代码改动**。

---

## 0. 背景：为什么必须自己加认证

pi-dashboard 的安全模型是「**靠网络不可达来保护**」，而不是靠认证：

| 接口 | 认证情况 |
|---|---|
| `GET /api/*` | **无认证**（任何人可读会话、文件、状态） |
| `POST/PUT/DELETE /api/*`（除 live-sessions / pty） | **无认证**，仅有 Origin 检查（防浏览器 CSRF，非认证） |
| `WS /api/ws` | **无认证**，仅有 Origin 检查 |
| `/api/pty`、`/api/live-sessions/*` | 有 cookie/token 认证 |

源码注释原文：

> This is the only barrier between that JS and the **un-authed** file/slot/job mutation API.

而 agent 能读写文件、执行命令。**因此：绝不能把 7777 直接映射到公网。**
认证必须补在服务器（nginx）这一层。

---

## 1. 架构

```
[手机 App] ──HTTPS 443 + (basic/bearer)──> [公网服务器 nginx]
                                                │  tailscale（服务器 ↔ 各 pi 机器同 tailnet）
                                                ▼
                                        [pi 机器 dashboard:7777]
```

- 手机侧：只连服务器，**不需要 tailscale**
- 机器侧：装 tailscale（长期开机，常开无妨）
- 服务器侧：tailscale + nginx + TLS
- dashboard：绑定 `0.0.0.0:7777`（默认），由 nginx 反代

> 若不想用 tailscale，可用 frp / `ssh -R` 的反向隧道替代（见 §10 备选）。

---

## 2. 前置条件

- 一台有**公网 IP** 的 Linux 服务器（本方案用 Debian/Ubuntu 命令）
- 一个**域名**（可用子域名，如 `pi.example.com`）
- 各 pi 机器能**出站**访问互联网
- 服务器可 `sudo`，能装软件、开 80/443

---

## 3. 服务器部署步骤

```bash
# 3.1 安装 nginx / certbot / tailscale
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx apache2-utils
curl -fsSL https://tailscale.com/install.sh | sh

# 3.2 服务器加入 tailnet
sudo tailscale up

# 3.3 确认服务器能连到 pi 机器（MagicDNS 名）
#     机器名可在 tailscale 管理后台或 `tailscale status` 查到
curl -sS -o /dev/null -w '%{http_code}\n' \
  http://<PI_机器名>.<TAILNET>.ts.net:7777/
# 期望输出 200
```

> 若这一步不通：确认 pi 机器已 `tailscale up`，且 tailnet ACL 允许服务器访问它。

---

## 4. nginx 配置（单机）

```bash
sudo htpasswd -c /etc/nginx/.htpasswd <你的用户名>   # 设一个强密码
sudo tee /etc/nginx/sites-available/pi-dashboard >/dev/null <<'NGINX'
server {
    listen 80;
    server_name pi.example.com;          # ← 换成你的域名

    # ★ 认证层：dashboard 自身没有，必须在这里补
    auth_basic           "pi-dashboard";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass         http://PI_MACHINE.TAILNET.ts.net:7777;   # ← 换成 pi 机器 tailnet 名
        proxy_http_version 1.1;

        # WebSocket（/api/ws、/api/live-sessions/ws 都靠它）
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";

        # 让 dashboard 看到的 Host 与浏览器 Origin 一致（Origin 判定需要）
        proxy_set_header   Host              $host;
        proxy_set_header   X-Forwarded-Host  $host;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   X-Real-IP         $remote_addr;

        # 长连接 / 流式
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering    off;

        client_max_body_size 50m;        # dashboard JSON 上限 50mb
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/pi-dashboard /etc/nginx/sites-enabled/pi-dashboard
sudo nginx -t && sudo systemctl reload nginx
```

**为什么要 `Host $host`**：`originAllowed()` 判定 `Origin === http(s)://<Host>`。
浏览器请求带 `Origin: https://pi.example.com`，因此必须让 dashboard 收到的 `Host` 也是 `pi.example.com`，否则状态变更类请求会被 403。

---

## 5. HTTPS 证书

```bash
sudo certbot --nginx -d pi.example.com
# certbot 会自动改写成 443 + 重定向 + 自动续期（systemd timer）
sudo systemctl status certbot.timer --no-pager | head -3   # 确认续期已启用
```

---

## 6. 防火墙

```bash
sudo ufw allow 80,443/tcp
sudo ufw enable
# tailscale 走 UDP 41641 出站，无需入站规则
# 不要开放 7777
```

---

## 7. 验证

```bash
# 带密码访问（模拟 App）
curl -u <用户名>:<密码> -sS https://pi.example.com/api/system/status | head -c 200
```

- **手机浏览器**打开 `https://pi.example.com` → 弹框输密码 → 应看到 dashboard
- 若能打开且能发消息，说明 HTTPS + WS + 认证全通

---

## 8. 客户端（App）要点

- 所有请求（含 WebSocket）都要带认证：
  - **basic**：`Authorization: Basic base64(user:pass)`（Android OkHttp / iOS URLSession 都支持）
  - 或改用 **bearer token**（见 §10）
- 原生客户端的 WebSocket 请求可以带自定义头（浏览器不行，所以别指望在浏览器里配 bearer）
- 多机时：App 内维护**多个后端地址**，首页并发拉取并合并展示

---

## 9. 多机扩展

现在是 1 台，以后加机器只需复制一份 server 块：

```nginx
server {
    listen 80;
    server_name pi2.example.com;                       # 每台一个子域名
    auth_basic           "pi-dashboard";
    auth_basic_user_file /etc/nginx/.htpasswd;
    location / {
        proxy_pass http://PI_MACHINE_2.TAILNET.ts.net:7777;
        # ... §4 中的 proxy_* 头与超时设置照抄
    }
}
```

> 也可用通配 `*.example.com` + `map` 把子域名映射到 tailnet 名，避免重复。

App 侧：配置 N 个地址即可，**服务器与 dashboard 都不用再改**。

---

## 10. 进阶：更强认证

basic auth 的密码在客户端是明文存储，适合起步，建议逐步升级：

### 10.1 Bearer token（推荐下一步）
```nginx
# 只允许带正确 token 的请求
if ($http_authorization != "Bearer <长随机串>") { return 401; }
```
App 端在所有请求（含 WS）带 `Authorization: Bearer <token>`。
注意：**浏览器无法为 WebSocket 设自定义头**，此方案只适合原生 App。

### 10.2 mTLS（客户端证书）
App 内置客户端证书，nginx `ssl_client_certificate` + `ssl_verify_client on`。最强，但对 App 分发要求高。

### 10.3 设备配对
App 首次连接时用一次性码换取长期 token，存在服务端白名单。工作量最大，体验最好。

### 10.4 限速 / 防爆破
```nginx
limit_req_zone $binary_remote_addr zone=pi:10m rate=10r/s;
# server 内：limit_req zone=pi burst=20 nodelay;
```
外加 `fail2ban` 针对 nginx 401 日志。

---

## 11. 备选网络方案（不依赖 tailscale）

若某些机器无法装 tailscale，可在服务器跑反向隧道：

| 工具 | 机器端 | 服务器端 |
|---|---|---|
| frp | `frpc` 把本地 7777 → 服务器端口 | `frps` + nginx 反代该端口 |
| ssh 反向隧道 | `ssh -N -R 7801:127.0.0.1:7777 user@server`（配 autossh 保活） | nginx 反代 `127.0.0.1:7801` |

两者都只需机器**能出站**；nginx 配置与 §4 完全一致，只改 `proxy_pass` 目标。

---

## 12. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 浏览器 401 | 密码错；`htpasswd` 文件路径错；nginx 未 reload |
| 页面能开但**发消息 403** | `Host` 头没设对 → 确保 `proxy_set_header Host $host`；或用浏览器访问的域名设 `PI_DASH_ALLOWED_ORIGIN`（见 §13） |
| WebSocket 连不上 | 缺少 `Upgrade/Connection` 头；或 `proxy_read_timeout` 太短 |
| 502 Bad Gateway | 服务器连不到机器：检查 tailscale、机器 dashboard 是否在跑、ACL |
| `originAllowed` 拒绝 | 见下节 |

---

## 13. dashboard 侧相关环境变量

在 **pi 机器**上启动 dashboard 时：

| 变量 | 作用 |
|---|---|
| `PI_DASH_HOST` | 监听地址，默认 `0.0.0.0`（反代场景保持默认即可） |
| `PI_DASH_PORT` | 端口，默认 `7777` |
| `PI_DASH_ALLOWED_ORIGIN` | 额外允许的浏览器 Origin（仅**浏览器/WebView** 需要，如 `https://pi.example.com`） |

> 原生 App 不带 `Origin`，`originAllowed()` 直接放行，**无需**设置此变量。
> 只有用 **WebView 壳 / PWA**（浏览器引擎）访问时才需要。

---

## 14. 安全清单（上线前逐条核对）

- [ ] 只用 HTTPS，certbot 自动续期已启用
- [ ] 服务器层认证已开（basic / bearer / mTLS）
- [ ] 防火墙只开 80/443，**未**暴露 7777
- [ ] 机器→服务器仅经 tailscale（ACL 限制只允许该服务器）
- [ ] 限速 + fail2ban
- [ ] 认证凭据定期轮换
- [ ] 明确认知：**认证一旦绕过 = 对方可读写文件、执行命令**

---

## 15. 落地节奏建议

1. **阶段 0**（本方案）：打通「手机 HTTPS → 服务器 → 1 台机器」
2. **阶段 1**：Android WebView 壳（多地址 + 内置凭据），复用现有 web 手机端 UI
3. **阶段 2**：原生 App（照 `apple/PiDash` 功能 + 多机聚合首页）
4. **阶段 3**：更强认证（bearer/mTLS）+ 推送通知（FCM）
