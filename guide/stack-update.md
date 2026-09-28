# 多机更新规范（stack-update）

面向「同一套 Pi 工作台装在多台机器上，各机只去拉更新」的场景。

一句话：**代码只在源仓库改、只在源仓库发版；每台机器用自己的清单决定「装哪些扩展、跟哪个版本」，
运行 `scripts/stack-update.sh` 各自更新。三层之间不共享版本号，只共享兼容性契约。**

- 首次安装：见 [standalone-install.md](standalone-install.md) / `scripts/install-standalone.sh`
- 日常更新：本文 / `scripts/stack-update.sh`

---

## 1. 为什么不锁定全局版本

不同机器的用途不同：一台只要核心几个扩展，另一台要全套；有的机器想跟最新发版，有的想钉在上一版。
所以**不做全局 lock**，改为：

| 关注点 | 归属 | 是否跨机一致 |
|---|---|---|
| 包怎么定义（源码、发版、兼容范围） | 三个源仓库 | 共享（唯一事实源） |
| 装哪些扩展 | 每台机器本地 | **各自独立** |
| 跟哪个版本 | 每台机器本地 | **各自独立** |
| 同一台机内三层能否共存 | 兼容性契约 | 每机自校验 |
| 更新动作 | 每机一条命令 | 幂等、可回滚 |

跨机唯一必须一致的是**契约**（§5），不是版本号。

## 2. 三个源仓库（只在这里改）

| 层 | 源仓库 | 分发通道 |
|---|---|---|
| ① pi 宿主 | `github.com/tsiendragon/pi` | GitHub Release 的 10 个 tgz，tag 形如 `v0.85.1-tsien.1` |
| ② 扩展 | `github.com/tsiendragon/pi-tsien-extension` | git 伞形包（装齐）或 npm 单包 |
| ③ dashboard | `github.com/tsiendragon/pi-dashboard` | git checkout + 本地构建前端 |

**机器一律是消费端**：改行为回源仓库改、发版，再由各机更新。不要在目标机上编辑已安装副本
（`~/.pi/agent/npm/node_modules/*`、pi 的 `dist/`）——下次更新即丢，还会让机器之间静默分叉。

## 3. 每机清单 `~/.pi/agent/stack.json`

模板：`scripts/stack.json.example`。首次用：

```bash
cp scripts/stack.json.example ~/.pi/agent/stack.json
# 按机器情况改 policy / ref / 路径
```

| 字段 | 含义 |
|---|---|
| `root` | 安装根目录（默认 `~/pi-stack`） |
| `pi.repo` / `pi.prefix` | fork 仓库（`owner/name`）与安装前缀 |
| `extensions.repo` / `dir` / `config` | 扩展 git 源、clone 目录、本机扩展清单路径 |
| `dashboard.repo` / `dir` | dashboard git 源与 checkout 目录（留空=当前仓库） |
| `lastApplied` | **本机回执**：上次实际应用的三层 ref 与时间（脚本自动写） |

三层的 `policy` 取值：

| policy | 行为 |
|---|---|
| `latest-tag`（默认） | 取远端最新 `v*` tag（`sort -V`） |
| `pinned` | 固定用 `ref` 指定的 tag/commit |
| `branch` | checkout `ref` 分支并 `pull --ff-only`（仅开发机用） |
| `skip` | 本机不更新这一层 |

> `lastApplied` 是每台机器自己的回滚依据，**不需要跨机一致**，也不进 Git。

## 4. 「装哪些扩展」是每机私有的

扩展选择存在 `extensions.config.json`（默认 `~/.pi/agent/extensions.config.json`），
里面是包/扩展列表。**机器 A 装 5 个、机器 B 装 20 个都可以。**

更新脚本的规则：

- 清单**已存在** → 原样沿用，绝不覆盖；
- 清单**不存在** → 才用扩展仓库的通用集合（`config/extensions.standalone.json`）作为种子创建。

所以跨机差异不会被更新动作抹平。

## 5. 兼容性契约（唯一的跨机协调点）

各机版本可以不同，但**同一台机内三层必须落在兼容区间**，否则会降级或报错。

| 契约 | 位置 | 纪律 |
|---|---|---|
| 扩展 → pi | 扩展仓 `package.json` 的 `peerDependencies["@earendil-works/pi-coding-agent"]` | pi 有破坏性改动时同步放宽/收窄，并写 CHANGELOG |
| dashboard → pi / 扩展 | 本仓 [pi-runtime.md](pi-runtime.md) 声明支持范围 | 改支持范围时同提交更新 |
| pi fork → 下游 | 补丁 API 必须向后兼容 | 破坏性改动升 `-tsien.N` 并写 CHANGELOG |

`stack-update.sh` 会在每次运行后自动校验「已装 pi 版本 vs 扩展 peer 范围」，不满足时告警（非阻断）。

## 6. 更新流程

```bash
# 只报告漂移，不改动（适合开机巡检）
bash scripts/stack-update.sh --check

# 执行更新（含备份、写回 lastApplied、兼容性复检）
bash scripts/stack-update.sh --apply

# 只更新某一层
bash scripts/stack-update.sh --apply --only extensions

# 用非默认清单
bash scripts/stack-update.sh --check --config /path/to/stack.json
```

`--check` 输出示例：

```
[stack] pi          local=v0.85.1-tsien.1    target=v0.85.1-tsien.2    UPDATE
[stack] extensions  local=v0.1.0             target=v0.1.0             OK
[stack] dashboard   local=v1.1.3             target=v1.1.3             OK
```

`--apply` 每层做什么：

| 层 | 动作 |
|---|---|
| dashboard | `git fetch --tags` → `checkout <ref>` → `npm ci`（无 lock 则 `npm install`）→ `npm run build-frontend` |
| extensions | `git fetch --tags` → `checkout <ref>` → 装依赖 → `pi-extension-sync.mjs --apply` |
| pi | tag 变化时复用 `install-standalone.sh --pi-release ... --skip-extension-sync` 只重装 pi |

更新前会把 `stack.json` 与 `extensions.config.json` 备份到 `<清单目录>/stack-backups/<时间戳>/`。
**重启服务由你自己执行**（如 `./run.sh`）。

## 7. 源仓库侧的变更纪律（发版时要做什么）

| 改了什么 | 同提交/同发版必须做 |
|---|---|
| 扩展新增/改名/改装载 | 更新 [extensions.md](extensions.md)；扩展仓跑 `npm run parity:check` |
| pi 补丁 API 或 peer 范围 | 打新 tag；同步扩展仓 `peerDependencies`；更新 [pi-runtime.md](pi-runtime.md) |
| dashboard 环境变量 | 更新 [config.md](config.md) §2；跑 `npm run docs:env-check` |
| 发版 | 扩展：`publish:packages`（幂等续发）+ tag；dashboard：CHANGELOG + `v*` tag；pi：Release 资产保持 `earendil-works-<pkg>-<ver>.tgz` 命名 |

## 8. 每机验证清单

1. `bash scripts/stack-update.sh --check` 全部 `OK`
2. `PI_PREFIX/bin/pi --version` 与 `lastApplied.pi` 一致
3. 兼容性校验无告警（§5）
4. dashboard `/extensions` 页条目与本机扩展清单一致、无 drift
5. `curl -o /dev/null -w '%{http_code}' http://localhost:7777/` → `200`
6. 终端 `pi` 交互里 `/sidebar`、`/effort`、`/schedule` 等仍在

## 9. 禁止事项

- ❌ 手工 scp/rsync `node_modules` 或已安装扩展目录到别的机器（平台/版本错配的根源）
- ❌ 直接改已安装副本当修复（更新即丢，且造成机器间静默分叉）
- ❌ 让更新脚本覆盖本机既有的 `extensions.config.json` 选择
- ❌ 把 `extensions.config.json`、`stack.json`、`dashboard.env`、凭证、`sessions/`、`memory/` 提交进 Git
- ❌ 用 `branch` policy 跑生产机（分支会漂，无法复现）

## 10. 排障

| 现象 | 处理 |
|---|---|
| `未找到本机清单` | `cp scripts/stack.json.example ~/.pi/agent/stack.json` |
| `无法获取 <repo> 的最新 tag` | 检查网络/仓库可见性；或临时改 `policy=pinned` + `ref` |
| 兼容性告警 | 按 §5 调 pi 或扩展到同一区间，再 `--apply` |
| 更新后行为异常 | 用 `<清单目录>/stack-backups/<时间戳>/` 里的备份回滚清单，并把对应层 `policy` 改回上一版 `ref` |