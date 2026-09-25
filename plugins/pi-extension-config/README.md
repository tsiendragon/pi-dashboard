# pi-extension-config（dashboard 插件）

在 dashboard 的 **Settings → general** 页底部渲染一个 “Extension config” 区块，用来查看/修改
`<agent dir>/*.json` 这批扩展配置，不用手改文件。

- 插件通过 `settings-section` 槽位贡献（`package.json` 的 `pi-dashboard-plugin.claims`），
  入口 `src/client.tsx` 导出 `ExtensionConfigSettings`。
- 所有文件读写都走后端 `GET/PUT /api/ext/config[/:name]`（`backend/routes/ext-config.ts`）：
  后端只认**白名单**里的名字，并把路径限制在 agent 目录内，写入是「临时文件 + rename」原子操作。
- 现在覆盖 7 个：`bash-digest`、`observation-pack`、`large-read-pack`、`auto-compact-target`、
  `compact-thinking`、`capability`、`claude-code-style`。
- 故意不在列表里：`theme.json`（可选覆盖文件，建空的没意义）、
  `tsien-memory.json` / `rtk-config.json`（按项目 `<cwd>/.pi/` 解析，机器级不适用）。

## 语义提醒

扩展在**加载时**读取自己的配置文件，所以保存后需要 `/reload` 或**重开会话**才生效
（实测 `/reload` 不会重载扩展代码，老 session 仍跑旧代码）。

「文件不存在」是正常状态：扩展会退回内置默认值。点「创建并保存」会用与该扩展内置默认值一致的
内容建出文件，方便你后续微调。

## 开发

```bash
cd frontend && npm run build      # 会重新生成 frontend/src/generated/plugin-registry.tsx
```

插件文件由 Vite 打包、**不参与前端 tsc 类型检查**（所以文件头带 `@ts-nocheck`，与其他插件一致）。
改动后端路由后需要重启 dashboard 服务。