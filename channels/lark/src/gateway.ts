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
  /** Recently handled inbound message ids (dropped if redelivered). */
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
      void this.onFrame(frame)
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
    await this.transport.sendText(chatId, threadId, text)
  }

  private async onFrame(frame: LiveSessionBrowserEvent): Promise<void> {
    switch (frame.type) {
      case 'live_session_attached': {
        const data = frame.data as { sessions?: LiveSessionSummary[] }
        for (const summary of data.sessions ?? []) this.catalog.upsert(summary)
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

    const summary = this.catalog.findByProcessId(record.processInstanceId)
    if (!summary?.sessionFile) return

    const text = extractAssistantText(record.event.type, record.event.data)
    if (!text) return

    const targets = this.mapping.lookupsBySession(summary.sessionFile)
    if (targets.length === 0) return
    console.log(`[out] ${summary.sessionName || summary.sessionFile} -> ${targets.map(t => t.chatId).join(',')} (${text.length} chars)`)
    for (const binding of targets) {
      for (const chunk of chunkText(text)) {
        await this.transport.sendText(binding.chatId, binding.threadId, chunk, binding.replyMessageId)
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
    const text = message.text.trim()
    if (!text) return
    console.log(`[in] ${message.chatId} ${message.userId}: ${text.slice(0, 80)}`)

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
    await this.dashboard.sendInput(summary.processInstanceId, text, 'chatapp')
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
