import type { CardAction, ImMessage, ImTransport } from './transport.js'

type Handler = (message: ImMessage) => void | Promise<void>
type BotAddedHandler = (chatId: string) => void | Promise<void>
type CardActionHandler = (action: CardAction) => void

/**
 * Stable facade over a swappable transport, so switching the active Lark
 * account takes effect without restarting the gateway.
 */
export class TransportManager implements ImTransport {
  private current?: ImTransport
  private handler?: Handler
  private botAddedHandler?: BotAddedHandler
  private cardActionHandler?: CardActionHandler

  async start(onMessage: Handler, onBotAdded?: BotAddedHandler, onCardAction?: CardActionHandler): Promise<void> {
    this.handler = onMessage
    this.botAddedHandler = onBotAdded
    this.cardActionHandler = onCardAction
  }

  /** Swap in a new transport. On start failure, roll back to the previous one. */
  async activate(transport: ImTransport): Promise<void> {
    const previous = this.current
    try {
      if (this.handler) await transport.start(this.handler, this.botAddedHandler, this.cardActionHandler)
      this.current = transport
      if (previous) await previous.stop().catch(() => {})
    } catch (error) {
      await transport.stop().catch(() => {})
      this.current = previous
      throw error
    }
  }

  async sendText(chatId: string, threadId: string | null, text: string, replyMessageId?: string): Promise<void> {
    const transport = this.current
    // Fail loudly instead of silently doing nothing: a no-op reply used to look
    // exactly like a delivered one in the gateway log (`[out] ...` is written
    // before the send).
    if (!transport) throw new Error('no active transport: the chat channel is not connected')
    await transport.sendText(chatId, threadId, text, replyMessageId)
  }

  /** Always present: the swappable transport may or may not support cards. */
  async sendCard(chatId: string, threadId: string | null, card: Record<string, unknown>, replyMessageId?: string): Promise<string | undefined> {
    const transport = this.current
    if (!transport) throw new Error('no active transport: the chat channel is not connected')
    if (!transport.sendCard) throw new CardsUnsupportedError()
    return transport.sendCard(chatId, threadId, card, replyMessageId)
  }

  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    const transport = this.current
    if (!transport) throw new Error('no active transport: the chat channel is not connected')
    if (!transport.updateCard) throw new CardsUnsupportedError()
    await transport.updateCard(messageId, card)
  }

  async stop(): Promise<void> {
    await this.current?.stop().catch(() => {})
    this.current = undefined
  }
}

/** The active transport cannot send cards; the caller sends the text form. */
export class CardsUnsupportedError extends Error {
  constructor() {
    super('transport does not support cards')
    this.name = 'CardsUnsupportedError'
  }
}
