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
    for (const summary of await this.dashboard.listSessions()) this.catalog.upsert(summary)
    await this.dashboard.subscribe(frame => {
      void this.onFrame(frame)
    })
    await this.transport.start(message => this.onMessage(message))
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
        if (data.processInstanceId) this.catalog.remove(data.processInstanceId)
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
    const record = data as { processInstanceId?: string; event?: { type?: string; data?: unknown } }
    if (!record.processInstanceId || !record.event?.type) return

    const summary = this.catalog.findByProcessId(record.processInstanceId)
    if (!summary?.sessionFile) return

    const text = extractAssistantText(record.event.type, record.event.data)
    if (!text) return

    const targets = this.mapping.lookupsBySession(summary.sessionFile)
    if (targets.length === 0) return
    console.log(`[out] ${summary.sessionName || summary.sessionFile} -> ${targets.map(t => t.chatId).join(',')} (${text.length} chars)`)
    for (const binding of targets) {
      for (const chunk of chunkText(text)) {
        await this.transport.sendText(binding.chatId, binding.threadId, chunk)
      }
    }
  }

  private async onMessage(message: ImMessage): Promise<void> {
    if (!this.isAllowed(message.userId)) {
      console.log(`[in] ignored (not allowed): ${message.userId}`)
      return
    }
    const text = message.text.trim()
    if (!text) return
    console.log(`[in] ${message.chatId} ${message.userId}: ${text.slice(0, 80)}`)

    if (text.startsWith('/')) {
      const reply = await handleCommand(text, {
        chatId: message.chatId,
        threadId: message.threadId,
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
