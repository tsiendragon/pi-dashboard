package com.sam.pidash.data.remote

import com.sam.pidash.domain.model.LiveDetail
import com.sam.pidash.domain.model.LiveBackgroundSnapshot
import com.sam.pidash.domain.model.LiveBackgroundTask
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull

/**
 * Extension feature snapshots arrive as `live_feature_snapshot` events whose
 * `data` is `{feature, snapshot}` (see `pi-tsien-live-session`).
 *
 * Projected here: the background-command panel (a foreground bash call can be
 * handed to the background), armed schedules, and read-only PiMatrix proof jobs.
 * Nothing here issues commands — that stays in the repository under an explicit lease.
 */
private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

private fun featureSnapshot(detail: LiveDetail?, feature: String): JsonObject? {
    return detail?.entries?.asReversed()?.firstNotNullOfOrNull { raw ->
        val entry = raw as? JsonObject ?: return@firstNotNullOfOrNull null
        if (entry.str("type") != "live_feature_snapshot") return@firstNotNullOfOrNull null
        val data = entry["data"] as? JsonObject ?: return@firstNotNullOfOrNull null
        data.takeIf { it.str("feature") == feature }?.get("snapshot") as? JsonObject
    }
}

fun backgroundSnapshot(detail: LiveDetail?): LiveBackgroundSnapshot? =
    featureSnapshot(detail, "background-commands")?.let(::decodeBackgroundSnapshot)

internal data class LiveScheduleSummary(val count: Int, val nextRunAt: Long)

/** The extension includes only armed schedules; cancellation or a one-shot firing removes it. */
internal fun scheduleSummary(detail: LiveDetail?): LiveScheduleSummary? {
    val tasks = featureSnapshot(detail, "schedule")?.get("tasks") as? JsonArray ?: return null
    val dueTimes = tasks.mapNotNull { raw ->
        val task = raw as? JsonObject ?: return@mapNotNull null
        if (task.str("id").isNullOrBlank()) return@mapNotNull null
        (task["nextRunAt"] as? JsonPrimitive)?.longOrNull?.takeIf { it > 0 }
    }
    val next = dueTimes.minOrNull() ?: return null
    return LiveScheduleSummary(dueTimes.size, next)
}

/**
 * One PiMatrix proof job from the read-only `proof-jobs` feature:
 * `{tasks:[{id,label,state,createdAt?,startedAt?,finishedAt?,collected?}]}`, epoch ms.
 * Unknown states are kept as `unknown` so a newer producer never hides a job.
 */
internal data class LiveProofJob(
    val id: String,
    val label: String,
    val state: String,
    val createdAt: Long? = null,
    val startedAt: Long? = null,
    val finishedAt: Long? = null,
    val collected: Boolean? = null,
) {
    val isActive: Boolean get() = state == "running" || state == "queued"
}

internal data class LiveProofJobs(val jobs: List<LiveProofJob>) {
    val running: Int get() = jobs.count { it.state == "running" }
    val queued: Int get() = jobs.count { it.state == "queued" }
    val active: Int get() = running + queued
}

private val PROOF_JOB_STATES = setOf("queued", "running", "finished", "failed", "cancelled")
private val PROOF_JOB_ORDER = mapOf("running" to 0, "queued" to 1)

/** null until the session publishes the feature (every non-PiMatrix session). */
internal fun proofJobs(detail: LiveDetail?): LiveProofJobs? =
    featureSnapshot(detail, "proof-jobs")?.let(::decodeProofJobs)

internal fun decodeProofJobs(snapshot: JsonObject): LiveProofJobs? {
    val tasks = snapshot["tasks"] as? JsonArray ?: return null
    val seen = HashSet<String>()
    val jobs = tasks.mapNotNull { raw ->
        val task = raw as? JsonObject ?: return@mapNotNull null
        val id = task.str("id")?.trim()?.takeIf { it.isNotEmpty() && seen.add(it) } ?: return@mapNotNull null
        fun time(key: String) = (task[key] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.takeIf { it > 0 }
        LiveProofJob(
            id = id,
            label = task.str("label")?.trim()?.takeIf { it.isNotEmpty() } ?: id,
            state = task.str("state")?.takeIf { it in PROOF_JOB_STATES } ?: "unknown",
            createdAt = time("createdAt"),
            startedAt = time("startedAt"),
            finishedAt = time("finishedAt"),
            collected = (task["collected"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull,
        )
    }
    val recency = { job: LiveProofJob -> job.finishedAt ?: job.startedAt ?: job.createdAt ?: 0L }
    return LiveProofJobs(jobs.sortedWith(compareBy<LiveProofJob> { PROOF_JOB_ORDER[it.state] ?: 2 }.thenByDescending(recency)))
}

/** Kept next to the projection so the parsing contract is testable alone. */
internal fun decodeBackgroundSnapshot(element: JsonElement): LiveBackgroundSnapshot? = runCatching {
    pidashJson.decodeFromJsonElement(LiveBackgroundSnapshot.serializer(), element.jsonObject)
}.getOrNull()

internal fun LiveBackgroundTask.isActive(): Boolean = status == "running" || status == "starting"

internal fun LiveBackgroundSnapshot.activeBackgroundTasks(): List<LiveBackgroundTask> =
    tasks.filter { it.mode != "foreground" && it.isActive() }

/** A foreground call is the only one the dashboard may hand to the background. */
internal fun LiveBackgroundTask.canMoveToBackground(): Boolean =
    mode == "foreground" && isActive() && !toolCallId.isNullOrBlank()

internal fun LiveBackgroundTask.elapsedSeconds(now: Long): Long {
    val end = endedAt ?: now
    return ((end - startedAt) / 1000).coerceAtLeast(0)
}

/* ── Subagent Workbench ─────────────────────────────────────────────────────── */

/** Status vocabulary shared by `conversations.items` and `workflows.items`. */
private val LIVE_WORK_ACTIVE_STATUSES = setOf(
    "running", "queued", "in_progress", "active", "starting", "pending", "busy",
)
private val LIVE_WORK_ATTENTION_STATUSES = setOf(
    "failed", "failure", "error", "blocked", "stalled", "waiting_approval",
    "needs_approval", "disconnected", "lost",
)
private val LIVE_WORK_COMPLETED_STATUSES = setOf("completed", "succeeded", "success", "done", "finished", "skipped")
private val LIVE_WORKFLOW_ACTIVE_STATUSES = setOf("running", "queued", "in_progress", "active", "starting", "busy")

internal data class LiveSubagentRecord(
    val id: String,
    val label: String,
    val status: String,
    val needsAttention: Boolean = false,
    val stalled: Boolean = false,
    val workflowId: String? = null,
) {
    val isActive: Boolean get() = status in LIVE_WORK_ACTIVE_STATUSES
    val hasAttention: Boolean get() = needsAttention || stalled || status in LIVE_WORK_ATTENTION_STATUSES
}

internal data class LiveWorkflowRecord(
    val id: String,
    val label: String,
    val status: String,
    val currentStage: Int? = null,
    val stageCount: Int = 0,
    val taskTotal: Int = 0,
    val taskDone: Int = 0,
    val taskFailed: Int = 0,
) {
    val isActive: Boolean get() = status in LIVE_WORKFLOW_ACTIVE_STATUSES
    val hasFailed: Boolean get() = status in LIVE_WORK_ATTENTION_STATUSES
    val isPaused: Boolean get() = status == "paused"

    val progressLabel: String?
        get() {
            val parts = buildList {
                if (stageCount > 0) {
                    val current = currentStage?.let { (it + 1).coerceIn(1, stageCount) }
                    add(if (current != null) "阶段 $current/$stageCount" else "共 $stageCount 阶段")
                }
                if (taskTotal > 0) add("任务 $taskDone/$taskTotal 完成")
                if (taskFailed > 0) add("$taskFailed 失败")
            }
            return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ")
        }
}

/**
 * Read-only snapshot of the Workbench's top-level subagents and workflows.
 * Workflow child conversations stay out of the subagent counts to avoid showing
 * one workflow task twice; the workflow's stage/task progress covers them.
 */
internal data class LiveWorkStatusPart(val text: String, val attention: Boolean = false)

internal data class LiveSubagentWorkflow(
    val agents: List<LiveSubagentRecord> = emptyList(),
    val workflows: List<LiveWorkflowRecord> = emptyList(),
    val agentsTotal: Int = 0,
    val agentsRunning: Int = 0,
    val agentsAttention: Int = 0,
    val workflowsTotal: Int = 0,
    val workflowsActive: Int = 0,
    val workflowsFailed: Int = 0,
    val workflowsPaused: Int = 0,
) {
    val isExecuting: Boolean get() = agentsRunning > 0 || workflowsActive > 0
    val hasAttention: Boolean get() = agentsAttention > 0 || workflowsFailed > 0 || workflowsPaused > 0
    val isWorking: Boolean get() = isExecuting || hasAttention

    /** Only active/attention work belongs in the status bar. */
    val summaryParts: List<LiveWorkStatusPart>
        get() = buildList {
            if (agentsRunning > 0) add(LiveWorkStatusPart("$agentsRunning 个子 Agent 运行中"))
            if (agentsAttention > 0) add(LiveWorkStatusPart("$agentsAttention 个子 Agent 待处理", attention = true))
            if (workflowsActive > 0) add(LiveWorkStatusPart("$workflowsActive 个工作流进行中"))
            if (workflowsFailed > 0) add(LiveWorkStatusPart("$workflowsFailed 个工作流失败", attention = true))
            if (workflowsPaused > 0) add(LiveWorkStatusPart("$workflowsPaused 个工作流已暂停", attention = true))
        }

    val summaryLabel: String? get() = summaryParts.takeIf { it.isNotEmpty() }?.joinToString(" · ") { it.text }
}

internal fun liveWorkStatusLabel(status: String): String = when (status) {
    "running" -> "运行中"
    "queued" -> "排队中"
    "blocked" -> "需处理"
    "failed", "error" -> "失败"
    "paused" -> "已暂停"
    "completed" -> "已完成"
    "idle" -> "空闲"
    "interrupted" -> "已中断"
    "cancelled", "canceled" -> "已取消"
    else -> "未知"
}

private fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull

private fun JsonObject.bool(key: String): Boolean =
    (this[key] as? JsonPrimitive)?.booleanOrNull == true

private fun liveWorkStatus(value: JsonObject): String {
    if (!value.str("activeRunId").isNullOrBlank()) return "running"
    if (value.bool("needsAttention") || value.bool("stalled")) return "blocked"
    return (value.str("latestRunStatus") ?: value.str("status"))
        ?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: "unknown"
}

private fun decodeSubagentRecord(value: JsonObject): LiveSubagentRecord? {
    val id = value.str("id")?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val label = value.str("label")?.trim()?.takeIf { it.isNotEmpty() } ?: id
    return LiveSubagentRecord(
        id = id,
        label = label,
        status = liveWorkStatus(value),
        needsAttention = value.bool("needsAttention"),
        stalled = value.bool("stalled"),
        workflowId = value.str("workflowId")?.trim()?.takeIf { it.isNotEmpty() },
    )
}

private fun decodeWorkflowRecord(value: JsonObject): LiveWorkflowRecord? {
    val id = value.str("id")?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val label = value.str("label")?.trim()?.takeIf { it.isNotEmpty() } ?: id
    val stages = value["stages"] as? JsonArray
    val tasks = stages.orEmpty().mapNotNull { it as? JsonObject }
        .flatMap { stage -> (stage["tasks"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject } }
    return LiveWorkflowRecord(
        id = id,
        label = label,
        status = value.str("status")?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: "unknown",
        currentStage = value.int("currentStage"),
        stageCount = stages?.size ?: 0,
        taskTotal = tasks.size,
        taskDone = tasks.count { liveWorkStatus(it) in LIVE_WORK_COMPLETED_STATUSES },
        taskFailed = tasks.count { liveWorkStatus(it) in LIVE_WORK_ATTENTION_STATUSES },
    )
}

internal fun decodeSubagentWorkflow(snapshot: JsonObject): LiveSubagentWorkflow? {
    val conversations = snapshot["conversations"] as? JsonObject
    val workflows = snapshot["workflows"] as? JsonObject
    if (conversations == null && workflows == null) return null
    val conversationItems = conversations?.get("items") as? JsonArray
    val workflowItems = workflows?.get("items") as? JsonArray
    val allAgents = conversationItems.orEmpty().mapNotNull { (it as? JsonObject)?.let(::decodeSubagentRecord) }
    val agents = allAgents.filter { it.workflowId == null }
    val workflowRecords = workflowItems.orEmpty().mapNotNull { (it as? JsonObject)?.let(::decodeWorkflowRecord) }
    val hasConversationItems = conversationItems != null
    val hasWorkflowItems = workflowItems != null
    return LiveSubagentWorkflow(
        agents = agents,
        workflows = workflowRecords,
        agentsTotal = if (hasConversationItems) agents.size else conversations?.int("total") ?: 0,
        agentsRunning = if (hasConversationItems) agents.count { it.isActive }
            else conversations?.int("running") ?: 0,
        agentsAttention = if (hasConversationItems) agents.count { it.hasAttention }
            else conversations?.int("needsAttention") ?: 0,
        workflowsTotal = if (hasWorkflowItems) workflowRecords.size else workflows?.int("total") ?: 0,
        workflowsActive = if (hasWorkflowItems) workflowRecords.count { it.isActive }
            else workflows?.int("active") ?: 0,
        workflowsFailed = if (hasWorkflowItems) workflowRecords.count { it.hasFailed }
            else workflows?.int("failed") ?: 0,
        workflowsPaused = if (hasWorkflowItems) workflowRecords.count { it.isPaused } else 0,
    )
}

internal fun subagentWorkflow(detail: LiveDetail?): LiveSubagentWorkflow? =
    featureSnapshot(detail, "subagent-workflow")?.let(::decodeSubagentWorkflow)
