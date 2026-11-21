package com.sam.pidash.ui.live

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.remote.LiveProofJobs
import com.sam.pidash.data.remote.LiveScheduleSummary
import com.sam.pidash.data.remote.LiveSubagentWork
import com.sam.pidash.data.remote.LiveWorkCounts
import com.sam.pidash.data.remote.activeBackgroundTasks
import com.sam.pidash.domain.model.LiveBackgroundSnapshot
import com.sam.pidash.ui.common.PulsingDot
import com.sam.pidash.ui.common.StatusDot
import com.sam.pidash.ui.theme.PiType
import java.text.DateFormat
import java.util.Date

internal data class LiveWorkState(
    val isLive: Boolean,
    val agentRunning: Boolean,
    val backgroundCount: Int?,
    val schedule: LiveScheduleSummary?,
    val needsInput: Boolean,
    val proofJobs: LiveProofJobs? = null,
    val subagentWork: LiveSubagentWork? = null,
) {
    val isExecuting: Boolean get() = agentRunning || (backgroundCount ?: 0) > 0 ||
        (proofJobs?.running ?: 0) > 0 || (subagentWork?.running ?: 0) > 0
    val isWorking: Boolean get() = isExecuting || schedule != null ||
        (proofJobs?.active ?: 0) > 0 || (subagentWork?.active ?: 0) > 0
    val subagentWorkLabel: String? get() {
        val work = subagentWork?.takeIf { it.active > 0 } ?: return null
        val parts = buildList {
            fun addCounts(name: String, counts: LiveWorkCounts) {
                if (counts.running > 0) add("$name ${counts.running} 个运行中")
                if (counts.queued > 0) add("$name ${counts.queued} 个排队")
            }
            addCounts("子 Agent", work.subagents)
            addCounts("工作流", work.workflows)
        }
        return "后台（非 Bash）：${parts.joinToString(" · ")}"
    }
    /** Shown only once the session has published proof jobs; settled-only lists stay quiet. */
    val proofJobsLabel: String? get() = proofJobs?.takeIf { it.jobs.isNotEmpty() }?.let { jobs ->
        val parts = buildList {
            if (jobs.running > 0) add("${jobs.running} 个运行中")
            if (jobs.queued > 0) add("${jobs.queued} 个排队")
            if (isEmpty()) add("无运行中")
        }
        "证明任务 ${parts.joinToString(" · ")} · 共 ${jobs.jobs.size} 个"
    }
    val scheduleHint: String get() = if (needsInput) "有待处理的请求" else "无需额外输入"
    val agentLabel: String get() = when {
        !isLive -> "工作状态待同步"
        agentRunning -> "主 Agent 工作中"
        else -> "主 Agent 空闲"
    }
    val backgroundLabel: String get() = when {
        !isLive -> "后台记录"
        backgroundCount == null -> "后台状态未知"
        backgroundCount == 0 -> "无后台命令运行"
        else -> "后台 $backgroundCount 个运行中"
    }
}

internal fun liveWorkState(
    agentStatus: String?,
    live: Boolean,
    background: LiveBackgroundSnapshot?,
    schedule: LiveScheduleSummary? = null,
    needsInput: Boolean = false,
    proofJobs: LiveProofJobs? = null,
    subagentWork: LiveSubagentWork? = null,
): LiveWorkState {
    val fresh = live && (agentStatus == "running" || agentStatus == "idle")
    return LiveWorkState(
        isLive = fresh,
        agentRunning = fresh && agentStatus == "running",
        backgroundCount = background?.takeIf { fresh }?.activeBackgroundTasks()?.size,
        schedule = schedule?.takeIf { fresh },
        needsInput = needsInput && fresh,
        proofJobs = proofJobs?.takeIf { fresh },
        subagentWork = subagentWork?.takeIf { fresh },
    )
}

@Composable
internal fun LiveWorkStatusBar(
    state: LiveWorkState,
    canOpenBackground: Boolean,
    onOpenBackground: () -> Unit,
    onOpenProofJobs: () -> Unit = {},
) {
    val colors = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().heightIn(min = 32.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (state.isExecuting) PulsingDot(colors.primary, size = 6.dp)
            else StatusDot(if (state.isWorking) colors.primary else colors.outline, size = 6.dp)
            Text(state.agentLabel, Modifier.weight(1f), style = PiType.caption, color = colors.onSurfaceVariant)
            if (state.isLive || canOpenBackground) {
                val action = if (canOpenBackground) {
                    Modifier.clickable(role = Role.Button, onClickLabel = "查看后台命令", onClick = onOpenBackground)
                } else Modifier
                Text(
                    state.backgroundLabel,
                    modifier = action.padding(horizontal = 8.dp, vertical = 8.dp),
                    style = PiType.caption,
                    color = if (canOpenBackground) colors.primary else colors.onSurfaceVariant,
                )
            }
        }
        state.subagentWorkLabel?.let { label ->
            Text(
                label,
                modifier = Modifier.padding(start = 14.dp, end = 8.dp, bottom = 8.dp),
                style = PiType.caption,
                color = colors.onSurfaceVariant,
            )
        }
        state.schedule?.let { schedule ->
            val next = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(schedule.nextRunAt))
            Text(
                "${schedule.count} 个定时任务等候触发 · 下次 $next · ${state.scheduleHint}",
                modifier = Modifier.padding(start = 14.dp, end = 8.dp, bottom = 8.dp),
                style = PiType.caption,
                color = colors.onSurfaceVariant,
            )
        }
        state.proofJobsLabel?.let { label ->
            Text(
                label,
                modifier = Modifier
                    .clickable(role = Role.Button, onClickLabel = "查看证明任务", onClick = onOpenProofJobs)
                    .padding(start = 14.dp, end = 8.dp, top = 2.dp, bottom = 8.dp),
                style = PiType.caption,
                color = colors.primary,
            )
        }
    }
}
