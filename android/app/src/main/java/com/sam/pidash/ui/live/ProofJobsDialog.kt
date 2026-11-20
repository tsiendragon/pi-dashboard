package com.sam.pidash.ui.live

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.remote.LiveProofJob
import com.sam.pidash.data.remote.LiveProofJobs
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii

internal fun proofJobStateLabel(state: String): String = when (state) {
    "queued" -> "排队中"
    "running" -> "运行中"
    "finished" -> "已完成"
    "failed" -> "失败"
    "cancelled" -> "已取消"
    else -> "未知"
}

private fun duration(ms: Long): String {
    val seconds = (ms / 1000).coerceAtLeast(0)
    if (seconds < 60) return "${seconds}s"
    val minutes = seconds / 60
    if (minutes < 60) return if (seconds % 60 == 0L) "${minutes}m" else "${minutes}m ${seconds % 60}s"
    return "${minutes / 60}h ${minutes % 60}m"
}

/** Queue wait, run time, or total; empty when the producer sent no timestamps. */
internal fun proofJobTiming(job: LiveProofJob, now: Long): String = when (job.state) {
    "queued" -> job.createdAt?.let { "已排队 ${duration(now - it)}" } ?: "等待空位"
    "running" -> job.startedAt?.let { "已运行 ${duration(now - it)}" } ?: "运行中"
    else -> {
        val start = job.startedAt ?: job.createdAt
        val end = job.finishedAt
        if (start != null && end != null) "用时 ${duration(end - start)}" else ""
    }
}

/**
 * Read-only list of PiMatrix proof jobs from the `proof-jobs` feature snapshot.
 * There are no actions: results are collected inside the session with `proof_jobs`.
 */
@Composable
internal fun ProofJobsDialog(jobs: LiveProofJobs, stale: Boolean, onDismiss: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val now = System.currentTimeMillis()
    AlertDialog(shape = Radii.sheet,
        onDismissRequest = onDismiss,
        title = {
            Column {
                Text("证明任务", style = PiType.callout)
                Text(
                    if (stale) "上次同步 · 共 ${jobs.jobs.size} 条记录" else "${jobs.running} 个运行中 · ${jobs.queued} 个排队 · 共 ${jobs.jobs.size} 个",
                    style = PiType.action,
                    color = colors.onSurfaceVariant,
                )
            }
        },
        text = {
            Column(
                Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (jobs.jobs.isEmpty()) Text("当前 session 没有证明任务。", style = PiType.caption, color = colors.onSurfaceVariant)
                jobs.jobs.forEach { job ->
                    val tone: Color = when (job.state) {
                        "running" -> colors.primary
                        "failed" -> colors.error
                        else -> colors.onSurfaceVariant
                    }
                    Column {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(proofJobStateLabel(job.state), style = PiType.caption, color = tone)
                            Text(job.label, Modifier.weight(1f), style = PiType.caption, color = colors.onSurface, maxLines = 2)
                            if (job.collected == true) Text("已取回", style = PiType.caption, color = colors.onSurfaceVariant)
                        }
                        val timing = proofJobTiming(job, now)
                        Text(
                            if (timing.isEmpty()) job.id else "${job.id} · $timing",
                            style = PiType.caption,
                            fontFamily = FontFamily.Monospace,
                            color = colors.onSurfaceVariant,
                            maxLines = 1,
                        )
                    }
                }
                Text("只读：结果在会话内用 proof_jobs 取回。", style = PiType.caption, color = colors.onSurfaceVariant)
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
    )
}
