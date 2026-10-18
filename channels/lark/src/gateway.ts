import type { LiveSessionBrowserEvent, LiveSessionSummary } from '../../../shared/src/live-sessions.js'
import { Catalog } from './catalog.js'
import { handleCommand } from './commands.js'
import type { LarkGatewayConfig } from './config.js'
import { DashboardClient } from './dashboardClient.js'
import { Mapping } from './mapping.js'
import { chunkText, extractAssistantText } from './render.js'
import type { ImMessage, ImTransport } from './transport.js'

/**
 * Orchestrates the two directions:
 *  - inbound : transport message -> (command | input) -> live session
 *  - outbound: live session event -> assistant text -> bound chats
 */
export class Gateway {
  readonly catalog = new Catalog()
  readonly mapping: Mapping
  private readonly dashboard: DashboardClient
  private allowedUserIds: readonly string[]
  /** Last applied event sequence per process instance (outbound dedup). */
  private readonly lastSequence = new Map<string, number>()
  /** Handled/in-flight message ids; failed handling releases the id for redelivery. */
  private readonly seenMessageIds = new Set<string>()

  constructor(
    cfg: LarkGatewayConfig,
    private readonly transport: ImTransport,
    allowedUserIds: readonly string[] = [],
  ) {
    this.allowedUserIds = allowedUserIds
    this.mapping = new Mapping(cfg.mappingPath)
    this.dashboard = new DashboardClient(cfg)
  }

  async start(): Promise<void> {
    await this.mapping.load()
    try {
      for (const summary of await this.dashboard.listSessions()) this.catalog.upsert(summary)
    } catch (error) {
      // The dashboard may still be booting; the catalog refills on subscribe.
      console.warn(`[gateway] initial session list failed (${errorText(error)}); will recover on reconnect`)
    }
    await this.dashboard.subscribe(frame => {
      // `onFrame` is async; an unhandled rejection here would take the whole
      // gateway process down (Node exits on those), silencing both directions.
      void this.onFrame(frame).catch(error => console.error(`[gateway] frame failed: ${errorText(error)}`))
    })
    await this.transport.start(
      message => this.onMessage(message),
      chatId => this.onBotAdded(chatId),
    )
  }

  async stop(): Promise<void> {
    this.dashboard.close()
    await this.transport.stop()
  }

  /** Update the allow-list at runtime (dashboard-managed; hot-reloaded). */
  setAllowedUserIds(ids: readonly string[]): void {
    this.allowedUserIds = ids
    console.log(`[gateway] allowed users: ${ids.length ? ids.join(', ') : '(unrestricted)'}`)
  }

  private isAllowed(userId: string): boolean {
    return this.allowedUserIds.length === 0 || this.allowedUserIds.includes(userId)
  }

  /** Drop messages already handled (Lark may redeliver after a reconnect). */
  private isDuplicate(messageId?: string): boolean {
    if (!messageId) return false
    if (this.seenMessageIds.has(messageId)) return true
    this.seenMessageIds.add(messageId)
    if (this.seenMessageIds.size > 1000) {
      for (const id of [...this.seenMessageIds].slice(0, 500)) this.seenMessageIds.delete(id)
    }
    return false
  }

  /** Greet a chat when the bot is added, so a new group immediately knows how to start. */
  private async onBotAdded(chatId: string): Promise<void> {
    console.log(`[in] bot added to ${chatId}`)
    await this.reply(chatId, null, WELCOME)
  }

  /** Send a reply to a chat, with a compact outbound log. */
  private async reply(chatId: string, threadId: string | null, text: string): Promise<void> {
    console.log(`[out] reply -> ${chatId} (${text.length} chars)`)
    try {
      await this.transport.sendText(chatId, threadId, text)
    } catch (error) {
      // An attempt is logged before the send, so a failure must say so explicitly.
      console.error(`[out] reply failed -> ${chatId}: ${errorText(error)}`)
      throw new ReplyFailedError(errorText(error))
    }
  }

  private async onFrame(frame: LiveSessionBrowserEvent): Promise<void> {
    switch (frame.type) {
      case 'live_session_attached': {
        // Two shapes on this one event; see `attachedSummaries`. Reading only the
        // `{ sessions }` shape left the catalog blind to every session that
        // attached after the socket opened.
        for (const summary of attachedSummaries(frame.data)) this.catalog.upsert(summary)
        return
      }
      case 'live_session_snapshot': {
        const data = frame.data as { summary?: LiveSessionSummary }
        if (data.summary) this.catalog.upsert(data.summary)
        return
      }
      case 'live_session_detached': {
        const data = frame.data as { processInstanceId?: string }
        if (data.processInstanceId) {
          this.catalog.remove(data.processInstanceId)
          this.lastSequence.delete(data.processInstanceId)
        }
        return
      }
      case 'live_session_event': {
        await this.onEvent(frame.data)
        return
      }
      default:
        return
    }
  }

  private async onEvent(data: unknown): Promise<void> {
    if (!data || typeof data !== 'object') return
    const record = data as { processInstanceId?: string; sequence?: number; event?: { type?: string; data?: unknown } }
    if (!record.processInstanceId || !record.event?.type) return
    // Drop replays/duplicates: `sequence` is monotonic per process instance.
    if (typeof record.sequence === 'number') {
      const last = this.lastSequence.get(record.processInstanceId)
      if (last !== undefined && record.sequence <= last) return
      this.lastSequence.set(record.processInstanceId, record.sequence)
    }

    const text = extractAssistantText(record.event.type, record.event.data)
    if (!text) return

    const summary = this.catalog.findByProcessId(record.processInstanceId)
    if (!summary?.sessionFile) {
      // Never drop an answer silently again: without a catalog row there is no
      // sessionFile, so no binding resolves and the chat just stays quiet.
      console.warn(
        `[out] dropped: unknown live session ${record.processInstanceId} (${text.length} chars, catalog=${this.catalog.list().length})`,
      )
      return
    }

    const targets = this.mapping.lookupsBySession(summary.sessionFile)
    if (targets.length === 0) return
    console.log(`[out] ${summary.sessionName || summary.sessionFile} -> ${targets.map(t => t.chatId).join(',')} (${text.length} chars)`)
    for (const binding of targets) {
      for (const chunk of chunkText(text)) {
        try {
          await this.transport.sendText(binding.chatId, binding.threadId, chunk, binding.replyMessageId)
        } catch (error) {
          // One failed chat/chunk must not swallow the remaining ones.
          console.error(`[out] send failed -> ${binding.chatId}: ${errorText(error)}`)
        }
      }
    }
  }

  private async onMessage(message: ImMessage): Promise<void> {
    if (!this.isAllowed(message.userId)) {
      console.log(`[in] ignored (not allowed): ${message.userId}`)
      return
    }
    if (this.isDuplicate(message.messageId)) {
      console.log(`[in] duplicate ignored: ${message.messageId}`)
      return
    }

    try {
      await this.handleMessage(message)
    } catch (error) {
      if (message.messageId) this.seenMessageIds.delete(message.messageId)
      throw error
    }
  }

  private async handleMessage(message: ImMessage): Promise<void> {
    const text = message.text.trim()
    if (!text) return
    console.log(`[in] ${message.chatId} ${message.userId}: ${text.slice(0, 80)}`)

    try {
      await this.dispatch(message, text)
    } catch (error) {
      console.error(`[in] handling failed: ${errorText(error)}`)
      // A notice we could not deliver must not be followed by another notice: let
      // it out so the SDK logs it and the id is released for a redelivery.
      if (error instanceof ReplyFailedError) throw error
      await this.reply(message.chatId, message.threadId, `处理失败：${errorText(error)}`)
    }
  }

  private async dispatch(message: ImMessage, text: string): Promise<void> {
    if (text.startsWith('/')) {
      const reply = await handleCommand(text, {
        chatId: message.chatId,
        threadId: message.threadId,
        messageId: message.messageId,
        catalog: this.catalog,
        mapping: this.mapping,
        dashboard: this.dashboard,
      })
      await this.reply(message.chatId, message.threadId, reply)
      return
    }

    const binding = this.mapping.lookupByChat(message.chatId, message.threadId)
    if (!binding) {
      await this.reply(message.chatId, message.threadId, '尚未绑定会话。用 /list 查看，/bind <序号或名称> 绑定。')
      return
    }
    const summary = this.catalog.resolveBinding(binding.sessionFile)
    if (!summary) {
      await this.reply(
        message.chatId,
        message.threadId,
        `会话「${binding.sessionName || binding.sessionFile}」当前不可用，请 /list 后重新 /bind。`,
      )
      return
    }
    try {
      await this.dashboard.sendInput(summary.processInstanceId, text, 'chatapp')
    } catch (error) {
      console.error(`[in] dashboard forwarding failed: ${errorText(error)}`)
      await this.reply(message.chatId, message.threadId, '消息暂时未能送达 Agent，请稍后重试。')
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A chat notice could not be delivered at all. It is thrown (instead of
 * swallowed) so the inbound message id is released and a redelivery can retry —
 * and so the failure reaches the SDK log rather than ending in silence.
 */
class ReplyFailedError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'ReplyFailedError'
  }
}

/**
 * Summaries carried by a `live_session_attached` frame.
 *
 * The event has two shapes on the same channel: the frame sent right after the
 * socket opens carries every session (`{ sessions: [...] }`), while a session
 * that attaches later carries only itself — a `LiveSessionDetail`
 * (`{ summary, entries, ... }`). The web frontend handles both; the gateway used
 * to read `sessions` alone, so a session that attached after connect never
 * reached the catalog and every one of its replies was dropped as "unknown
 * live session" (silently, before this fix).
 */
function attachedSummaries(data: unknown): LiveSessionSummary[] {
  if (!data || typeof data !== 'object') return []
  const record = data as { sessions?: unknown; summary?: unknown }
  if (Array.isArray(record.sessions)) return record.sessions.filter(isSessionSummary)
  return isSessionSummary(record.summary) ? [record.summary] : []
}

function isSessionSummary(value: unknown): value is LiveSessionSummary {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { processInstanceId?: unknown }).processInstanceId === 'string'
  )
}

const WELCOME = [
  '👋 pi-dashboard 已接入本会话。',
  '',
  '可用命令：',
  '  /list              列出所有会话',
  '  /bind <序号或名称>   绑定一个会话',
  '  /status            查看当前绑定',
  '  /unbind            解除绑定',
  '',
  '绑定后直接发消息，即可进入该会话。',
].join('\n')
