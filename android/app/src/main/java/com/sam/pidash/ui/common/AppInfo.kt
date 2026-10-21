package com.sam.pidash.ui.common

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import com.sam.pidash.BuildConfig
import com.sam.pidash.domain.model.LiveBackendState
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

fun appVersionText(name: String = BuildConfig.VERSION_NAME, code: Int = BuildConfig.VERSION_CODE): String =
    "v$name · build $code"

@Composable
fun AppVersionLabel() {
    Text(appVersionText(), style = MaterialTheme.typography.labelSmall, maxLines = 1)
}

/** Show only the origin; never echo embedded credentials, URL tokens, paths or fragments. */
fun backendOriginLabel(raw: String): String = raw.toHttpUrlOrNull()?.newBuilder()
    ?.username("")?.password("")?.encodedPath("/")?.query(null)?.fragment(null)?.build()?.toString()?.removeSuffix("/") ?: "地址格式有误"

fun liveConnectionLabel(state: LiveBackendState?): String = when {
    state == null -> "Live Pi：正在检查"
    state.needsPairing -> "Live Pi：未配对（需网页手机配对码）"
    state.connected -> "Live Pi：已连接"
    else -> "Live Pi：未连接"
}
