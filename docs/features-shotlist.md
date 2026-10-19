# 截图清单与状态（临时文件，定稿后删除）

> ⚠️ 本仓库是**公开**的（`tsiendragon/pi-dashboard`，public）。截图里不要出现内部任务名、
> 内部仓库名、本机绝对路径、内网 IP / 主机名、真实金额与 token 数。

图片统一放到 `docs/images/features/`，文件名照下表（`docs/features.md`、`docs/features.en.md`、
`README.md` 已按这个名字引用）。建议 1440×900、暗色主题、2 倍清晰度，PNG。

## 当前状态

| 文件 | 页面 | 状态 |
|------|------|------|
| `00-nav-overview.png` | `/chat` | ✅ 已生成（已用于 README 与两份导览） |
| `09-extensions.png` | `/extensions` | ✅ 已生成（本机路径已打码） |
| `14-settings.png` | `/settings` | ✅ 已生成 |
| `01-chat.png` | `/chat` | ✅ 已生成（用户提供，真实对话：思考过程 + 工具组「2 完成 · 1 失败」；浅色主题） |
| `02-files.png` | `/chat` + 文件面板 | ✅ 已生成（用户提供，文件树；本机路径已改写成 `~/repos/pi-dashboard`） |
| `02-preview.png` | 文档全屏预览 | ✅ 已生成（用户提供，Preview / Edit / Save / 下载；已裁到弹窗内，去掉背后的会话文字） |
| `05-context.png` | Live 会话页「◲ 上下文」 | ✅ 已生成（用户提供，上下文检查面板；已裁到面板内，去掉背后的聊天文字） |
| `03-terminal.png` | 终端 | ⏳ 待补 |
| `04-subagent.png` | Live 会话页顶部 | ✅ 已生成（用户提供，子代理状态分组 + 活动执行记录；背景侧栏与右栏已裁掉） |
| `04-live-sessions.png` | `/live-sessions` | ⛔ 已删除：用户提供的截图里有内部项目名字眼，不适合公开仓库 |
| `05-supervisor.png` | `/supervisor` | ⛔ 同上（自动截图是红色报错） |
| `06-tasks.png` | `/tasks` | ⛔ 含内部任务名，需脱敏或换演示数据 |
| `07-cost-time.png` | `/insights` | ⛔ 含真实金额与 token 数 |
| `08-system.png` | `/system` | ⛔ 含内网主机名与 IP |
| `13-repos.png` | `/repos` | ⛔ 含内部仓库名与本机路径 |
| `11-logs.png` / `12-jobs.png` | `/logs` `/jobs` | ⏳ 自动截图是空页面，有内容才好看 |
| `15-session-gallery.png` | `/live-sessions/gallery` | ⛔ 需认证 |
| `16-session-graph.png` | `/live-sessions/graph` | ⛔ 需认证 |
| `10-mobile.png` | App / 窄屏 | ⏳ 待补 |

被否掉的自动截图放在 `/tmp/pi-dash-shots-rejected/`（仓库之外，不会误提交），供你核对。

**已删除**：`04-live-sessions.png`（用户提供的会话侧边栏截图）含内部项目名与标签，已从 README、两份导览和 `docs/images/features/` 移除。拍这一页请先确认画面里没有内部项目名、仓库名、标签或会话标题。

## 重新生成

`scripts/shoot-docs.py` 可以重拍（需要本机 Playwright + Chromium）：

```bash
python scripts/shoot-docs.py --only 00-nav-overview,09-extensions
```

拍完**务必逐张检查**有没有上面列的敏感信息，再入库。