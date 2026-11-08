package com.sam.pidash.ui.common

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.LocalContext

/** Explicit user actions only. Never reads the clipboard, persists text, or logs its contents. */
internal fun copyPlainText(context: Context, text: String): Boolean {
    if (text.isEmpty()) return false
    return try {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return false
        clipboard.setPrimaryClip(ClipData.newPlainText("PiDash", text))
        true
    } catch (_: Exception) { false }
}

@Composable
internal fun rememberCopyText(): (String) -> Unit {
    val context = LocalContext.current
    return remember(context) { { text ->
        val copied = copyPlainText(context, text)
        Toast.makeText(context, if (copied) "已复制" else "复制失败，请重试；内容过大时可先缩小选区。", Toast.LENGTH_SHORT).show()
    } }
}

/** Copy is a local read-only action: it must not depend on session ownership or connection state. */
@Composable
internal fun CopyTextAction(text: String, label: String = "复制", tint: Color? = null) {
    val copy = rememberCopyText()
    // Small action text needs more contrast than an unmodified accent, especially in dark mode.
    val actionColor = tint ?: lerp(MaterialTheme.colorScheme.primary, MaterialTheme.colorScheme.onSurface, 0.25f)
    DisableSelection { MetaAction(label, { copy(text) }, enabled = text.isNotEmpty(), tint = actionColor) }
}
