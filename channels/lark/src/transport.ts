/**
 * Transport abstraction: the gateway is platform-agnostic. Lark is one
 * implementation; a stdio implementation exists for local testing without
 * any Lark credentials.
 */

export interface ImMessage {
  chatId: string
  threadId: string | null
  userId: string
  text: string
  /** Platform message id, used to drop duplicate deliveries. */
  messageId?: string
}

export interface ImTransport {
  /**
   * Begin receiving messages. `onMessage` may be async; `onBotAdded` fires when
   * the bot is added to a chat (used to send a usage hint).
   */
  start(
    onMessage: (message: ImMessage) => void | Promise<void>,
    onBotAdded?: (chatId: string) => void | Promise<void>,
  ): Promise<void>
  /**
   * Send a plain-text message to a chat (optionally a topic/thread).
   * When `replyMessageId` is set, the text is posted as a reply into that
   * message's thread — the only way to reach a specific topic in a topic-group.
   */
  sendText(chatId: string, threadId: string | null, text: string, replyMessageId?: string): Promise<void>
  stop(): Promise<void>
}
