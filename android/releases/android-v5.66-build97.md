# Android 5.66 (build 97)

- Live 输入框附件菜单支持 Word：`.doc`、`.docx`、`.docm`、`.dotx`。
- 选择 Word 后，App 通过现有 `POST /api/upload-files` 上传原文件到 Dashboard 主机临时目录，再把绝对路径写进消息；附件条显示“已上传”，可移除。
- 单文件上限 10 MB；Word 与文本附件合计最多 3 个；上传完成前不能发送。
- 原文件保留在服务器临时目录，由 Agent 的文件工具读取；不会把二进制内容直接塞进消息。
- 上传失败会明确提示，不把失败文件加入待发送列表。
- 仅改 Android App，覆盖安装即可；不需要重启 Dashboard。若服务器缺少 `/api/upload-files`，需更新后端。
- Debug 预发布，尚未完成真机验收。
