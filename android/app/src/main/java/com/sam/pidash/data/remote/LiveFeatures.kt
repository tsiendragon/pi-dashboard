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
import java.time.Instant

/**
 * Extension feature snapshots arrive as `live_feature_snapshot` events whose
 * `data` is `{feature, snapshot}` (see `pi-tsien-live-session`).
 *
 * Projected here: the background-command panel (a foreground bash call can be
 * handed to the background), armed schedules, subagent/workflow activity, and PiMatrix proof jobs.
 * Nothing here issues commands — that stays in the repository under an explicit lease.
 */
private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

internal fun featureSnapshotEntry(detail: LiveDetail?, feature: String): JsonObject? {
    return detail?.entries?.asReversed()?.firstNotNullOfOrNull { raw ->
        val entry = raw as? JsonObject ?: return@firstNotNullOfOrNull null
        if (entry.str("type") != "live_feature_snapshot") return@firstNotNullOfOrNull null
        val data = entry["data"] as? JsonObject ?: return@firstNotNullOfOrNull null
        data.takeIf { it.str("feature") == feature }
    }
}

internal fun featureSnapshot(detail: LiveDetail?, feature: String): JsonObject? {
    // A clear event may omit the snapshot; never revive an older one.
    return featureSnapshotEntry(detail, feature)?.get("snapshot") as? JsonObject
}

fun backgroundSnapshot(detail: LiveDetail?): LiveBackgroundSnapshot? {
    val entry = featureSnapshotEntry(detail, "background-commands")
    if (entry != null) {
        // The latest event is authoritative, including an explicit clear.
        val snapshot = entry["snapshot"] as? JsonObject ?: return null
        return decodeBackgroundSnapshot(snapshot)
    }
    // Older sessions (or a session started before a reload) may have no feature
    // snapshot even though the transcript already contains its tool results.
    return fallbackBackgroundSnapshot(detail)
}

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

private fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject

private fun liveEntryMessage(raw: JsonElement): JsonObject? {
    val entry = raw as? JsonObject ?: return null
    return when (entry.str("type")) {
        "message" -> entry.obj("message")
        "message_end" -> entry.obj("data")?.obj("message")
        else -> null
    }
}

private fun messageText(message: JsonObject): String {
    val content = message["content"] as? JsonArray ?: return ""
    return content.mapNotNull { raw ->
        val part = raw as? JsonObject ?: return@mapNotNull null
        if (part.str("type") == "text") part.str("text") else null
    }.joinToString("\n")
}

private fun toolArguments(value: JsonElement?): JsonObject? = when (value) {
    is JsonObject -> value
    is JsonPrimitive -> runCatching {
        pidashJson.parseToJsonElement(value.content) as? JsonObject
    }.getOrNull()
    else -> null
}

private fun toolCallLabels(entries: List<JsonElement>): Map<String, String> {
    val labels = mutableMapOf<String, String>()
    entries.forEach { raw ->
        val message = liveEntryMessage(raw) ?: return@forEach
        if (message.str("role") != "assistant") return@forEach
        val content = message["content"] as? JsonArray ?: return@forEach
        content.forEach { rawPart ->
            val part = rawPart as? JsonObject ?: return@forEach
            if (part.str("type") != "toolCall") return@forEach
            val id = part.str("id") ?: return@forEach
            val arguments = toolArguments(part["arguments"]) ?: return@forEach
            val label = arguments.str("label")?.trim()?.takeIf { it.isNotEmpty() }
                ?: arguments.str("name")?.trim()?.takeIf { it.isNotEmpty() }
                ?: arguments.str("task")?.trim()?.takeIf { it.isNotEmpty() }?.take(80)
            if (label != null) labels[id] = label
        }
    }
    return labels
}

private fun workLabelsInText(text: String): Map<String, String> {
    val labels = mutableMapOf<String, String>()
    text.lineSequence().forEach { line ->
        val parts = line.trim().split(" · ")
        if (parts.size < 4 || !parts[0].startsWith("work_")) return@forEach
        val label = parts.drop(3).joinToString(" · ").trim()
        if (label.isNotEmpty()) labels[parts[0]] = label
    }
    return labels
}

private fun entryTime(raw: JsonElement): Long? {
    val entry = raw as? JsonObject ?: return null
    fun read(value: JsonElement?): Long? {
        val primitive = value as? JsonPrimitive ?: return null
        return primitive.longOrNull ?: runCatching { Instant.parse(primitive.content).toEpochMilli() }.getOrNull()
    }
    return read(entry["timestamp"])
        ?: read(entry.obj("data")?.get("timestamp"))
        ?: read(liveEntryMessage(raw)?.get("timestamp"))
}

/** Rebuild the background panel from tool results when the extension did not publish it. */
private fun fallbackBackgroundSnapshot(detail: LiveDetail?): LiveBackgroundSnapshot? {
    val tasks = linkedMapOf<String, LiveBackgroundTask>()
    detail?.entries?.forEach { raw ->
        val message = liveEntryMessage(raw)
        val custom = raw as? JsonObject
        if (message == null) {
            if (custom?.str("type") == "custom_message" &&
                custom.str("customType") == "background-command-completion") {
                val values = custom["details"] as? JsonObject ?: return@forEach
                val id = values.str("taskId")?.trim()?.takeIf { it.isNotEmpty() } ?: return@forEach
                val previous = tasks[id]
                tasks[id] = LiveBackgroundTask(
                    taskId = id,
                    title = values.str("title") ?: previous?.title.orEmpty(),
                    status = values.str("state")?.trim()?.takeIf { it.isNotEmpty() } ?: previous?.status ?: "exited",
                    command = previous?.command.orEmpty(),
                    cwd = previous?.cwd.orEmpty(),
                    mode = previous?.mode ?: "background",
                    startedAt = previous?.startedAt ?: 0,
                    endedAt = previous?.endedAt ?: entryTime(raw),
                    exitCode = (values["exitCode"] as? JsonPrimitive)?.intOrNull ?: previous?.exitCode,
                    exitReason = values.str("exitReason") ?: previous?.exitReason,
                    outputBytes = previous?.outputBytes ?: 0,
                )
            }
            return@forEach
        }
        if (message.str("role") != "toolResult") return@forEach
        val toolName = message.str("toolName") ?: return@forEach
        if (!toolName.startsWith("background_command_")) return@forEach
        val values = message["details"] as? JsonObject ?: return@forEach
        val id = values.str("taskId")?.trim()?.takeIf { it.isNotEmpty() } ?: return@forEach
        val previous = tasks[id]
        val status = values.str("status")?.trim()?.takeIf { it.isNotEmpty() } ?: previous?.status ?: "unknown"
        tasks[id] = LiveBackgroundTask(
            taskId = id,
            title = values.str("title") ?: previous?.title.orEmpty(),
            status = status,
            command = values.str("command") ?: previous?.command.orEmpty(),
            cwd = values.str("cwd") ?: previous?.cwd.orEmpty(),
            mode = values.str("mode") ?: previous?.mode ?: "background",
            toolCallId = previous?.toolCallId,
            pid = (values["pid"] as? JsonPrimitive)?.intOrNull ?: previous?.pid,
            startedAt = previous?.startedAt?.takeIf { it > 0 } ?: entryTime(raw) ?: 0,
            endedAt = (values["endedAt"] as? JsonPrimitive)?.longOrNull ?: previous?.endedAt,
            exitCode = (values["exitCode"] as? JsonPrimitive)?.intOrNull ?: previous?.exitCode,
            exitReason = values.str("exitReason") ?: previous?.exitReason,
            outputBytes = (values["outputBytes"] as? JsonPrimitive)?.longOrNull ?: previous?.outputBytes ?: 0,
        )
    }
    if (tasks.isEmpty()) return null
    return LiveBackgroundSnapshot(tasks = tasks.values.toList())
}

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
    val activeCount: Int get() = agentsRunning + workflowsActive
    val hasRecords: Boolean get() = agents.isNotEmpty() || workflows.isNotEmpty()

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

private fun fallbackSubagentWorkflow(detail: LiveDetail?): LiveSubagentWorkflow? {
    val entries = detail?.entries ?: return null
    val callLabels = toolCallLabels(entries)
    val agents = linkedMapOf<String, LiveSubagentRecord>()
    val workflows = linkedMapOf<String, LiveWorkflowRecord>()
    val workflowByWorkId = mutableMapOf<String, String>()

    fun agent(id: String, label: String?, status: String?, workflowId: String? = null) {
        val previous = agents[id]
        agents[id] = LiveSubagentRecord(
            id = id,
            label = label?.trim()?.takeIf { it.isNotEmpty() } ?: previous?.label ?: id,
            status = status?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: previous?.status ?: "unknown",
            needsAttention = previous?.needsAttention == true,
            stalled = previous?.stalled == true,
            workflowId = workflowId ?: previous?.workflowId,
        )
    }

    fun workflow(id: String, label: String?, status: String?, details: JsonObject? = null) {
        val previous = workflows[id]
        val stages = details?.get("stages") as? JsonArray
        val tasks = stages.orEmpty().mapNotNull { it as? JsonObject }
            .flatMap { stage -> (stage["tasks"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject } }
        val currentStage = stages?.let { list ->
            list.indexOfFirst { raw ->
                val stage = raw as? JsonObject
                val stageStatus = stage?.str("status")?.trim()?.lowercase().orEmpty()
                stageStatus !in LIVE_WORK_COMPLETED_STATUSES
            }.takeIf { it >= 0 } ?: (list.size - 1).takeIf { list.isNotEmpty() }
        }
        workflows[id] = LiveWorkflowRecord(
            id = id,
            label = label?.trim()?.takeIf { it.isNotEmpty() } ?: previous?.label ?: id,
            status = status?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: previous?.status ?: "unknown",
            currentStage = currentStage ?: previous?.currentStage,
            stageCount = stages?.size ?: previous?.stageCount ?: 0,
            taskTotal = tasks.size.takeIf { it > 0 } ?: previous?.taskTotal ?: 0,
            taskDone = tasks.count { it.str("status")?.trim()?.lowercase() in LIVE_WORK_COMPLETED_STATUSES }
                .takeIf { tasks.isNotEmpty() } ?: previous?.taskDone ?: 0,
            taskFailed = tasks.count { it.str("status")?.trim()?.lowercase() in LIVE_WORK_ATTENTION_STATUSES }
                .takeIf { tasks.isNotEmpty() } ?: previous?.taskFailed ?: 0,
        )
    }

    fun job(id: String, kind: String?, label: String?, status: String?) {
        val workflowId = workflowByWorkId[id]
        if (kind == "workflow" || workflowId != null) {
            val resolved = workflowId ?: id
            workflowByWorkId[id] = resolved
            workflow(resolved, label, status)
        } else {
            agent(id, label, status)
        }
    }

    entries.forEach { raw ->
        val entry = raw as? JsonObject ?: return@forEach
        if (entry.str("type") == "custom_message") {
            if (entry.str("customType") == "subagent-workbench-completion") {
                val details = entry["details"] as? JsonObject
                val id = details?.str("workId")?.trim()?.takeIf { it.isNotEmpty() }
                if (id != null) job(id, details.str("kind"), null, details.str("status"))
            }
            return@forEach
        }
        val message = liveEntryMessage(raw) ?: return@forEach
        if (message.str("role") != "toolResult") return@forEach
        val toolName = message.str("toolName") ?: return@forEach
        if (!toolName.startsWith("subagent_")) return@forEach
        val details = message["details"] as? JsonObject ?: return@forEach
        val textLabels = workLabelsInText(messageText(message))
        val callLabel = message.str("toolCallId")?.let(callLabels::get)
        when (toolName) {
            "subagent_start" -> {
                val id = details.str("workId")?.trim()?.takeIf { it.isNotEmpty() } ?: return@forEach
                agent(id, details.str("label") ?: callLabel ?: textLabels[id], details.str("status"))
            }
            "subagent_workflow" -> {
                val workId = details.str("workId")?.trim()?.takeIf { it.isNotEmpty() }
                val workflowId = details.str("workflowId")?.trim()?.takeIf { it.isNotEmpty() } ?: workId
                if (workflowId != null) {
                    if (workId != null) workflowByWorkId[workId] = workflowId
                    workflow(workflowId, details.str("label") ?: callLabel, details.str("status"), details)
                }
            }
            "subagent_results" -> {
                for (key in listOf("pending", "completed")) {
                    val items = details[key] as? JsonArray ?: continue
                    for (rawItem in items) {
                        val item = rawItem as? JsonObject ?: continue
                        val id = item.str("workId")?.trim()?.takeIf { it.isNotEmpty() } ?: continue
                        job(id, item.str("kind"), textLabels[id], item.str("status"))
                    }
                }
            }
            "subagent_cancel" -> {
                val id = details.str("workId")?.trim()?.takeIf { it.isNotEmpty() } ?: return@forEach
                job(id, details.str("kind"), null, details.str("status") ?: "cancelled")
            }
            "subagent_workflow_control" -> {
                val id = details.str("workId")?.trim()?.takeIf { it.isNotEmpty() } ?: return@forEach
                job(id, "workflow", null, details.str("status"))
            }
        }
    }

    val agentList = agents.values.toList()
    val workflowList = workflows.values.toList()
    if (agentList.isEmpty() && workflowList.isEmpty()) return null
    return LiveSubagentWorkflow(
        agents = agentList,
        workflows = workflowList,
        agentsTotal = agentList.size,
        agentsRunning = agentList.count { it.isActive },
        agentsAttention = agentList.count { it.hasAttention },
        workflowsTotal = workflowList.size,
        workflowsActive = workflowList.count { it.isActive },
        workflowsFailed = workflowList.count { it.hasFailed },
        workflowsPaused = workflowList.count { it.isPaused },
    )
}

internal fun subagentWorkflow(detail: LiveDetail?): LiveSubagentWorkflow? {
    val entry = featureSnapshotEntry(detail, "subagent-workflow")
    if (entry != null) {
        // A published snapshot (including an explicit clear) is authoritative;
        // transcript fallback is only for sessions that never had the feature.
        val snapshot = entry["snapshot"] as? JsonObject ?: return null
        return decodeSubagentWorkflow(snapshot)
    }
    return fallbackSubagentWorkflow(detail)
}
