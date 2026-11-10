# Android UI 契约（可检查的底线）

这份文件把 Android 端「什么算做对了」固化成条款，配合 `.pi/skills/dashboard-ui-ux/SKILL.md`
的流程使用。目的不是限制设计，而是让每一次改动都不会悄悄退回默认样式。
Web 端的对应规则见 [`design-craft-rules.md`](design-craft-rules.md)。

## 1. 底线（任何改动都不得违反）

| # | 条款 | 现状 / 检查 |
|---|---|---|
| 1 | 文字样式只来自 `PiType`，不直接写 `MaterialTheme.typography` 或裸 `fontSize` | `DesignTokenGuardTest` 两条断言 |
| 2 | 颜色只来自主题：`MaterialTheme.colorScheme` / `Tints` / `CodeColors`；不在 `ui/theme` 之外写 `Color(0x…)` | `DesignTokenGuardTest` |
| 3 | 变淡一律走 `Tints.*`，不写裸 alpha | `DesignTokenGuardTest` |
| 4 | 弹层形状统一 `Radii.sheet`（14 dp）；卡片 `Radii.card` | `DesignTokenGuardTest` 检查每个 `AlertDialog(` 都带 `shape = Radii.sheet` |
| 5 | 间距走 4 dp 网格：`Spacing.xxs…xxl`（2/4/8/12/16/24/32） | review |
| 6 | 可点击目标 ≥ 48 dp；视觉更小的控件用「视觉 34–36 dp + 48 dp 点击区」实现（见 `SegmentedTabs`、`ComposerPill`、`ApprovalCard`） | 组件测试逐条断言高度 |
| 7 | 动效必须能被系统「移除动画」关掉：用 `Motion.*` 与 `animatorsEnabled()`，动画不是唯一信号 | `PulsingDotTest` |
| 8 | 空内容不写剪贴板、不伪造状态；缓存态必须显式标注，不能冒充实时 | `TextCopyTest`、缓存相关测试 |
| 9 | 破坏性操作不用裸红字或第二层边框表达：失败用胶囊（`StatPill` / `TraceState`），危险确认才允许实心按钮 | `ActivityCardStyleTest`、sudo 例外见 §4 |

## 2. 唯一组件（同一种东西只允许一个实现）

| 用途 | 组件 | 位置 |
|---|---|---|
| 页头（48 dp、标题/副标题/操作） | `CompactPageHeader` | `ui/common/CompactPageHeader.kt` |
| Tab（Live Pi/Chat、活动/完整、主题/字号） | `SegmentedTabs` | `ui/common/SegmentedTabs.kt` |
| 输入框（标签在上、发丝边框） | `PiTextField` | `ui/common/PiTextField.kt` |
| 会话输入胶囊 | `ComposerPill` | `ui/live/ComposerPill.kt` |
| 折叠块（执行步骤/思考/执行记录） | `TraceBlock` + `StatPill` | `ui/live/TraceSection.kt` |
| 待处理请求 | `ApprovalCard` | `ui/live/ApprovalCard.kt` |
| 排队消息 | `QueuedPromptsBar` / `QueuedPromptsSheet` | `ui/live/QueuedPrompts.kt` |
| 运行指示 | `PulsingDot` | `ui/common/PulsingDot.kt` |
| 复制 | `CopyTextAction` | `ui/common/CopyTextAction.kt` |
| 主创建按钮 | `PrimaryCreateAction` | `ui/common/CompactPageHeader.kt` |

新增页面先在这张表里找组件；找不到时先补进 `ui/common`，不要在各页面复制一份。

## 3. 文案与状态

- 状态只有四种语气：运行中（呼吸灯 + 文字）、失败（错误胶囊）、等待用户（`需要你处理` 卡片）、完成（静态、不喧哗）。
- 计数用 `N 步` / `排队 N 条` / `还有 N 个`，不加感叹号，不用「请立即」这类催促。
- 空状态至少说明「为什么空」和「下一步做什么」；不做营销文案。
- 失败必须给出可执行的原因与下一步（`操作结果未确认，请先刷新会话`），不吞异常、不自动重试。

## 4. 有意保留的例外

- **sudo 授权弹窗**的确认按钮保持实心：不可撤销的提权需要比普通按钮更强的视觉权重。
- **Chat 页的旧消息气泡**保持原样：它是历史会话的阅读样式，不与 Live 卡片统一。
- **卡片内可再嵌 `TraceBlock`**：执行步骤是卡片的一个区块，不是第二张卡片；除此之外不再加第三层容器。

## 5. 改完之后

1. 组件改动：补该组件的截图测试（明/暗/200% 字号/宽屏至少各一）。
2. 交互/文案改动：补断言，而不只是截图。
3. 提交前跑 `recordRoborazziDebug` 与 `verifyRoborazziDebug :app:assembleDebug`（分两次，不要合在一条命令里）。
4. 交付说明里写清「组件截图 ≠ 整页/真机验收」，没有真机时不声称已验证。