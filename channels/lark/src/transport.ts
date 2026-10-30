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

/** A card button click, already normalised by the transport. */
export interface CardAction {
  chatId: string
  userId: string
  /** The card message that was clicked (used to find its thread). */
  messageId: string
  /** Platform callback id, used to drop a redelivered click. */
  eventId?: string
  /** The command bound to the button (`/list`, `/bind …`). */
  command: string
}

export interface ImTransport {
  /**
   * Begin receiving messages. `onMessage` may be async; `onBotAdded` fires when
   * the bot is added to a chat (used to send a usage hint).
   */
  start(
    onMessage: (message: ImMessage) => void | Promise<void>,
    onBotAdded?: (chatId: string) => void | Promise<void>,
    onCardAction?: (action: CardAction) => void,
  ): Promise<void>
  /**
   * Send a plain-text message to a chat (optionally a topic/thread).
   * When `replyMessageId` is set, the text is posted as a reply into that
   * message's thread — the only way to reach a specific topic in a topic-group.
   */
  sendText(chatId: string, threadId: string | null, text: string, replyMessageId?: string): Promise<void>
  /**
   * Send an interactive card (Lark card JSON 2.0). Optional: transports without
   * it get the plain-text form. Resolves to the new message id when known.
   */
  sendCard?(chatId: string, threadId: string | null, card: Record<string, unknown>, replyMessageId?: string): Promise<string | undefined>
  /** Replace a card this bot sent earlier (progress -> answer). Optional like `sendCard`. */
  updateCard?(messageId: string, card: Record<string, unknown>): Promise<void>
  stop(): Promise<void>
}
