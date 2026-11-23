# Android 5.69 (build 100)

## 新增

- Live 会话列表每一行新增该会话工作目录对应的 Git 仓库远程 URL。
- 优先显示 `origin`；没有 `origin` 时显示第一个配置的 remote；非 Git 目录或无 remote 的会话不显示，不补造 URL。
- 服务端读取并缓存 30 秒；HTTPS 远程 URL 会删除用户名、密码和 token 类查询参数，SSH/SCP 形式保留。客户端只接收清理后的值。
- 会话操作表新增“复制仓库远程 URL”，不受列表单行省略影响；Web 会话列表也显示该 URL，并提供复制入口。

## 依赖与生效

- 这是服务端字段和 App 显示的组合改动：先更新并重启 Dashboard，再覆盖安装本 APK。
- 不需要 `/reload`；不会修改仓库、remote、克隆或网络。
- Debug 预发布，尚未完成真机验收。
