# Android 5.62 (build 93)

- 机器 / Dashboard 负载卡新增 GPU 利用率、显存已用/总量和磁盘占用。
- 后端 `/api/system/load` 新增 `gpu`、`disk` 字段：磁盘通过 Node `statfs` 读取根文件系统，不执行 `df`；GPU 优先读取 Linux DRM sysfs（AMD/Intel），没有 sysfs 计数时用固定参数 `nvidia-smi` 查询 NVIDIA，超时 1.5 秒。
- 没有 GPU、驱动不提供计数或旧后端时，对应字段为 `null`，App 隐藏该行，不把不可用显示成 0%。
- 磁盘、显存或 GPU 利用率达到 90% 时标红，并给出与当前最高风险对应的一条提示。
- 大字号下资源卡自动改为单列，避免 CPU/内存/GPU/磁盘数值被两列布局挤碎；进度条去掉 Material 默认端点圆点。
- 新增机器负载截图与边界测试；旧版后端仍可显示 CPU/内存。
- 后端需要由用户执行 `./run.sh` 重启后返回新字段；App 覆盖安装即可，无新配置或环境变量。
- Debug 预发布，尚未完成真机验收。
