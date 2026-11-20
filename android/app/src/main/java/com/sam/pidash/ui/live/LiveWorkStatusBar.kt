package com.sam.pidash.ui.live

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import com.sam.pidash.data.remote.activeBackgroundTasks
import com.sam.pidash.domain.model.LiveBackgroundSnapshot
import com.sam.pidash.ui.common.PulsingDot
import com.sam.pidash.ui.common.StatusDot
import com.sam.pidash.ui.theme.PiType

internal data class LiveWorkState(val isLive: Boolean, val agentRunning: Boolean, val backgroundCount: Int?) {
    val isWorking: Boolean get() = agentRunning || (backgroundCount ?: 0) > 0
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

internal fun liveWorkState(agentStatus: String?, live: Boolean, background: LiveBackgroundSnapshot?): LiveWorkState {
    val fresh = live && (agentStatus == "running" || agentStatus == "idle")
    return LiveWorkState(fresh, fresh && agentStatus == "running", background?.takeIf { fresh }?.activeBackgroundTasks()?.size)
}

@Composable
internal fun LiveWorkStatusBar(state: LiveWorkState, canOpenBackground: Boolean, onOpenBackground: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 32.dp).padding(start = 16.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (state.isWorking) PulsingDot(colors.primary, size = 6.dp)
        else StatusDot(colors.outline, size = 6.dp)
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
}
