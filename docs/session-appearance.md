# Live Pi 会话装扮

## 目标与设计

用户可以在会话列表中，为单个会话选择颜色与符号，快速区分用途。沿用现有主题、紧凑行布局、菜单与会话元信息接口；不改变名称、分组、运行状态或权限。

- 颜色使用独立左侧细条，不覆盖运行状态条或整行选中底色。
- 符号放在标题前；支持常用表情、自定义符号和不设置。
- 每行的调色板按钮及菜单打开设置，修改先预览，保存才写入；取消不生效。
- 恢复默认清空颜色与符号，仍需保存确认。
- 保存到服务端现有会话元信息，以持久会话标识关联；刷新与重启后保留。属于当前 Dashboard 的共享会话设置，不是独立用户的私有偏好。

## 实施与验收

1. 扩展现有元信息类型、校验、磁盘读写与重启标识迁移。
2. 接入列表、装扮弹窗和接口；保存失败不关闭弹窗，并显示原因。
3. 检查选择、预览、保存、取消、恢复默认、读取旧数据、磁盘重载及标签/置顶不受影响。
4. 运行针对性前后端测试和类型检查；浏览器视觉检查若无法执行，交付时明确说明。

## 验证与状态

实现完成，尚未部署。由用户运行 `./run.sh` 构建并重启后生效，Agent 不重启服务。

- 前端定向回归：`npm --prefix frontend test -- --run src/test/sessionAppearanceDialog.test.tsx src/test/liveSessionsSidebar.test.tsx src/test/liveSessionsUi.test.tsx`，64 项通过。
- 后端定向回归：`npm test -- backend/__tests__/live-session-meta.test.js backend/__tests__/live-session-order.test.js backend/__tests__/live-session-restart.test.js`，64 项通过，包括真实临时文件重载、非法输入、存储失败后回滚与重试。
- `npm run typecheck` 与 `npm run docs:env-check` 通过。
- 使用真实列表组件、模拟接口和隔离的浏览器页面，检查保存、刷新、取消、恢复默认、键盘焦点、明暗主题、390px 窄屏，以及 195px 有效窗口（近似 390px 窗口放大两倍）。截图复查发现的极窄弹窗横向挤压已修复，再次检查通过。
- 浏览器证据：`/tmp/pi-session-appearance-evidence/result.json` 与同目录 5 张截图；测试页面不连接真实会话，也未修改 `frontend/dist`。检查结束后关闭隔离测试服务。

尚未验证：用户重启后的真实会话操作。测试机缺少部分表情字体，截图中部分符号显示为方框；字符读写与复合表情保存已验证，实际字形依赖使用者设备的表情字体。未增加远程字体依赖。
