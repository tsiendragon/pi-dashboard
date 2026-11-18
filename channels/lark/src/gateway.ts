import type { LiveSessionBrowserEvent, LiveSessionSummary } from '../../../shared/src/live-sessions.js'
import { Catalog } from './catalog.js'
import { CARD_TEXT_LIMIT, noticeCard, replyText, type LarkCard, type Reply } from './cards.js'
import { dialogCard, dialogLabel, dialogMethodOf, needsTextAnswer, type DialogView } from './dialogs.js'
import { answerCard, describeTool, endedCard, progressCard, type ProgressStep } from './progress.js'
import { runCommand } from './commands.js'
import type { LarkGatewayConfig } from './config.js'
import { DashboardClient } from './dashboardClient.js'
import { Mapping } from './mapping.js'
import { chunkText, extractAssistantText } from './render.js'
import type { CardAction, ImMessage, ImTransport } from './transport.js'

/**
 * Orchestrates the two directions:
 *  - inbound : transport message -> (command | input) -> live session
 *  - outbound: live session event -> assistant text -> bound chats
 */
/** How long after a command the session's extension notices are relayed to the chat. */
const NOTICE_WINDOW_MS = 30_000
/** Lark rate-limits edits of one message; keep progress patches at most this often. */
const PATCH_INTERVAL_MS = 1500
/** Refresh the elapsed time on a progress card that has nothing new to show. */
const TICK_MS = 15_000
/** A run with no event for this long is treated as lost (missed `agent_settled`). */
const RUN_STALE_MS = 10 * 60_000
/** Nudge the chat once when a blocking dialog is still unanswered after this long. */
const DIALOG_REMIND_MS = 5 * 60_000
/** How long a settled dialog is kept, so a late click gets a clear answer. */
const DIALOG_KEEP_MS = 10 * 60_000
/** A text answer only counts for a dialog younger than this (a stale prompt must not eat messages). */
const DIALOG_INPUT_TTL_MS = 30 * 60_000

/** A blocking `extension_ui` request pi is waiting on, plus where we showed it. */
interface PendingDialog {
  id: string
  processInstanceId: string
  sessionFile: string
  view: DialogView
  /** Chat scope -> the card message id we sent there. */
  cards: Map<string, string>
  createdAt: number
  state: 'open' | 'answered' | 'closed'
  answeredWith?: string
  reminded?: boolean
  timer?: NodeJS.Timeout
  expireTimer?: NodeJS.Timeout
}

/** One chat-originated agent run and the progress card that tracks it. */
interface Run {
  scope: string
  chatId: string
  threadId: string | null
  anchor?: string
  sessionFile: string
  title: string
  startedAt: number
  touchedAt: number
  /** The live progress card; cleared once it became an answer. */
  cardId?: string
  /** Steps since the last answer (they fold into that answer). */
  steps: ProgressStep[]
  /** Serialises sends/patches for this run so they never race. */
  chain: Promise<void>
  timer?: NodeJS.Timeout
  ticker?: NodeJS.Timeout
  lastPatch: number
  /** Cards are unavailable for this run: behave like plain forwarding. */
  disabled?: boolean
}

export class Gateway {
  readonly catalog = new Catalog()
  readonly mapping: Mapping
  private readonly dashboard: DashboardClient
  private allowedUserIds: readonly string[]
  /** Last applied event sequence per process instance (outbound dedup). */
  private readonly lastSequence = new Map<string, number>()
  /** Handled/in-flight message ids; failed handling releases the id for redelivery. */
  private readonly seenMessageIds = new Set<string>()
  /** Chats waiting for an extension notice (chat scope -> expiry), opened by a command. */
  private readonly receiptUntil = new Map<string, number>()
  /** Cards we sent -> their thread, so a button click answers in the same topic. */
  private readonly cardThreads = new Map<string, string | null>()
  /** Handled card-click callback ids (Lark redelivers a click it got no answer for). */
  private readonly seenActionIds = new Set<string>()
  /** Live runs started from a chat, by chat scope. */
  private readonly runs = new Map<string, Run>()
  /** Blocking extension dialogs, keyed `sessionFile\u0000id`. */
  private readonly dialogs = new Map<string, PendingDialog>()

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
      action => this.onCardAction(action),
    )
  }

  async stop(): Promise<void> {
    for (const run of this.runs.values()) this.clearTimers(run)
    this.runs.clear()
    for (const dialog of this.dialogs.values()) this.clearDialogTimers(dialog)
    this.dialogs.clear()
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

  /**
   * Send one card, falling back to `text` when the transport has no cards or the
   * server rejects this one. Throws only when the text form failed too.
   */
  private async deliver(chatId: string, threadId: string | null, cardJson: LarkCard | undefined, text: string, anchor?: string): Promise<string | undefined> {
    if (cardJson && this.transport.sendCard) {
      try {
        const messageId = await this.transport.sendCard(chatId, threadId, cardJson, anchor)
        if (messageId) this.rememberCard(messageId, threadId)
        return messageId
      } catch (error) {
        // Not support (stdio) is expected; a rejected card is worth a line in the log.
        if (!(error instanceof Error && error.name === 'CardsUnsupportedError')) {
          console.warn(`[out] card failed, sending text -> ${scopeOf(chatId, threadId)}: ${errorText(error)}`)
        }
      }
    }
    for (const chunk of chunkText(text)) await this.transport.sendText(chatId, threadId, chunk, anchor)
    return undefined
  }

  private rememberCard(messageId: string, threadId: string | null): void {
    this.cardThreads.set(messageId, threadId)
    if (this.cardThreads.size > 2000) {
      for (const id of [...this.cardThreads.keys()].slice(0, 1000)) this.cardThreads.delete(id)
    }
  }

  /** Send a reply to a chat, with a compact outbound log. */
  private async reply(chatId: string, threadId: string | null, reply: Reply): Promise<void> {
    const scope = scopeOf(chatId, threadId)
    const text = replyText(reply)
    const cardJson = typeof reply === 'string' ? noticeCard(text) : reply.card ?? noticeCard(text)
    if (this.transport.sendCard) {
      console.log(`[out] reply -> ${scope} (${text.length} chars, card)`)
      try {
        await this.deliver(chatId, threadId, cardJson, text)
      } catch (error) {
        console.error(`[out] reply failed -> ${scope}: ${errorText(error)}`)
        throw new ReplyFailedError(errorText(error))
      }
      return
    }
    // `/model` and `/list` can exceed a single Lark message.
    for (const chunk of chunkText(text)) {
      console.log(`[out] reply -> ${scope} (${chunk.length} chars)`)
      try {
        await this.transport.sendText(chatId, threadId, chunk)
      } catch (error) {
        // An attempt is logged before the send, so a failure must say so explicitly.
        console.error(`[out] reply failed -> ${scope}: ${errorText(error)}`)
        throw new ReplyFailedError(errorText(error))
      }
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
        // The snapshot carries the session's unanswered dialogs, so a gateway that
        // restarted (or reconnected) can put the waiting question back in the chat
        // instead of leaving pi blocked and the chat silent.
        const data = frame.data as { summary?: LiveSessionSummary; pendingUi?: unknown }
        if (data.summary) this.catalog.upsert(data.summary)
        if (Array.isArray(data.pendingUi)) {
          for (const request of data.pendingUi) await this.onDialog(data.summary, request)
        }
        return
      }
      case 'live_session_detached': {
        const data = frame.data as { processInstanceId?: string }
        if (data.processInstanceId) {
          const gone = this.catalog.findByProcessId(data.processInstanceId)
          if (gone?.sessionFile) {
            await this.endRuns(gone.sessionFile, '会话已断开')
            await this.closeDialogs(gone.sessionFile)
          }
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
    const text = extractAssistantText(record.event.type, record.event.data)
    if (text) {
      if (!summary) {
        // Never drop an answer silently again: without a catalog row there is no
        // sessionFile, so no binding resolves and the chat just stays quiet.
        console.warn(
          `[out] dropped: unknown live session ${record.processInstanceId} (${text.length} chars, catalog=${this.catalog.list().length})`,
        )
        return
      }
      await this.forwardAnswer(summary, text)
      return
    }

    if (summary?.sessionFile) {
      const type = record.event.type
      const eventData = (record.event.data ?? {}) as { toolName?: unknown; toolCallId?: unknown; args?: unknown; isError?: unknown }
      if (type === 'tool_execution_start' && typeof eventData.toolName === 'string') {
        this.onToolStart(summary.sessionFile, eventData.toolName, eventData.args, typeof eventData.toolCallId === 'string' ? eventData.toolCallId : undefined)
        return
      }
      if (type === 'tool_execution_end') {
        this.onToolEnd(summary.sessionFile, typeof eventData.toolCallId === 'string' ? eventData.toolCallId : undefined, eventData.isError === true)
        return
      }
      if (type === 'extension_ui') {
        await this.onDialog(summary, record.event.data)
        return
      }
      if (type === 'extension_ui_closed') {
        await this.onDialogClosed(summary.sessionFile, record.event.data)
        return
      }
      if (type === 'agent_settled') {
        await this.endRuns(summary.sessionFile, '本轮结束')
        return
      }
    }

    // A one-way `ctx.ui.notify` from an extension (e.g. `/effort` → level set). The
    // terminal and the web UI show these; the chat only gets them shortly after a
    // command, so background chatter stays out.
    if (record.event.type === 'extension_ui_notify' && summary) {
      await this.forwardNotice(summary, record.event.data)
    }
  }

  /** Deliver one assistant answer to every chat bound to that session. */
  private async forwardAnswer(summary: LiveSessionSummary, text: string): Promise<void> {
    const sessionFile = summary.sessionFile
    if (!sessionFile) return
    const targets = this.mapping.lookupsBySession(sessionFile)
    if (targets.length === 0) return
    console.log(`[out] ${summary.sessionName || sessionFile} -> ${targets.map(t => scopeOf(t.chatId, t.threadId)).join(',')} (${text.length} chars)`)
    for (const binding of targets) {
      // Only a topic-scoped binding may anchor its answers to a message. On a plain
      // chat `reply_in_thread` makes Lark nest the answer into a new thread, and the
      // user's next message then arrives with a `thread_id` the chat key misses.
      const anchor = binding.threadId ? binding.replyMessageId : undefined
      const parts = chunkText(text, CARD_TEXT_LIMIT)
      const run = this.liveRun(binding.chatId, binding.threadId, sessionFile)
      const send = async (): Promise<void> => {
        // The answer takes over the progress card, so the chat shows one message
        // that went from "thinking" to the answer instead of two.
        let cardId: string | undefined
        let steps: ProgressStep[] = []
        if (run) {
          this.clearTimer(run)
          cardId = run.cardId
          steps = run.steps
          run.cardId = undefined
          run.steps = []
          run.touchedAt = Date.now()
        }
        const model = summary.model ? `${summary.model.provider}/${summary.model.id}` : undefined
        for (const [index, part] of parts.entries()) {
          const cardJson = answerCard({
            title: sessionTitle(summary),
            text: part,
            part: { index, total: parts.length },
            steps,
            elapsedMs: run ? Date.now() - run.startedAt : undefined,
            model,
          })
          try {
            if (index === 0 && cardId && this.transport.updateCard) {
              try {
                await this.transport.updateCard(cardId, cardJson)
                continue
              } catch (error) {
                console.warn(`[out] progress->answer update failed, sending new card: ${errorText(error)}`)
              }
            }
            await this.deliver(binding.chatId, binding.threadId, cardJson, part, anchor)
          } catch (error) {
            // One failed chat/chunk must not swallow the remaining ones.
            console.error(`[out] send failed -> ${scopeOf(binding.chatId, binding.threadId)}: ${errorText(error)}`)
          }
        }
      }
      if (run) await this.enqueue(run, send)
      else await send()
    }
  }

  /** Relay an extension notice to the chats that just asked for a receipt. */
  private async forwardNotice(summary: LiveSessionSummary, data: unknown): Promise<void> {
    const sessionFile = summary.sessionFile
    if (!sessionFile) return
    const record = data as { message?: unknown; notifyType?: unknown } | null | undefined
    const message = typeof record?.message === 'string' ? record.message.trim() : ''
    if (!message) return
    const icon = record?.notifyType === 'error' ? '❌' : record?.notifyType === 'warning' ? '⚠️' : 'ℹ️'
    for (const binding of this.mapping.lookupsBySession(sessionFile)) {
      if (!this.hasReceipt(binding.chatId, binding.threadId)) continue
      const scope = scopeOf(binding.chatId, binding.threadId)
      try {
        await this.deliver(binding.chatId, binding.threadId, noticeCard(`${icon} ${message}`), `${icon} ${message}`)
        console.log(`[out] notice -> ${scope} (${message.length} chars)`)
      } catch (error) {
        console.error(`[out] notice failed -> ${scope}: ${errorText(error)}`)
      }
    }
  }

  /** Open the receipt window for a chat, so a command's notices land in the chat. */
  private openReceipt(chatId: string, threadId: string | null): void {
    const now = Date.now()
    for (const [scope, until] of this.receiptUntil) if (until <= now) this.receiptUntil.delete(scope)
    this.receiptUntil.set(scopeOf(chatId, threadId), now + NOTICE_WINDOW_MS)
  }

  private hasReceipt(chatId: string, threadId: string | null): boolean {
    const scope = scopeOf(chatId, threadId)
    const until = this.receiptUntil.get(scope)
    if (until === undefined) return false
    if (until <= Date.now()) {
      this.receiptUntil.delete(scope)
      return false
    }
    return true
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
    // Include the thread: a chat-level binding answers messages from any of its
    // threads, and the two are otherwise indistinguishable in the log.
    console.log(`[in] ${scopeOf(message.chatId, message.threadId)} ${message.userId}: ${text.slice(0, 80)}`)

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

  /**
   * A card button was clicked: run its command as if the user had typed it.
   * Lark has already been answered (toast), so this runs detached.
   */
  private onCardAction(action: CardAction): void {
    if (!this.isAllowed(action.userId)) {
      console.log(`[in] card click ignored (not allowed): ${action.userId}`)
      return
    }
    if (action.eventId) {
      if (this.seenActionIds.has(action.eventId)) return
      this.seenActionIds.add(action.eventId)
      if (this.seenActionIds.size > 1000) {
        for (const id of [...this.seenActionIds].slice(0, 500)) this.seenActionIds.delete(id)
      }
    }
    const threadId = this.cardThreads.get(action.messageId) ?? null
    if (action.answer) {
      console.log(`[in] dialog answer ${scopeOf(action.chatId, threadId)} ${action.userId}: ${action.answer.id}=${action.answer.cancelled ? '(cancel)' : action.answer.value}`)
      void this.answerDialog(action.chatId, threadId, action.answer).catch(
        error => console.error(`[in] dialog answer failed: ${errorText(error)}`),
      )
      return
    }
    if (!action.command) return
    console.log(`[in] card click ${scopeOf(action.chatId, threadId)} ${action.userId}: ${action.command}`)
    void this.handleMessage({ chatId: action.chatId, threadId, userId: action.userId, text: action.command, messageId: action.messageId }).catch(
      error => console.error(`[in] card click failed: ${errorText(error)}`),
    )
  }

  // --- extension dialogs -----------------------------------------------------

  private dialogKey(sessionFile: string, id: string): string {
    return `${sessionFile}\u0000${id}`
  }

  /**
   * A blocking dialog appeared (or was replayed after a reconnect). Show it in
   * every chat bound to that session; the upstream settles on the first answer,
   * so whichever chat (or web UI) answers first wins.
   */
  private async onDialog(summary: LiveSessionSummary | undefined, data: unknown): Promise<void> {
    if (!summary?.sessionFile) return
    const record = (data ?? {}) as { id?: unknown; method?: unknown; title?: unknown; message?: unknown; options?: unknown; placeholder?: unknown; prefill?: unknown }
    const id = typeof record.id === 'string' ? record.id : ''
    const method = dialogMethodOf(record.method)
    if (!id || !method) return
    const key = this.dialogKey(summary.sessionFile, id)
    if (this.dialogs.has(key)) return

    const view: DialogView = {
      id,
      method,
      title: typeof record.title === 'string' ? record.title : '',
      ...(typeof record.message === 'string' ? { message: record.message } : {}),
      ...(Array.isArray(record.options) ? { options: record.options.filter((option): option is string => typeof option === 'string') } : {}),
      ...(typeof record.placeholder === 'string' ? { placeholder: record.placeholder } : {}),
      ...(typeof record.prefill === 'string' ? { prefill: record.prefill } : {}),
    }
    const dialog: PendingDialog = {
      id,
      processInstanceId: summary.processInstanceId,
      sessionFile: summary.sessionFile,
      view,
      cards: new Map(),
      createdAt: Date.now(),
      state: 'open',
    }
    this.dialogs.set(key, dialog)
    await this.sendDialogCards(dialog)

    dialog.timer = setTimeout(() => void this.remindDialog(dialog), DIALOG_REMIND_MS)
    dialog.timer.unref?.()
    dialog.expireTimer = setTimeout(() => this.forgetDialog(dialog), DIALOG_KEEP_MS)
    dialog.expireTimer.unref?.()
  }

  private async sendDialogCards(dialog: PendingDialog): Promise<void> {
    for (const binding of this.mapping.lookupsBySession(dialog.sessionFile)) {
      const scope = scopeOf(binding.chatId, binding.threadId)
      if (dialog.cards.has(scope)) continue
      const anchor = binding.threadId ? binding.replyMessageId : undefined
      const text = `${dialog.view.title || '需要你确认'}${dialog.view.message ? `
${dialog.view.message}` : ''}`
      try {
        const messageId = await this.deliver(binding.chatId, binding.threadId, dialogCard(dialog.view, 'open'), text, anchor)
        // Record the scope even without a message id: a text answer must still be
        // recognised when the card fell back to plain text.
        dialog.cards.set(scope, messageId ?? '')
        // The card id is only known when a card actually went out; without cards
        // (stdio) the text form is still informative, and the web UI can answer.
      } catch (error) {
        console.warn(`[out] dialog card failed -> ${scope}: ${errorText(error)}`)
      }
    }
    console.log(`[out] dialog ${dialogLabel(dialog.view)} -> ${[...dialog.cards.keys()].join(',') || '(no bound chat)'}`)
  }

  /** Answer a dialog from a card click, then fold the card into its settled state. */
  private async answerDialog(chatId: string, threadId: string | null, answer: NonNullable<CardAction['answer']>): Promise<void> {
    const scope = scopeOf(chatId, threadId)
    const dialog = [...this.dialogs.values()].find(candidate => candidate.id === answer.id && candidate.cards.has(scope))
    if (!dialog) {
      // Expired or never shown here: say so instead of silently doing nothing.
      await this.reply(chatId, threadId, '这个选择已经失效（可能已经在网页端或别处处理过）。')
      return
    }
    if (dialog.state !== 'open') {
      await this.reply(chatId, threadId, dialog.state === 'answered' ? `已经回答过了${dialog.answeredWith ? `：${dialog.answeredWith}` : ''}。` : '这个选择已经在其它端处理了。')
      return
    }
    try {
      const result = await this.dashboard.answerUi(dialog.processInstanceId, dialog.id, answer.cancelled ? { cancelled: true } : { value: answer.value ?? '' })
      if (result?.accepted === false) {
        await this.settleDialog(dialog, 'closed')
        await this.reply(chatId, threadId, '这个选择已经在其它端处理了。')
        return
      }
      await this.settleDialog(dialog, 'answered', answer.cancelled ? '（取消）' : answer.value)
    } catch (error) {
      console.error(`[in] answer_ui failed: ${errorText(error)}`)
      await this.reply(chatId, threadId, `提交选择失败：${errorText(error)}`)
    }
  }

  private async onDialogClosed(sessionFile: string, data: unknown): Promise<void> {
    const id = typeof (data as { id?: unknown } | undefined)?.id === 'string' ? (data as { id: string }).id : ''
    if (!id) return
    const dialog = this.dialogs.get(this.dialogKey(sessionFile, id))
    if (!dialog || dialog.state !== 'open') return
    // Answered from the web UI / terminal, or cancelled upstream.
    await this.settleDialog(dialog, 'closed')
  }

  private async closeDialogs(sessionFile: string): Promise<void> {
    for (const dialog of [...this.dialogs.values()]) {
      if (dialog.sessionFile === sessionFile && dialog.state === 'open') await this.settleDialog(dialog, 'closed')
    }
  }

  /** Freeze a dialog: update every card we sent and stop its timers. */
  private async settleDialog(dialog: PendingDialog, state: 'answered' | 'closed', answeredWith?: string): Promise<void> {
    dialog.state = state
    if (answeredWith !== undefined) dialog.answeredWith = answeredWith
    this.clearDialogTimers(dialog)
    if (!this.transport.updateCard) return
    for (const [scope, messageId] of dialog.cards) {
      if (!messageId) continue
      try {
        await this.transport.updateCard(messageId, dialogCard(dialog.view, state, dialog.answeredWith))
      } catch (error) {
        console.warn(`[out] dialog card update failed -> ${scope}: ${errorText(error)}`)
      }
    }
  }

  private async remindDialog(dialog: PendingDialog): Promise<void> {
    if (dialog.state !== 'open' || dialog.reminded) return
    dialog.reminded = true
    const text = `⏳ 会话还在等你回答「${dialog.view.title || '一个确认'}」，上面的卡片点一下就能继续。`
    for (const binding of this.mapping.lookupsBySession(dialog.sessionFile)) {
      try {
        await this.reply(binding.chatId, binding.threadId, text)
      } catch (error) {
        console.warn(`[out] dialog reminder failed: ${errorText(error)}`)
      }
    }
  }

  private forgetDialog(dialog: PendingDialog): void {
    this.clearDialogTimers(dialog)
    const key = this.dialogKey(dialog.sessionFile, dialog.id)
    if (this.dialogs.get(key) === dialog) this.dialogs.delete(key)
  }

  private clearDialogTimers(dialog: PendingDialog): void {
    if (dialog.timer) clearTimeout(dialog.timer)
    if (dialog.expireTimer) clearTimeout(dialog.expireTimer)
    dialog.timer = undefined
    dialog.expireTimer = undefined
  }

  /** A dialog waiting for free text in this chat, if any. */
  private textDialogFor(chatId: string, threadId: string | null): PendingDialog | undefined {
    const scope = scopeOf(chatId, threadId)
    return [...this.dialogs.values()].find(
      dialog =>
        dialog.state === 'open' &&
        needsTextAnswer(dialog.view.method) &&
        dialog.cards.has(scope) &&
        Date.now() - dialog.createdAt < DIALOG_INPUT_TTL_MS,
    )
  }

  private async dispatch(message: ImMessage, text: string): Promise<void> {
    if (text.startsWith('/')) {
      // A command can make an extension emit `ctx.ui.notify` (`/effort high` →
      // "level set"); relay those for a short window so the chat gets a receipt.
      this.openReceipt(message.chatId, message.threadId)
      const reply = await runCommand(text, {
        chatId: message.chatId,
        threadId: message.threadId,
        messageId: message.messageId,
        catalog: this.catalog,
        mapping: this.mapping,
        dashboard: this.dashboard,
        notify: notice => this.reply(message.chatId, message.threadId, notice),
        forward: commandText => this.forwardInput(message.chatId, message.threadId, commandText),
      })
      // `null` = not a gateway command (`/clear`, `/goal`, skill commands, …). Those
      // ride pi's input stream, so fall through to the forwarding path below.
      if (reply !== null) {
        await this.reply(message.chatId, message.threadId, reply)
        return
      }
    }

    await this.forwardInput(message.chatId, message.threadId, text)
  }

  /** Send text into the bound session, answering the chat when that is impossible. */
  private async forwardInput(chatId: string, threadId: string | null, text: string): Promise<void> {
    // pi is blocked on an `input`/`editor` dialog: this message is the answer.
    const waiting = text.startsWith('/') ? undefined : this.textDialogFor(chatId, threadId)
    if (waiting) {
      await this.answerDialog(chatId, threadId, { id: waiting.id, value: text })
      return
    }
    const binding = this.mapping.lookup(chatId, threadId)
    if (!binding) {
      await this.reply(chatId, threadId, '尚未绑定会话。用 /list 查看，/bind <序号或名称> 绑定。')
      return
    }
    const summary = this.catalog.resolveBinding(binding.sessionFile)
    if (!summary) {
      await this.reply(
        chatId,
        threadId,
        `会话「${binding.sessionName || binding.sessionFile}」当前不可用，请 /list 后重新 /bind。`,
      )
      return
    }
    try {
      await this.dashboard.sendInput(summary.processInstanceId, text, 'chatapp')
    } catch (error) {
      console.error(`[in] dashboard forwarding failed: ${errorText(error)}`)
      await this.reply(chatId, threadId, '消息暂时未能送达 Agent，请稍后重试。')
      return
    }
    // Commands forwarded verbatim (`/clear`, `/effort …`) are not agent runs.
    if (!text.startsWith('/')) await this.startRun(chatId, threadId, binding.threadId ? binding.replyMessageId : undefined, summary)
  }

  // --- progress cards --------------------------------------------------------

  private canShowProgress(): boolean {
    return typeof this.transport.sendCard === 'function' && typeof this.transport.updateCard === 'function'
  }

  /** The run for this chat if it belongs to `sessionFile` and is still alive. */
  private liveRun(chatId: string, threadId: string | null, sessionFile: string): Run | undefined {
    const run = this.runs.get(scopeOf(chatId, threadId))
    if (!run || run.sessionFile !== sessionFile || run.disabled) return undefined
    return run
  }

  /** Put a "thinking" card in the chat right after its message reached the agent. */
  private async startRun(chatId: string, threadId: string | null, anchor: string | undefined, summary: LiveSessionSummary): Promise<void> {
    if (!this.canShowProgress() || !summary.sessionFile) return
    const scope = scopeOf(chatId, threadId)
    const existing = this.runs.get(scope)
    if (existing && existing.sessionFile === summary.sessionFile && Date.now() - existing.touchedAt < RUN_STALE_MS) {
      // A follow-up while the agent is still busy: the current card keeps tracking.
      existing.touchedAt = Date.now()
      return
    }
    if (existing) await this.finishRun(existing, '已被新消息接替')
    const now = Date.now()
    const run: Run = {
      scope, chatId, threadId, anchor,
      sessionFile: summary.sessionFile,
      title: sessionTitle(summary),
      startedAt: now, touchedAt: now, steps: [], chain: Promise.resolve(), lastPatch: now,
    }
    this.runs.set(scope, run)
    run.ticker = setInterval(() => {
      // Missed `agent_settled` (gateway reconnect mid-run): stop ticking eventually.
      if (Date.now() - run.touchedAt > RUN_STALE_MS) void this.finishRun(run, '长时间无进展，已停止跟踪')
      else this.schedulePatch(run)
    }, TICK_MS)
    run.ticker.unref?.()
    await this.enqueue(run, () => this.sendProgress(run, 'thinking'))
  }

  /** Send a fresh progress card for `run` (first one, or after an intermediate answer). */
  private async sendProgress(run: Run, phase: 'thinking' | 'working'): Promise<void> {
    if (run.disabled || run.cardId || !this.transport.sendCard) return
    try {
      run.cardId = await this.transport.sendCard(run.chatId, run.threadId, progressCard(run.title, run.steps, Date.now() - run.startedAt, phase), run.anchor)
      run.lastPatch = Date.now()
      if (run.cardId) this.rememberCard(run.cardId, run.threadId)
    } catch (error) {
      // No cards here (stdio) or Lark refused: answers still arrive as before.
      run.disabled = true
      this.clearTimers(run)
      if (!(error instanceof Error && error.name === 'CardsUnsupportedError')) {
        console.warn(`[out] progress card failed -> ${run.scope}: ${errorText(error)}`)
      }
    }
  }

  private onToolStart(sessionFile: string, toolName: string, args: unknown, toolCallId?: string): void {
    for (const run of this.runs.values()) {
      if (run.sessionFile !== sessionFile || run.disabled) continue
      run.touchedAt = Date.now()
      run.steps.push({ tool: toolName, detail: describeTool(toolName, args), state: 'running', toolCallId })
      if (run.cardId) this.schedulePatch(run)
      else void this.enqueue(run, () => this.sendProgress(run, 'working'))
    }
  }

  private onToolEnd(sessionFile: string, toolCallId: string | undefined, isError: boolean): void {
    for (const run of this.runs.values()) {
      if (run.sessionFile !== sessionFile || run.disabled) continue
      run.touchedAt = Date.now()
      const step = [...run.steps].reverse().find(candidate => candidate.state === 'running' && (!toolCallId || candidate.toolCallId === toolCallId))
      if (step) step.state = isError ? 'error' : 'done'
      this.schedulePatch(run)
    }
  }

  /** Coalesce progress patches to one per PATCH_INTERVAL_MS. */
  private schedulePatch(run: Run): void {
    if (run.disabled || !run.cardId || run.timer || !this.transport.updateCard) return
    const wait = Math.max(0, run.lastPatch + PATCH_INTERVAL_MS - Date.now())
    run.timer = setTimeout(() => {
      run.timer = undefined
      void this.enqueue(run, async () => {
        if (!run.cardId || !this.transport.updateCard) return
        run.lastPatch = Date.now()
        await this.transport.updateCard(run.cardId, progressCard(run.title, run.steps, Date.now() - run.startedAt, 'working'))
      })
    }, wait)
    run.timer.unref?.()
  }

  /** The agent settled (or the session went away): close every run on that session. */
  private async endRuns(sessionFile: string, reason: string): Promise<void> {
    for (const run of [...this.runs.values()]) if (run.sessionFile === sessionFile) await this.finishRun(run, reason)
  }

  private async finishRun(run: Run, reason: string): Promise<void> {
    this.clearTimers(run)
    if (this.runs.get(run.scope) === run) this.runs.delete(run.scope)
    await this.enqueue(run, async () => {
      // A card still showing progress means no answer replaced it: say how it ended.
      if (!run.cardId || !this.transport.updateCard) return
      const cardId = run.cardId
      run.cardId = undefined
      await this.transport.updateCard(cardId, endedCard(run.title, run.steps, Date.now() - run.startedAt, reason))
    })
  }

  private enqueue(run: Run, task: () => Promise<void>): Promise<void> {
    const next = run.chain.then(task).catch(error => console.warn(`[out] progress update failed -> ${run.scope}: ${errorText(error)}`))
    run.chain = next
    return next
  }

  private clearTimer(run: Run): void {
    if (run.timer) clearTimeout(run.timer)
    run.timer = undefined
  }

  private clearTimers(run: Run): void {
    this.clearTimer(run)
    if (run.ticker) clearInterval(run.ticker)
    run.ticker = undefined
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `chatId#threadId` when the message is thread-scoped, else just the chat id. */
function scopeOf(chatId: string, threadId: string | null): string {
  return threadId ? `${chatId}#${threadId}` : chatId
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

function sessionTitle(summary: LiveSessionSummary): string {
  return summary.sessionName?.trim() || summary.cwd.split(/[\\/]/).filter(Boolean).pop() || 'Pi'
}

const WELCOME = [
  '👋 pi-dashboard 已接入本会话。',
  '',
  '可用命令：',
  '  /list              列出所有会话',
  '  /bind <序号或名称>   绑定一个会话',
  '  /status            查看当前绑定',
  '  /unbind            解除绑定',
  '  /help              全部命令（/model /compact /abort /context …）',
  '',
  '绑定后直接发消息，即可进入该会话。',
].join('\n')
