# Android 客户端方案（纯原生 Compose + 多机）— v2

> 状态：**设计已实现**（代码见 [`../android/`](../android/)）。
> 实现进度 / 验证证据 / 已修问题清单 / 交接 → **[`../android/HANDOFF.md`](../android/HANDOFF.md)**。
> 交付方式：代码在本仓库产出，**构建与真机验证在你的 Mac 上完成**（DSW 本机无 Android 工具链）；
> 已在本机用 kotlinc 做过纯 Kotlin 编译验证（**0 error / 216 class**）。

---

## 0. 已定决策

| 项 | 决策 |
|---|---|
| UI 技术 | **Kotlin + Jetpack Compose**（纯原生，非 WebView 壳） |
| 机器数 | **多台**，一个界面汇总 |
| 网络位置 | 手机不常开 tailscale → 经**公网服务器**（见 `docs/remote-access-deployment.md`） |
| 现有 `android/` | 原为 **WebView 壳**（sam 所做），本方案**取代**它（git 历史保留，可回退） |

### 0.1 ⚠️ 现有工程的两个坑（均已在实现中解决）

1. **版本不兼容**：`gradle-wrapper.properties` 是 **Gradle 9.5.0**，而 `libs.versions.toml` 的 AGP 是 **8.5.2** → 不兼容，现在多半构建不了。本方案统一版本（§3）。
   ✅ **已解决**：统一为 Gradle 8.9 + AGP 8.7.3 + Kotlin 2.0.21（见 `android/HANDOFF.md` §9）。
2. **认证被移除**：`b00f94b chore: remove token auth` 前提是「Tailscale 保护」。改为公网入口后**必须靠边缘认证**（见 §5）。
   ✅ **已解决**：`Authorization` 头对 REST 与 WebSocket 都生效，凭据在 App 内配置（可留空）。

---

## 1. 架构

```
        ┌──────────────── App (Compose) ────────────────┐
        │  UI: 多机聚合首页 / 会话页 / 设置              │
        ├───────────────────────────────────────────────┤
        │  Domain: SessionKey(machineId, slotKey), …     │
        ├───────────────────────────────────────────────┤
        │  Data: AggregatedRepository（合并 + 标签）      │
        │        ├─ DashboardClient(m1) ── REST + WS     │
        │        └─ DashboardClient(m2) ── REST + WS     │
        └───────────────────────────────────────────────┘
                     │ 每个后端独立：cookie/凭据 + WS + 重连
                     ▼
        https://m1.域名 ──> nginx(TLS+认证) ──> dashboard:7777
        https://m2.域名 ──> nginx(TLS+认证) ──> dashboard:7777
```

**要点**
- 每台机器 = 一个 `DashboardClient` 实例（独立认证、WS、重连），互不影响
- 聚合层给每条会话打 `machineId/machineName`，统一排序
- 输入按 `SessionKey = (machineId, slotKey)` 路由到对应后端
- 一台掉线只影响它自己（该分组显示「离线」）

---

## 2. 协议（与 iOS App 对齐，功能最全）

复用 dashboard 现有 REST + `/api/ws`（**与 iOS App 同一套**，因此功能可对齐）：

| 用途 | 端点 |
|---|---|
| WS 实时流 | `WS /api/ws`（服务端推送 slots / chat_chunk / chat_message / chat_done / tool_call / tool_result / dashboard / notification …） |
| 会话列表 | `GET /api/chat/slots` |
| 会话详情 | `GET /api/chat/slots/:key` |
| 发消息 | `POST /api/chat/slots/:key/...`（输入 / 停止 / 标题 / 标签） |
| 系统状态 | `GET /api/status`、`/api/system`、`/api/usage` |

> **为什么不走 live-sessions**：它是给外部通道（Lark）用的精简面；原生 App 要「照 iOS 全功能」，
> 用 iOS 同一套 API 最省事，且 iOS 的 Swift 实现可直接对照移植。

**去重**：WS 重连后按事件序号/时间戳去重。

---

## 3. 依赖版本（统一、互相兼容）

| 组件 | 版本 | 说明 |
|---|---|---|
| Gradle (wrapper) | **8.9** | 与 AGP 8.7.x 匹配（替换原 9.5.0） |
| AGP | **8.7.3** | |
| Kotlin | **2.0.21** | |
| Compose Compiler | `org.jetbrains.kotlin.plugin.compose` 2.0.21 | Kotlin 2.0 起编译器随 Kotlin |
| Compose BOM | 2024.10.01 | |
| compileSdk / targetSdk / minSdk | 35 / 35 / 26 | |
| JDK | 17 | AGP 8.x 要求 |
| 网络 | OkHttp 4.12.0 | REST + **WebSocket** + 认证拦截器 |
| 序列化 | kotlinx.serialization-json 1.7.3 | |
| 并发 | kotlinx-coroutines-android 1.9.0 | |
| 导航 | navigation-compose 2.8.3 | |
| 持久化 | DataStore Preferences 1.1.1 | 后端列表与凭据 |
| 图片 | Coil 2.7.0 | 预览/附件（后续） |

> 若 Android Studio 提示升级 AGP/Gradle，可接受其建议；报错发我。

---

## 4. 模块结构

```
android/app/src/main/java/com/sam/pidash/
├── MainActivity.kt                  # 单 Activity + Compose
├── PiDashApp.kt                     # Application（容器）
├── core/
│   ├── Result.kt                    # 统一结果/错误
│   └── Time.kt
├── data/
│   ├── local/BackendStore.kt        # DataStore：后端列表 + 凭据
│   ├── remote/
│   │   ├── DashboardClient.kt       # 单后端：REST + WS + 认证 + 重连
│   │   ├── Dto.kt                   # @Serializable（ignoreUnknownKeys）
│   │   └── WsFrames.kt              # /api/ws 帧解析
│   └── repo/
│       ├── BackendRepository.kt     # 单后端状态（slots/transcript）
│       └── AggregatedRepository.kt  # 多后端合并（带 machineId）
├── domain/model/                    # Backend, Slot, SessionKey, ChatItem
└── ui/
    ├── theme/                       # Material3 主题
    ├── nav/AppNav.kt                # navigation-compose 路由
    ├── backends/                    # 后端管理（增删改 + 连通性测试）
    ├── sessions/                    # 聚合会话列表（按机器分组/标签）
    └── chat/                        # 会话页（消息流 + 输入 + 停止）
```

**核心类型（草案）**

```kotlin
data class Backend(val id: String, val name: String, val baseUrl: String)

data class SessionKey(val backendId: String, val slotKey: String)

data class AggregatedSession(
    val key: SessionKey,
    val title: String,
    val status: String,
    val cwd: String,
    val lastActivityAt: Long,
    val backendName: String,
)

interface DashboardClient {
    suspend fun connect()                       // 握手 + WS
    suspend fun listSlots(): List<SlotDto>
    suspend fun sendInput(slotKey: String, text: String)
    suspend fun stop(slotKey: String)
    val frames: Flow<WsFrame>                   // 含重连状态
    fun close()
}
```

---

## 5. 认证

App 只需**一个**凭据：**边缘（nginx）凭据**。

- OkHttp `Interceptor` 给**所有请求**（含 WS 升级）加 `Authorization`
- 好处：dashboard 本身缺认证**不影响**——nginx 已把关；App 无需第二套 token
- 见 `docs/remote-access-deployment.md` §4/§10

---

## 6. 里程碑（每步在 Mac 构建验证）

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **A1** | 工程骨架（Compose + 主题 + 导航壳） | **能装能跑**，显示空白首页 |
| **A2** | 后端管理（增删改 + 测试连通：`GET /api/status`） | 能配一台机器并显示在线 |
| **A3** | 会话列表（单机）：`GET /api/chat/slots` + WS 更新 | 看到会话列表并实时刷新 |
| **A4** | 会话页：消息流 + 输入 + 停止 | 手机上能对话，流式显示 |
| **A5** | 多后端聚合 + 机器标签/分组 | 两台机器会话同屏、可分别对话 |
| **A6** | 重连/去重/错误态/打磨；通知（FCM） | 弱网自恢复、后台通知 |

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| **本机无 Android 工具链，我无法编译** | 先交付 A1 极小骨架验证工具链；后续每步在 Mac 构建，报错发我 |
| 版本不匹配（原工程已坏） | §3 统一版本；必要时由 Android Studio 升级助手调整 |
| 多后端状态合并 | 聚合层单一真相源；`machineId` 进 `SessionKey` |
| WS 重连 | 指数退避 + 认证失败重试 |
| 后端协议演进 | DTO `ignoreUnknownKeys = true` |

---

## 8. 待确认

1. **包名**：沿用 `com.sam.pidash`，还是改 `com.tsiendragon.pidash`？
2. **首页形态**：所有机器混在一个列表（带标签），还是按机器分组？
3. **首版范围**：先只做「会话列表 + 对话」，其余页面（文件/终端/任务）后续？
