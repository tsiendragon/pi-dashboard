package com.sam.pidash.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.repo.PiDashRepository
import com.sam.pidash.domain.model.ChatMessage
import com.sam.pidash.domain.model.MessageRole
import com.sam.pidash.domain.model.SessionKey
import com.sam.pidash.ui.common.CompactPageHeader
import com.sam.pidash.ui.common.clockTime
import com.sam.pidash.ui.live.ComposerPill
import com.sam.pidash.ui.theme.Hairline
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing
import kotlinx.coroutines.launch

/** Legacy Chat page, aligned with the Live chrome: same header, same composer pill, same menu. */
@Composable
fun ChatScreen(
    repo: PiDashRepository,
    sessionKey: SessionKey,
    onBack: () -> Unit,
) {
    val messagesMap by repo.messages.collectAsState()
    val streamingMap by repo.streaming.collectAsState()
    val runningSet by repo.running.collectAsState()
    val errorMap by repo.lastError.collectAsState()
    val slots by repo.aggregatedSlots.collectAsState()

    val messages = messagesMap[sessionKey].orEmpty()
    val streaming = streamingMap[sessionKey].orEmpty()
    val isRunning = runningSet.contains(sessionKey)
    val error = errorMap[sessionKey]
    val slot = slots.firstOrNull { it.key == sessionKey }

    var input by remember { mutableStateOf("") }
    var menu by remember { mutableStateOf(false) }
    var confirmClose by remember { mutableStateOf(false) }
    var closing by remember { mutableStateOf(false) }
    var closeError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()

    LaunchedEffect(sessionKey) { repo.loadMessages(sessionKey) }

    val itemCount = messages.size + if (streaming.isNotEmpty()) 1 else 0
    // Re-scroll on new messages AND on every streamed chunk (instant, not animated).
    LaunchedEffect(itemCount, streaming.length) {
        if (itemCount > 0) runCatching { listState.scrollToItem(itemCount - 1) }
    }

    Scaffold(
        topBar = {
            CompactPageHeader(
                title = slot?.slot?.title ?: sessionKey.slotKey,
                subtitle = slot?.backendName ?: sessionKey.backendId,
                navigationIcon = {
                    IconButton(onClick = onBack, modifier = Modifier.size(48.dp)) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回", modifier = Modifier.size(20.dp))
                    }
                },
                actions = {
                    Box {
                        IconButton(onClick = { menu = true }, modifier = Modifier.size(48.dp)) {
                            Icon(Icons.Filled.MoreVert, contentDescription = "会话操作", modifier = Modifier.size(20.dp))
                        }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(
                                text = { Text("关闭会话…", color = MaterialTheme.colorScheme.error) },
                                onClick = { menu = false; closeError = null; confirmClose = true },
                            )
                        }
                    }
                },
            )
        },
        bottomBar = {
            Column(
                Modifier
                    .fillMaxWidth()
                    .imePadding()
                    .navigationBarsPadding()
                    .padding(horizontal = Spacing.sm, vertical = Spacing.xs),
            ) {
                error?.let {
                    Text(
                        it,
                        color = MaterialTheme.colorScheme.error,
                        style = PiType.footnote,
                        modifier = Modifier.padding(horizontal = Spacing.sm, vertical = Spacing.xs),
                    )
                }
                val stopButton: (@Composable () -> Unit)? = if (isRunning) {
                    {
                        IconButton(onClick = { scope.launch { repo.stop(sessionKey) } }, modifier = Modifier.size(44.dp)) {
                            Box(
                                Modifier.size(34.dp).background(MaterialTheme.colorScheme.errorContainer, CircleShape),
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    Icons.Filled.Close, contentDescription = "停止",
                                    modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.error,
                                )
                            }
                        }
                    }
                } else null
                ComposerPill(
                    draft = input,
                    onDraftChange = { input = it },
                    enabled = true,
                    canSend = input.isNotBlank() && !isRunning,
                    onSend = {
                        val text = input.trim()
                        if (text.isNotEmpty() && !isRunning) {
                            input = ""
                            scope.launch { repo.send(sessionKey, text) }
                        }
                    },
                    onFocusChange = {},
                    maxHeight = 160.dp,
                    placeholder = "发消息…",
                    trailing = stopButton,
                )
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            if (messages.isEmpty() && streaming.isEmpty()) {
                Text(
                    "开始对话吧",
                    modifier = Modifier.align(Alignment.Center),
                    style = PiType.footnote,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = Spacing.md, vertical = Spacing.sm),
                    verticalArrangement = Arrangement.spacedBy(Spacing.sm),
                ) {
                    items(messages) { message -> MessageBubble(message) }
                    if (streaming.isNotEmpty()) {
                        item {
                            MessageBubble(
                                ChatMessage(
                                    role = MessageRole.ASSISTANT,
                                    content = streaming,
                                    timestamp = System.currentTimeMillis(),
                                ),
                            )
                        }
                    }
                }
            }
        }
    }

    if (confirmClose) {
        ChatCloseDialog(
            closing = closing,
            error = closeError,
            onDismiss = { if (!closing) confirmClose = false },
            onConfirm = {
                closing = true
                closeError = null
                scope.launch {
                    repo.closeChatSlot(sessionKey)
                        .onSuccess { confirmClose = false; onBack() }
                        .onFailure { closeError = it.message ?: "关闭失败" }
                    closing = false
                }
            },
        )
    }
}

/** Kept separate from the screen so the destructive flow can be tested without a repository. */
@Composable
internal fun ChatCloseDialog(
    closing: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    AlertDialog(shape = Radii.sheet,
        onDismissRequest = { if (!closing) onDismiss() },
        title = { Text("关闭这个 Chat 会话？", style = PiType.pageTitle) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                Text("将结束该 Chat 的 Pi 进程并从列表移除；正在生成的回复会被中断。", style = PiType.subhead)
                Text(
                    "已保存到磁盘的会话记录不会被删除。请求失败不会自动重试。",
                    style = PiType.subhead, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                error?.let { Text(it, style = PiType.footnote, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(enabled = !closing, onClick = onConfirm) {
                Text(if (closing) "正在关闭…" else "关闭会话", color = MaterialTheme.colorScheme.error)
            }
        },
        dismissButton = { TextButton(enabled = !closing, onClick = onDismiss) { Text("取消") } },
    )
}

@Composable
private fun MessageBubble(message: ChatMessage) {
    val isUser = message.role == MessageRole.USER
    val isTool = message.role == MessageRole.TOOL || message.role == MessageRole.SYSTEM
    val bubbleColor = when {
        isUser -> MaterialTheme.colorScheme.primaryContainer
        isTool -> MaterialTheme.colorScheme.surface
        else -> MaterialTheme.colorScheme.surfaceVariant
    }
    // Radii.bubble for received messages; the sender's bottom-end corner is tightened
    // into a tail so the two sides are distinguishable without extra chrome.
    val bubbleShape = if (isUser) {
        RoundedCornerShape(
            topStart = 18.dp,
            topEnd = 18.dp,
            bottomEnd = Spacing.xs,
            bottomStart = 18.dp,
        )
    } else {
        Radii.bubble
    }
    val alignment = if (isUser) Alignment.CenterEnd else Alignment.CenterStart

    Box(Modifier.fillMaxWidth(), contentAlignment = alignment) {
        Column(
            modifier = Modifier
                .widthIn(max = 320.dp)
                .clip(bubbleShape)
                .background(bubbleColor)
                .then(
                    if (isTool) Modifier.border(Hairline, MaterialTheme.colorScheme.outline, bubbleShape)
                    else Modifier
                )
                .padding(horizontal = Spacing.md, vertical = Spacing.sm),
        ) {
            val toolName = message.meta?.toolName
            if (toolName != null) {
                Text(
                    "🔧 $toolName",
                    style = PiType.monoMicro,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            // Inline timestamp allows every line of the message to use the available width.
            val timeColor = MaterialTheme.colorScheme.onSurfaceVariant
            Text(
                text = buildAnnotatedString {
                    append(message.content.ifBlank { "(空)" })
                    withStyle(SpanStyle(color = timeColor, fontSize = PiType.caption.fontSize)) {
                        append("  ")
                        append(clockTime(message.timestamp))
                    }
                },
                style = if (isTool) PiType.mono else PiType.body,
            )
        }
    }
}
