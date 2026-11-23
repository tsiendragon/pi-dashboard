# Android 5.70 (build 101)

## 新增

- Live 记录里的本地 PDF/Markdown 路径可以直接在 App 内打开。
- 相对路径按会话工作目录补全；兼容 `file://`、`sandbox:`、URL 编码和 `文件.md:行号`。
- Markdown 使用原生渲染；PDF 用 `PdfRenderer` 逐页渲染并滚动查看，不启动外部 PDF 应用。
- PDF 原始字节通过 `GET /api/file-read?raw=1` 获取，上限 32 MB；接口只允许 `.pdf`，不提供任意二进制读取。
- 旧 Dashboard 缺少 `raw=1` 时会提示更新并重启，而不是把 PDF 按文本打开。

## 依赖与生效

- 需要先更新并重启 Dashboard，再覆盖安装本 APK。
- 仍只支持 Dashboard 主机上的本地文件；HTTP/HTTPS 链接仍交给系统浏览器。
- Debug 预发布，尚未完成真机 PDF 渲染、大文件和加密 PDF 验收。
