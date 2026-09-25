package com.sam.pidash.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.repo.PiDashRepository
import com.sam.pidash.domain.model.ChatMessage
import com.sam.pidash.domain.model.MessageRole
import com.sam.pidash.domain.model.SessionKey
import com.sam.pidash.ui.common.clockTime
import kotlinx.coroutines.launch

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
                    Column {
                        Text(
                            slot?.slot?.title ?: sessionKey.slotKey,
                            maxLines = 1,
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Text(
                            slot?.backendName ?: sessionKey.backendId,
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
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
                    .padding(8.dp),
            ) {
                error?.let {
                    Text(
                        it,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(bottom = 4.dp),
                    )
                }
                Row(verticalAlignment = Alignment.Bottom) {
                    OutlinedTextField(
                        value = input,
                        onValueChange = { input = it },
                        modifier = Modifier.weight(1f),
                        placeholder = { Text("发消息…") },
                        maxLines = 5,
                    )
                    Spacer(Modifier.width(8.dp))
                    if (isRunning) {
                        FilledIconButton(onClick = { scope.launch { repo.stop(sessionKey) } }) {
                            Icon(Icons.Filled.Close, contentDescription = "停止")
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
                        ) {
                            Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "发送")
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
                    style = MaterialTheme.typography.bodyMedium,
                )
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
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
        isTool -> MaterialTheme.colorScheme.surfaceVariant
        else -> MaterialTheme.colorScheme.secondaryContainer
    }
    val alignment = if (isUser) Alignment.CenterEnd else Alignment.CenterStart

    Box(Modifier.fillMaxWidth(), contentAlignment = alignment) {
        Column(
            modifier = Modifier
                .widthIn(max = 320.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(bubbleColor)
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            val toolName = message.meta?.toolName
            if (toolName != null) {
                Text(
                    "🔧 $toolName",
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = FontFamily.Monospace,
                )
            }
            Text(
                message.content.ifBlank { "(空)" },
                style = if (isTool) {
                    MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)
                } else {
                    MaterialTheme.typography.bodyMedium
                },
            )
            Text(
                clockTime(message.timestamp),
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.align(Alignment.End),
            )
        }
    }
}
