# PiDash Android · 交接文档

> 最后更新：2026-09（4 轮代码审查完成后）
> 设计文档：[`../docs/android-app-design.md`](../docs/android-app-design.md) · 网络接入：[`../guide/remote-access-deployment.md`](../guide/remote-access-deployment.md)
> 本文件是**唯一**的进度/交接来源，避免多份文档漂移。

---

## 0. 一句话状态

原生 Compose 客户端 **A1–A5 代码全部就绪**（15 个 `.kt`，1835 行）；
已完成 **4 轮代码审查、修掉 16 个问题**；
**Kotlin 层编译已通过（0 error / 216 class）**；
但 **尚未跑真实 Gradle 构建、未上真机、代码尚未 commit**。

---

## 1. 在另一台机器上怎么接着做

```bash
# 1) 先把代码拿到手 —— 本目录改动【尚未 commit】，见 §7
#    （要么 commit+push，要么直接拷 android/ 整个目录）

# 2) 真实构建 —— 这是目前唯一还没做过的验证层
cd android
./gradlew assembleDebug
#    产物：app/build/outputs/apk/debug/app-debug.apk

# 3) 装到真机
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

打开 App 后：右上角 ⚙ → 添加服务器（地址 + 可选凭据）→ 点「测试」→ 保存 → 回列表看到会话。

---

## 2. 验证到哪一步了（证据）

| 验证层 | 状态 | 证据 |
|---|---|---|
| 后端协议对齐（REST + WS 字段级） | ✅ 已做 | 逐字段核对 `backend/routes/chat.ts`、`backend/server.ts`、`backend/pi-manager.ts` 与 `apple/PiDash/.../APIModels.swift` |
| **Kotlin 编译** | ✅ 已做 | **0 error / 216 class**，15 个文件全过；仅 3 条精简 classpath 造成的假警（`compose-animation` 缺失，Gradle 里由 navigation-compose 传递进来） |
| 资源 / Manifest 引用 | ✅ 已做 | `@color/white`、`@string/app_name`、`@mipmap/ic_launcher(_round)`、`@style/Theme.PiDash` 全部可解析；`minSdk 26` 与 `mipmap-anydpi-v26` 恰好匹配 |
| **AGP / Gradle 真实构建** | ❌ **未做** | 无 R 类、无资源合并、无 manifest 合并、无 dex —— 这是最大的剩余不确定性 |
| **真机运行** | ❌ **未做** | 无触摸/网络/输入法的真实行为反馈 |

### 复现 Kotlin 编译（仅在 DSW 开发机上）

```bash
bash ~/kbuild/compile3.sh
# 输出：== files: 15 == / 0 error / warning 3 / out/ 下 216 个 .class
```

harness 位置：`~/kbuild/`（`setup.sh` 拉依赖、`compile3.sh` 编译、`libs/` 依赖 jar、`dl/kotlinc`）。
它用 kotlinc 2.0.21 + Compose 编译器插件 + kotlinx-serialization 插件，**不是** Android 构建。

> Mac 上**不需要**它：`./gradlew assembleDebug` 是比它更强的验证。

---

## 3. 交付物 / 文件地图

源码 `android/app/src/main/java/com/sam/pidash/`：

| 文件 | 行 | 职责 |
|---|---|---|
| `MainActivity.kt` | 22 | 单 Activity，`enableEdgeToEdge()` + `setContent` |
| `PiDashApp.kt` | 22 | Application，手写 DI 持有 `PiDashRepository` |
| `core/Time.kt` | 15 | ISO 解析 / slot key 取时间戳 / now |
| `domain/model/Models.kt` | 75 | `Backend` `ChatSlot` `ChatMessage` `MessageRole` `AggregatedSlot` `SessionKey` `ConnectionState` |
| `data/local/BackendStore.kt` | 33 | DataStore 持久化后端列表（JSON blob） |
| `data/remote/Dto.kt` | 131 | REST 模型 + 请求体 |
| `data/remote/WsFrames.kt` | 190 | WS 帧定义 + `parseWsFrame()` |
| `data/remote/DashboardClient.kt` | 251 | 单后端的 REST + 自愈 WebSocket（指数退避 1s→30s） |
| `data/repo/PiDashRepository.kt` | 304 | **全局唯一状态源**：聚合多后端、帧分发、消息/流式/running/error 状态 |
| `ui/nav/AppNav.kt` | 58 | Navigation Compose 三个目的地 |
| `ui/sessions/SessionsScreen.kt` | 232 | 会话聚合列表 + 新建会话对话框 |
| `ui/chat/ChatScreen.kt` | 228 | 消息流 + 输入 + 停止 + 流式气泡 |
| `ui/backends/BackendsScreen.kt` | 218 | 服务器增删 + 连通性测试 |
| `ui/common/Format.kt` | 25 | 相对时间 / 时钟 |
| `ui/theme/Theme.kt` | 31 | Material3 主题（支持 dynamic color） |

构建配置：`build.gradle.kts`、`app/build.gradle.kts`、`gradle/libs.versions.toml`、`gradle/wrapper/gradle-wrapper.properties`、`app/src/main/AndroidManifest.xml`、`app/proguard-rules.pro`

**已删除的旧实现**（原 WebView 壳，面向 Boox 墨水屏）：`PiBridge.kt`、`ServerConfig.kt`、`SettingsActivity.kt`、旧的 `res/layout/*`、`res/menu/*`、`res/drawable/ic_*_24.xml`。
可从 git 历史 **`b00f94b`** 回退。

---

## 4. 已修的 16 个问题（请勿改回去）

| 轮 | # | 问题 | 修复 |
|---|---|---|---|
| 1 | 1 | 用户自己的消息不显示 | 服务端**从不**回显 user 消息 → 客户端乐观追加（`local=true`） |
| 1 | 2 | 改了服务器地址/凭据不生效 | `syncClients()` 比较 `target == current.backend`，变了就重建 client |
| 1 | 3 | 流式输出不自动滚动 | `LaunchedEffect(itemCount, streaming.length)` 强制 `scrollToItem(last)` |
| 1 | 4 | `RequestBody.create` 编译/API 问题 | 改用 `"json".toMediaType()` + `toRequestBody()` 扩展 |
| 1 | 5 | 消息 `content` 缺失时崩 | DTO 全字段可空 + `orEmpty()` |
| 2 | 6 | `SlotDetail.thinkingLevel` 我写成了 `thinking_level` | 后端/iOS 均为**驼峰** → 改回 `thinkingLevel` |
| 2 | 7 | **键盘遮住输入框** | `bottomBar` 加 `.imePadding().navigationBarsPadding()` |
| 2 | 8 | 会话列表最后一条被 FAB 遮住 | `contentPadding = PaddingValues(bottom = 88.dp)` |
| 2 | 9 | `tool_result.result` 类型错（后端是 String） | `JsonElement?` → `String?` |
| 2 | 10 | 图标依赖靠传递、可能编译失败 | 显式声明 `material-icons-core` |
| 3 | 11 | **助手回复在回合结束时消失**（高） | 服务端只发 `chat_chunk` 增量、**不发**最终 assistant 消息 → 新增 `promoteStreaming()` 在 `chat_done`/`chat_error` 时把流式文本转成正式消息 |
| 3 | 12 | 中途进对话，同一段文字显示两遍 | `trimInFlightTurn()`：流式进行中只取到「最后一条 user 消息」为止；回合结束时 `loadMessages()` 权威对齐 |
| 3 | 13 | `BackendsScreen` FAB 遮住最后一行删除按钮 | 同样加 `contentPadding(bottom = 88.dp)` |
| 3 | 14 | 3 个废弃图标 | 换成 `Icons.AutoMirrored.Filled.ArrowBack / Send`（顺带支持 RTL） |
| 3 | 15 | 添加服务器对话框输入框没撑满宽度 | 加 `.fillMaxWidth()` |
| 4 | 16 | **断线重连后流式气泡永久卡屏** | 收到 `slots` 帧时，服务端报 `running=false` 而本地仍有流 → flush（`running=false` 只在权威 `agent_end` 置位，见 `pi-manager.ts:903`） |

---

## 5. 后端协议权威参考（改代码前先查这张表）

### REST

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/chat/slots` | 会话列表（数组） |
| GET | `/api/chat/slots/:key` | 会话详情（消息、running、has_more…） |
| POST | `/api/chat` | **发消息**，body `{slot, message}`，配 `?ws=1`（iOS 约定：fire-and-forget，回复走 WS）。**不等整轮**，立即返回 |
| POST | `/api/chat/slots` | 新建会话，body `{name, agent, model, cwd}`，**返回 slot 对象** |
| POST | `/api/chat/slots/:key/stop` | 停止 |
| PATCH | `/api/chat/slots/:key/title` | 改名 |
| GET | `/api/status` | 探活（返回 `version`） |

### WebSocket `/api/ws`

后端会广播 26 种帧；客户端**只解析这 12 种**（其余落 `WsFrame.Unknown` 忽略）：

| type | data 字段 | 客户端行为 |
|---|---|---|
| `slots` | 数组（SlotInfo） | 替换该后端列表 + 校正 running + flush 卡住的流 |
| `chat_chunk` | `{slot, content, seq}` | 追加到 `_streaming[slot]` |
| `chat_message` | `{slot, role, content, ts, meta}` | 追加消息；role 只有 `thinking`/`system`/`assistant`(仅 slash_result) |
| `chat_done` | `{slot}` | **promote 流式文本** + refreshSlots + `loadMessages` 权威对齐 |
| `chat_error` | `{slot, message}` | promote + 显示错误横幅 |
| `slot_title` | `{key, title}` | 更新标题 |
| `slot_tags` | `{key, tags}` | 更新标签 |
| `tool_call` | `{slot, tool, id, args}` | 暂不渲染 |
| `tool_result` | `{slot, tool, id, result, isError}` | 暂不渲染 |
| `tool_update` | `{slot, tool, id, partial}` | 暂不渲染 |
| `context_usage` | `{slot, ...}` | 暂不渲染 |
| `notification` | `{kind, title, body, ts, acked}` | 暂不渲染 |

**关键机制（务必理解，否则会把 bug 改回来）**：

1. **服务端从不广播用户自己的消息** —— 只会 push 进自己的 `pi.messages`。所以客户端必须乐观追加。
2. **服务端不发「最终 assistant 消息」** —— 只有 `chat_chunk` 增量。Web 前端在收到 `chat_done`（内部派发 `role:'_done'`）时把流式气泡 `role='streaming'` 提升为 `'assistant'`；Android 端的 `promoteStreaming()` 是同一行为的镜像。
3. **服务端会把「进行中回合」的半成品也存进 `pi.messages`**（`_partial: true`）并随 REST 返回；而 `agent_end` 时**不会**把最后一段的 `_partial` 清成 false。所以：流式进行中要裁剪掉它（否则重复），回合结束后**不能**按 `_partial` 过滤（否则回复消失）。
4. **`/api/ws` 不要求订阅**，chat 类帧是全局广播；仅 `log` 帧需要 `_subscribedLogs`。
5. 鉴权：REST 与 WS 都用 `Authorization` 头（`Bearer <token>`）；token 为空则不带头。

---

## 6. 设计取舍（DECISION）

| 决定 | 理由 |
|---|---|
| 乐观追加用户消息 + `local=true` 标记 | 服务端不回显 user；发送失败时按 `local` 标记回滚 |
| `chat_done` 时「先 promote 再 reload」 | promote 保证瞬时可见；reload 用服务端权威记录修正（恢复工具/thinking 条目、消除重复）。已核实 `slash_result` 是「先 push 再 emit」，重载安全 |
| 流式进行中裁剪到「最后一条 user 消息」 | 流式气泡已经渲染了整段，服务端那份是重复的 |
| 用 `slots` 帧的 `running=false` 作为「回合已结束」信号 | `pi.running=false` 只在权威 `agent_end`（`pi-manager.ts:903`）与进程死亡/reload/abort 置位，可靠 |
| 每个后端一个 `DashboardClient`（独立 WS/凭据/退避） | 多机聚合互不影响 |
| 手写 DI（`Application` 持有 repository），不引入 Hilt | 依赖图极小，省一层复杂度 |

---

## 7. ⚠️ 代码尚未提交（重要）

`git status android/` 当前状态：

- **修改**：`README.md`、`app/build.gradle.kts`、`app/proguard-rules.pro`、`app/src/main/AndroidManifest.xml`、`MainActivity.kt`、`res/values/strings.xml`、`build.gradle.kts`、`gradle/libs.versions.toml`、`gradle/wrapper/gradle-wrapper.properties`
- **删除**：`PiBridge.kt`、`ServerConfig.kt`、`SettingsActivity.kt`、`res/layout/*`、`res/menu/*`、`res/drawable/ic_arrow_back_24.xml`、`res/drawable/ic_refresh_24.xml`
- **新增（untracked）**：`PiDashApp.kt`、`core/`、`data/`、`domain/`、`ui/`、**本文件**

换机器前**必须**提交，否则会丢：

```bash
cd <pi-dashboard repo>
git add android/
git commit -m "feat(android): 重写为原生 Compose 多后端客户端"
```

---

## 8. 未完成 / 已知缺口

| 项 | 状态 |
|---|---|
| A6 通知（`notification` 帧已解析但未渲染） | ⬜ 未做 |
| 文件 / 终端 / 任务 / 用量 页面 | ⬜ 未做 |
| 模型切换、图片附件、标签编辑 | ⬜ 未做 |
| `tool_call` / `tool_result` / `tool_update` 渲染（已解析、`-> Unit` 丢弃） | ⬜ 未做 |
| `slot_pinned`、`startup_error`、`token_stats`、`heartbeat`、`dashboard`、`jobs`、`extension_*` 帧 | ⬜ 有意忽略 |
| 会话列表按「置顶」分组 | ⬜ 未做（当前统一按 `updatedAt` 倒序） |
| 新建会话失败时的用户提示 | ⬜ 静默失败（对话框直接关闭） |

---

## 9. 环境与版本（已锁定，勿随意升级）

| 组件 | 版本 |
|---|---|
| Gradle | 8.9（`gradle-wrapper.properties`） |
| AGP | 8.7.3 |
| Kotlin | 2.0.21 |
| Compose BOM | 2024.10.01 |
| compileSdk / targetSdk / minSdk | 35 / 35 / 26 |
| JDK | 17 |
| OkHttp | 4.12.0 |
| kotlinx-serialization | 1.7.3 |
| navigation-compose | 2.8.3 |
| DataStore | 1.1.1 |
| material（`com.google.android.material`） | 1.12.0 |

> ⚠️ 旧工程曾是 Gradle 9.5.0 wrapper + AGP 8.5.2（互不兼容，构建不了），已统一到上表。
> 若 Android Studio 提示升级 AGP/Gradle，可接受其建议，但请同步更新本节与本表。

### 其他已确认易踩的点

- `AndroidManifest.xml` 已声明 `manifest` 的 **`configChanges="orientation|screenSize|keyboardHidden|uiMode"`** → 旋转不重建 Activity，`remember` 状态不会丢。
- **`windowSoftInputMode="adjustResize"`** 与 Compose 的 `imePadding()` 是配套的，缺一键盘就会遮住输入框。
- `usesCleartextTraffic="true"` → 允许连 `http://` 的自建服务器。
- `minSdk 26` 恰好让 `mipmap-anydpi-v26` 成为唯一图标来源，这是**有意**的；若降低 minSdk 必须补普通 `mipmap-*` 图标。
- 使用 `ComponentActivity`（非 `AppCompatActivity`）配 `Theme.MaterialComponents.*`，**不会**触发 AppCompat 主题检查异常。
