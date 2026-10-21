package com.sam.pidash.domain.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/** Live Pi uses processInstanceId/sessionId, never a synthetic chat slot key. */
@Serializable
data class LiveSummary(
    val processInstanceId: String,
    val sessionId: String,
    val sessionName: String? = null,
    val cwd: String,
    val canonicalCwd: String? = null,
    val pid: Int = 0,
    val mode: String = "tui",
    val role: String = "main",
    val parentSessionId: String? = null,
    val sessionFile: String? = null,
    val model: LiveModel? = null,
    val thinkingLevel: String? = null,
    val status: String = "idle",
    val claim: LiveClaim = LiveClaim(),
    val startedAt: Long = 0,
    val lastActivityAt: Long = 0,
    val revision: Long = 0,
    val eventSequence: Long = 0,
    val capabilities: List<String> = emptyList(),
    val contextUsage: LiveContextUsage? = null,
) {
    val title: String get() = sessionName?.takeIf { it.isNotBlank() } ?: "Pi $pid"
}

@Serializable
data class LiveModel(val provider: String, val id: String)
@Serializable
data class LiveClaim(val state: String = "unclaimed", val leaseId: String? = null, val expiresAt: Long? = null)
@Serializable
data class LiveContextUsage(val tokens: Long? = null, val contextWindow: Long = 0, val percent: Double? = null)
@Serializable
data class LiveUiRequest(
    val id: String,
    val method: String,
    val title: String = "",
    val message: String? = null,
    val options: List<String> = emptyList(),
    val placeholder: String? = null,
    val prefill: String? = null,
)
@Serializable
data class LiveDetail(
    val summary: LiveSummary,
    val entries: List<JsonElement> = emptyList(),
    val pendingUi: List<LiveUiRequest> = emptyList(),
    val goal: JsonElement? = null,
)
@Serializable
data class LiveMeta(val tags: List<String> = emptyList(), val pinned: Boolean = false, val tmux: String? = null)
@Serializable
data class LiveRepoCandidate(val name: String, val path: String, val git: Boolean = false)
@Serializable
data class LiveStartOptions(val roots: List<String> = emptyList())
@Serializable
data class LiveModelOption(
    val provider: String,
    val id: String,
    val name: String = "",
    val reasoning: Boolean = false,
    val contextWindow: Long = 0,
    val thinkingLevels: List<String> = emptyList(),
)
@Serializable
data class LiveGroup(val id: String, val name: String, val sessionIds: List<String> = emptyList())
@Serializable
data class LiveOrder(val order: List<String> = emptyList(), val sectionOrder: List<String> = emptyList())
data class LiveOrganization(
    val groups: List<LiveGroup> = emptyList(),
    val order: LiveOrder = LiveOrder(),
    val loaded: Boolean = false,
    val error: String? = null,
)

@Serializable
data class LiveLease(val leaseId: String, val expiresAt: Long? = null)

data class AggregatedLiveSession(
    val key: SessionKey,
    val backendName: String,
    val summary: LiveSummary,
    val meta: LiveMeta = LiveMeta(),
)
data class LiveBackendState(
    val connected: Boolean = false,
    val needsPairing: Boolean = false,
    val message: String? = null,
)
@Serializable
data class LiveImage(val mimeType: String, val data: String)

data class LiveTimelineItem(
    val id: String,
    val role: String,
    val text: String,
    val timestamp: Long = 0,
    val thinking: String? = null,
    val toolName: String? = null,
    val isError: Boolean = false,
    val entryId: String? = null,
    val forkable: Boolean = false,
    val channel: String? = null,
    val status: String = "done",
    val intermediate: Boolean = false,
    val images: List<LiveImage> = emptyList(),
)

data class LiveActivity(val id: String, val title: String, val state: String, val items: List<LiveTimelineItem>)
@Serializable
data class LiveGoalProgress(val current: String? = null, val lastSummary: String? = null)
@Serializable
data class LiveGoalItem(val id: String, val title: String, val state: String? = null)
@Serializable
data class LiveGoalBlocker(val title: String, val reason: String? = null)
@Serializable
data class LiveGoalAnchor(
    val objective: String,
    val status: String? = null,
    val progress: LiveGoalProgress = LiveGoalProgress(),
    val workItems: List<LiveGoalItem> = emptyList(),
    val blockers: List<LiveGoalBlocker> = emptyList(),
    val messagesSinceUpdate: Int = 0,
)
