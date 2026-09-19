import type { ImMessage, ImTransport } from './transport.js'

type Handler = (message: ImMessage) => void | Promise<void>
type BotAddedHandler = (chatId: string) => void | Promise<void>

/**
 * Stable facade over a swappable transport, so switching the active Lark
 * account takes effect without restarting the gateway.
 */
export class TransportManager implements ImTransport {
  private current?: ImTransport
  private handler?: Handler
  private botAddedHandler?: BotAddedHandler

  async start(onMessage: Handler, onBotAdded?: BotAddedHandler): Promise<void> {
    this.handler = onMessage
    this.botAddedHandler = onBotAdded
  }

  /** Swap in a new transport. On start failure, roll back to the previous one. */
  async activate(transport: ImTransport): Promise<void> {
    const previous = this.current
    try {
      if (this.handler) await transport.start(this.handler, this.botAddedHandler)
      this.current = transport
      if (previous) await previous.stop().catch(() => {})
    } catch (error) {
      await transport.stop().catch(() => {})
      this.current = previous
      throw error
    }
  }

  async sendText(chatId: string, threadId: string | null, text: string, replyMessageId?: string): Promise<void> {
    await this.current?.sendText(chatId, threadId, text, replyMessageId)
  }

  async stop(): Promise<void> {
    await this.current?.stop().catch(() => {})
    this.current = undefined
  }
}
