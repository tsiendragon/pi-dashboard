# AGENTS.md

## 默认 UI 目标（重要）

- 用户日常面对的是 **Live Pi 会话页**（`frontend/src/features/live-sessions/LiveSessionPage.tsx`，含右边栏 `LiveSessionFeatures.tsx`），不是 `/chat` 的 ChatPage。
- 凡是「界面上加按钮 / 快捷操作 / 面板」类需求，**没有特别说明时一律改 Live Pi**；ChatPage 只有在用户明确点名时才动。

## 文档维护（重要）

- `guide/` 是部署/安装/配置的**唯一权威入口**：`guide/README.md`（总览）+ `guide/pi-runtime.md`（pi 宿主，fork 构建）+ `guide/extensions.md`（pi-tsien-extension）+ `guide/dashboard.md`（本服务）+ `guide/config.md`（配置总览）+ `guide/standalone-install.md`（手动逐步版）+ `guide/stack-update.md`（多机更新规范）。
- **凡是影响安装、配置、组件关系、依赖版本或环境变量的改动，必须在同一次提交里同步更新 `guide/`。** 具体触发项见 `guide/README.md` §7。
- 找不到该更新的位置时，先补进 `guide/README.md`，再决定是否新拆模块文档。
- `docs/` 下是专题设计文档；安装/部署步骤不要散落在 `docs/`，一律收进 `guide/`。
- 改动 `backend/**` 里的环境变量读取后，运行 **`npm run docs:env-check`**：它会扫描代码里的 `process.env.*` 并核对 `guide/config.md`，缺失则报错列出（内部变量在脚本 `IGNORE` 白名单）。

## 服务部署 / 重启（重要）

- 服务的启动、重建和重启由**用户自己执行** `./run.sh`，不要由 agent 代劳。
- agent **不要**擅自 kill 正在运行的 dashboard 服务进程，也不要运行 `./restart.sh` 或 `sudo systemctl restart pi-dashboard`。
- `./run.sh` 会先构建前端、再以 `tsx backend/server.ts` 启动常驻服务；重启会中断当前所有活跃会话。
- 代码改动的生效方式：
  - 后端（`backend/**`）：必须重启服务进程才生效。
  - 前端（`frontend/**`）：服务静态托管 `frontend/dist`，构建后即生效，但构建与重启仍属用户控制的部署步骤。

- agent 完成代码修改后，把「需要用户执行 `./run.sh`（或按用户自己的启动方式）生效」写入交接说明，而不是自行重启服务。

## Android 交付 / GitHub 发布

- 用户要求：每次交付新的可安装 Android 版本，同时发布到 `tsiendragon/pi-dashboard` 的 GitHub Releases，不只提供本机路径。权威操作说明在 `guide/dashboard.md` 的 Android GitHub 发布小节。
- 新版递增 `versionName` / `versionCode`，通过测试和 APK/签名核验，提交本版本文件后运行 `python3 android/publish.py --publish`。脚本默认仅本地校验，显式 `--publish` 才推版本 tag 和上传 APK、SHA256SUMS、build-info.json。
- 使用现有稳定签名；公有证书摘要固定在 `android/release-signing-cert.sha256`。不得为了 CI/覆盖安装重新生成密钥、上传签名私钥或把私钥放进仓库；更换签名须先获得用户确认并规划迁移。
- 当前 APK 属 Debug 预发布版，未完成真机验收，不标为正式稳定版。已经发布的同版附件/tag 不覆盖、不强推；失败保留草稿，同内容可继续上传。
- 发布只涉及 App 产物，不开放 Dashboard 服务；不得打包/上传后端状态目录、设备配置、token、Cookie、配对码。不要纳入其他用户在途修改，也不要为发布重启 Dashboard。
