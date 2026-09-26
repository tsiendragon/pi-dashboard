# AGENTS.md

## 文档维护（重要）

- `guide/` 是部署/安装/配置的**唯一权威入口**：`guide/README.md`（总览）+ `guide/pi-runtime.md`（pi 宿主，fork 构建）+ `guide/extensions.md`（pi-tsien-extension）+ `guide/dashboard.md`（本服务）+ `guide/config.md`（配置总览）+ `guide/standalone-install.md`（手动逐步版）。
- **凡是影响安装、配置、组件关系、依赖版本或环境变量的改动，必须在同一次提交里同步更新 `guide/`。** 具体触发项见 `guide/README.md` §7。
- 找不到该更新的位置时，先补进 `guide/README.md`，再决定是否新拆模块文档。
- `docs/` 下是专题设计文档；安装/部署步骤不要散落在 `docs/`，一律收进 `guide/`。

## 服务部署 / 重启（重要）

- 服务的启动、重建和重启由**用户自己执行** `./run.sh`，不要由 agent 代劳。
- agent **不要**擅自 kill 正在运行的 dashboard 服务进程，也不要运行 `./restart.sh` 或 `sudo systemctl restart pi-dashboard`。
- `./run.sh` 会先构建前端、再以 `tsx backend/server.ts` 启动常驻服务；重启会中断当前所有活跃会话。
- 代码改动的生效方式：
  - 后端（`backend/**`）：必须重启服务进程才生效。
  - 前端（`frontend/**`）：服务静态托管 `frontend/dist`，构建后即生效，但构建与重启仍属用户控制的部署步骤。
- agent 完成代码修改后，把「需要用户执行 `./run.sh`（或按用户自己的启动方式）生效」写入交接说明，而不是自行重启服务。