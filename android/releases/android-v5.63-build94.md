# Android 5.63 (build 94)

- Live 顶部工作状态新增 Workbench 子 Agent / 工作流行，读取扩展发布的 `subagent-workflow` 快照。
- 主 Agent 空闲但子 Agent 或 Workflow 仍在运行时，状态行仍然显示并保持“运行中”呼吸灯；不会再把会话误认为完全空闲。
- 显示正在运行、待处理、失败和暂停的数量；Workflow 子会话不会重复算作普通子 Agent。
- 点击状态行打开只读明细：普通子 Agent 的状态与 id；Workflow 的状态、当前阶段和任务完成/失败数。
- 没有该快照的旧扩展不显示这一行；手机不提供启动、重试、暂停或审批操作，继续去 Pi Workbench 处理。
- 修复状态行在窄屏把“进行中”拆成单字换行的问题：按完整短语流式排列。
- 仅改 Android App，覆盖安装即可；旧扩展更新后需 `/reload`，不需要重启 Dashboard。
- Debug 预发布，尚未完成真机验收。
