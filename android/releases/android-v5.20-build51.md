# PiDash Android 5.20 · build 51

Debug 预发布版；尚未完成真机验收。

## 通知更讲道理

- Android 13+ 打开「后台会话提醒」时，先弹一句说明（只含会话标题与状态、不含正文/命令/路径、只在后台且进程存活时生效），点「继续」才请求系统权限；不再是开关一拨就弹系统框。
- 用户拒绝后提示旁多一个「打开设置」，直接跳到本应用的通知设置页，不再反复弹权限框。
- 同一会话只保留一条通知：后到的「待你回答」替换先前的「回复结束」，并按通知组归并，锁屏不会堆一串同会话提醒。

## 状态胶囊语义修正

- 「待确认」以前和「已回复」一样显示勾选标记，容易被读成已完成；现在勾只表示真的结束，等待人工确认显示中性圆点。

## 截图回归（本轮新增基础设施）

- 引入 Roborazzi + Robolectric，在 JVM 上直接渲染 Compose 并比对基线图，不需要模拟器：
  - `status-pills.png`、`expand-hints.png`、`markdown-body.png` 三张基线已提交到 `app/src/test/screenshots/`。
  - 改动这些组件后用 `./gradlew :app:recordRoborazziDebug --rerun-tasks` 更新基线，`./gradlew :app:verifyRoborazziDebug` 校验；普通 `testDebugUnitTest` 也会一起跑到。
- 依赖只进入 `unitTest` 配置（roborazzi 1.44.0、robolectric 4.14.1、androidx.test.ext:junit 1.2.1），不改变 APK 体积与运行时依赖；首次运行需要联网拉取 Robolectric 的 android-all jar。
- 同一轮把 `guide/dashboard.md` 的提醒章节与构建命令补上了这两处变化。

## 验证与限制

- 编译通过；JVM 单测 **212 项**（含 3 项截图基线比对、3 项设计约定守卫）全部通过；签名与固定证书一致。
- 截图基线只能证明「渲染没变」，不能证明「好看」；通知的权限流程与同会话替换仍需真机确认（尤其 Android 13/12 的不同权限弹窗行为）。
