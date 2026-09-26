# ② pi-tsien-extension 扩展集合

> 一组面向 Pi 的 TypeScript 扩展（sidebar / schedule / subagent / live session / 后台命令 /
> goal / memory / git-graph / code-mode …）。dashboard 的 live session、Workbench、Extensions 页
> 都靠它提供的钩子和工具。

- 仓库：`github.com/tsiendragon/pi-tsien-extension`
- 本机参考位置：`/mnt/workspace/lilong/repos/pi-tsien-extension`
- 上游参考：`github.com/earendil-works/pi-mono`

---

## 1. 仓库结构（已重构，务必注意）

**不再是散落的 `extensions/*.ts`，而是 npm workspaces 单仓：**

```
pi-tsien-extension/
├── package.json            # 根 = 「伞形包」，pi.extensions 显式列出 25 个扩展入口
├── packages/               # 26 个独立包（一功能一包）
│   ├── pi-tsien-shared/         # 共享库（被其它包 import，本身不是扩展入口）
│   ├── pi-tsien-web-tools/      # 自研 WebSearch / WebFetch
│   ├── pi-tsien-live-session/   # dashboard live session
│   └── …                         # 共 26 个
├── config/
│   ├── extensions.standalone.json   # 独立安装的装载清单（25 packages + 25 extensions）
│   └── examples/                    # 各扩展的配置模板
├── scripts/pi-extension-sync.mjs    # 把清单同步进 Pi 的 settings.json
└── vendor/                          # 打补丁的第三方副本（回滚路径）
```

- Pi 直接加载各包的 TS 入口（根 `package.json` 的 `pi.extensions`，多数是 `src/index.ts`），**无需预编译**。
- 包之间用普通 semver 互相依赖，经 npm workspaces 链接进根 `node_modules`，跨包引用写包名。

---

## 2. 三种安装方式

### 2.1 从 npm（推荐，单包或少量）

```bash
pi install npm:pi-tsien-web-tools        # 单个扩展
pi install npm:pi-tsien-live-session     # 依赖 pi-tsien-shared 会自动一起装
pi list                                  # 确认
```

**`npm:` 前缀不能省**（裸名字会被 pi 当作本地路径，报 `Path does not exist`）。
装完落在 `~/.pi/agent/npm/node_modules/`，`settings.json` 记的是 `"npm:pi-tsien-xxx"`。

### 2.2 从 GitHub 一条命令装齐（含未发布到 npm 的）

仓库根是伞形包，`pi.extensions` 列了全部 25 个入口，所以直接装仓库根即可：

```bash
pi install git:github.com/tsiendragon/pi-tsien-extension
```

pi 会 clone 并自动 `npm install --omit=dev`；`workspaces: ["packages/*"]` 把 26 个包链接到同一
`node_modules`。**注意 `git:` 源只支持仓库根**（无子目录语法）。

### 2.3 从本地路径（要改代码，或装未发布的单包）

```bash
git clone https://github.com/tsiendragon/pi-tsien-extension.git
cd pi-tsien-extension && npm install        # 必须在仓库根先装，否则跨包 import 解析不了
pi install /abs/path/to/pi-tsien-extension/packages/pi-tsien-memory
```

---

## 3. npm 发布状态（2026-09-26 实测）

26 个包中 **10 个已发布**到公共 npm（版本 `0.1.0`）：

`pi-tsien-shared`、`pi-tsien-auto-compact`、`pi-tsien-capability`、`pi-tsien-code-mode`、
`pi-tsien-compact-continue`、`pi-tsien-context-powerline`、`pi-tsien-default-system-prompt`、
`pi-tsien-git-graph`、`pi-tsien-goal`、`pi-tsien-live-session`

其余 **16 个尚未发布**（首次批量发布撞 npm 账号级 429 限流，后续补发）：
`pi-tsien-web-tools`、`pi-tsien-memory`、`pi-tsien-metrics-sidebar`、`pi-tsien-observation-pack`、
`pi-tsien-prompt-inspector`、`pi-tsien-rtk-fork`、`pi-tsien-running-commands`、`pi-tsien-schedule`、
`pi-tsien-session-aliases`、`pi-tsien-session-ui-fork`、`pi-tsien-sidebar`、`pi-tsien-side-chat`、
`pi-tsien-subagent-workbench`、`pi-tsien-thinking-level`、`pi-tsien-trajectory-recorder`、
`pi-tsien-usage-analytics`

> 因此**要装齐 25 个扩展，优先用 §2.2 的 git 伞形包**；只挑已发布的几个才用 §2.1 的 npm。

维护者补发（token 从 vault 注入，不落盘）：

```bash
sekret local exec tsien account -- npm run publish:packages    # 断点续发，已发布的自动跳过
```

---

## 4. standalone 配置与同步器

独立（不接内部 marketplace）安装用的最小清单是 `config/extensions.standalone.json`：
当前是 **25 个 package + 25 条 extension 装载项**（包含 `pi-tsien-web-tools`；
共享库 `pi-tsien-shared` 作为依赖自动带入，不单独列）。它**不含** `task-pilot`、`security-guard`、
`remote-notifications`、`pi-knowledge` 等外部来源。

```bash
node scripts/pi-extension-sync.mjs --config config/extensions.standalone.json            # 预览
node scripts/pi-extension-sync.mjs --config config/extensions.standalone.json --apply    # 应用
```

- 同步器把有序的 `packages` / `extensions` 写进 Pi 的 `~/.pi/agent/settings.json`。
- **严格模式**：不在清单里的 package/extension 会被移除；`<agent>/extensions/*.ts` 下未托管的散文件
  会被移入 `extension-quarantine/`。原 `settings.json` 备份到 `<agent>/extension-sync-backups/<时间戳>/`。
- 默认读 `~/.pi/agent`；换 agent 目录或隔离测试时必须显式 `--agent-dir <path>`，否则会读错配置。

`pi-dashboard` 的一键安装脚本会自动应用这份配置（见 `scripts/install-standalone.sh`）。

---

## 5. 避免重复加载

如果机器上仍有旧的独立副本，先停用，否则会同时加载两份、命令显示成 `/git-graph:1`、`/git-graph:2`：

```text
~/.pi/agent/extensions/git-graph.ts
~/.pi/agent/extensions/subagent-sidebar.ts
~/.pi/agent/extensions/context-powerline.ts
```

本仓库不会自动修改或删除其他全局 extension。

---

## 6. 在 dashboard 里管理（推荐）

打开 `http://<host>:7777/extensions`（见 `guide/extensions-page.md`）：可查看装载事实、启停、排序、
从 npm registry / 包名 / 本地路径 / git URL 安装、看审计与回滚。

两个前提：
1. **写操作需先在浏览器认证一次**（dashboard 默认监听 `0.0.0.0` 且只读开放）：粘贴启动日志里的令牌即可。
2. 每次写前自动备份 `settings.json` 到 `<agent>/backups/settings-<时间>.json`，审计写在
   `<agent>/extension-audit.jsonl`。

---

## 7. 验证

1. `pi list` 能看到已装条目
2. 终端 `pi` 里 `/sidebar`、`/effort`、`/schedule`、`/btw` 等命令存在
3. `node scripts/pi-extension-sync.mjs` 再次运行输出 `Pi extensions already match the ordered user config.`
4. dashboard `/extensions` 页面条目数与 `settings.json` 一致，无 `drift`

外部用户视角的完整步骤与踩坑：扩展仓库 `pi-tsien-extension/docs/quickstart.md`。