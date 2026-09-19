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
}

export interface ImTransport {
  /** Begin receiving messages. `onMessage` may be async. */
  start(onMessage: (message: ImMessage) => void | Promise<void>): Promise<void>
  /** Send a plain-text message to a chat (optionally a topic/thread). */
  sendText(chatId: string, threadId: string | null, text: string): Promise<void>
  stop(): Promise<void>
}
