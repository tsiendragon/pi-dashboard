package com.sam.pidash.ui.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.repo.PiDashRepository
import com.sam.pidash.domain.model.ChatMessage
import com.sam.pidash.domain.model.MessageRole
import com.sam.pidash.domain.model.SessionKey
import com.sam.pidash.ui.common.clockTime
import com.sam.pidash.ui.theme.Hairline
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing
import kotlinx.coroutines.launch

/** Every interactive control keeps a 48 dp touch target even when drawn smaller. */
private val MinTouchTarget = 48.dp

@OptIn(ExperimentalMaterial3Api::class)
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
            TopAppBar(
                title = {
                    // Title + subtitle share one compact block; both truncate instead of
                    // pushing the bar to two lines.
                    Column {
                        Text(
                            slot?.slot?.title ?: sessionKey.slotKey,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = PiType.headline,
                        )
                        Text(
                            slot?.backendName ?: sessionKey.backendId,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = PiType.caption,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack, modifier = Modifier.size(MinTouchTarget)) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "返回",
                            modifier = Modifier.size(20.dp),
                        )
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
                    .padding(horizontal = Spacing.md, vertical = Spacing.sm),
            ) {
                error?.let {
                    Text(
                        it,
                        color = MaterialTheme.colorScheme.error,
                        style = PiType.footnote,
                        modifier = Modifier.padding(bottom = Spacing.xs),
                    )
                }
                Row(
                    verticalAlignment = Alignment.Bottom,
                    horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
                ) {
                    // iOS-style composer: filled, borderless, one radius step below bubbles.
                    TextField(
                        value = input,
                        onValueChange = { input = it },
                        modifier = Modifier.weight(1f),
                        placeholder = {
                            Text(
                                "发消息…",
                                style = PiType.subhead,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                            )
                        },
                        textStyle = PiType.subhead,
                        shape = Radii.card,
                        colors = TextFieldDefaults.colors(
                            focusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
                            unfocusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
                            focusedIndicatorColor = Color.Transparent,
                            unfocusedIndicatorColor = Color.Transparent,
                            disabledIndicatorColor = Color.Transparent,
                        ),
                        maxLines = 4,
                    )
                    if (isRunning) {
                        FilledIconButton(
                            onClick = { scope.launch { repo.stop(sessionKey) } },
                            modifier = Modifier.size(MinTouchTarget),
                            colors = IconButtonDefaults.filledIconButtonColors(
                                containerColor = MaterialTheme.colorScheme.errorContainer,
                                contentColor = MaterialTheme.colorScheme.error,
                            ),
                        ) {
                            Icon(
                                Icons.Filled.Close,
                                contentDescription = "停止",
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    } else {
                        FilledIconButton(
                            enabled = input.isNotBlank(),
                            onClick = {
                                val text = input.trim()
                                if (text.isEmpty()) return@FilledIconButton
                                input = ""
                                scope.launch { repo.send(sessionKey, text) }
                            },
                            modifier = Modifier.size(MinTouchTarget),
                        ) {
                            Icon(
                                Icons.AutoMirrored.Filled.Send,
                                contentDescription = "发送",
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    }
                }
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
