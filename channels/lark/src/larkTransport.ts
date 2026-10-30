import type { LarkGatewayConfig } from './config.js'
import type { CardAction, ImMessage, ImTransport } from './transport.js'

type Handler = (message: ImMessage) => void | Promise<void>
type BotAddedHandler = (chatId: string) => void | Promise<void>
type CardActionHandler = (action: CardAction) => void

/**
 * Lark (Feishu) transport over the long-connection (WebSocket) event mode, so
 * no public IP / webhook is required.
 *
 * The `@larksuiteoapi/node-sdk` is imported lazily so the rest of the gateway
 * (and its typecheck) does not depend on it being installed.
 */
export class LarkTransport implements ImTransport {
  private client?: any
  private wsClient?: any

  constructor(private readonly cfg: LarkGatewayConfig) {}

  private async sdk(): Promise<any> {
    // Dynamic specifier keeps this off the type resolver until the SDK is installed.
    const moduleName = '@larksuiteoapi/node-sdk'
    return import(moduleName)
  }

  async start(onMessage: Handler, onBotAdded?: BotAddedHandler, onCardAction?: CardActionHandler): Promise<void> {
    if (!this.cfg.larkAppId || !this.cfg.larkAppSecret) {
      throw new Error('LARK_APP_ID / LARK_APP_SECRET are required for the Lark transport')
    }
    const lark = await this.sdk()
    // Long-connection is domain-isolated: a Lark (international) app must use
    // open.larksuite.com, otherwise pullConnectConfig fails with 1000040351.
    const domain = this.cfg.larkDomain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu
    this.client = new lark.Client({ appId: this.cfg.larkAppId, appSecret: this.cfg.larkAppSecret, domain })

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        const chatId: string | undefined = data?.message?.chat_id
        const userId: string | undefined = data?.sender?.sender_id?.open_id || data?.sender?.sender_id?.user_id
        const messageId: string | undefined = data?.message?.message_id
        // Present only in topic-groups; each thread becomes its own binding key.
        const threadId: string | null = data?.message?.thread_id || null
        const text = extractText(data?.message)
        if (!chatId || !text) return
        await onMessage({ chatId, threadId, userId: userId || 'unknown', text, messageId })
      },
      'im.chat.member.bot.added_v1': async (data: any) => {
        const chatId: string | undefined = data?.chat_id
        if (chatId && onBotAdded) await onBotAdded(chatId)
      },
      // A card button click. Lark wants an answer within 3s, and commands like
      // /compact take longer, so acknowledge with a toast right away and let the
      // command run on its own; its result arrives as a normal reply.
      'card.action.trigger': async (data: any) => {
        const action = parseCardAction(data)
        if (!action || !onCardAction) return { toast: { type: 'warning', content: '无法识别的按钮' } }
        onCardAction(action)
        return { toast: { type: 'info', content: `已执行 ${action.command.slice(0, 40)}` } }
      },
    })

    this.wsClient = new lark.WSClient({ appId: this.cfg.larkAppId, appSecret: this.cfg.larkAppSecret, domain })
    await this.wsClient.start({ eventDispatcher: dispatcher })
  }

  async sendText(chatId: string, _threadId: string | null, text: string, replyMessageId?: string): Promise<void> {
    if (!this.client) throw new Error('LarkTransport has not been started')
    if (replyMessageId) {
      // Topic-group: reply inside the original thread so it lands in that topic.
      await this.client.im.message.reply({
        path: { message_id: replyMessageId },
        data: { msg_type: 'text', content: JSON.stringify({ text }), reply_in_thread: true },
      })
      return
    }
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
    })
  }

  async sendCard(chatId: string, _threadId: string | null, card: Record<string, unknown>, replyMessageId?: string): Promise<string | undefined> {
    if (!this.client) throw new Error('LarkTransport has not been started')
    const content = JSON.stringify(card)
    const response = replyMessageId
      ? await this.client.im.message.reply({
          path: { message_id: replyMessageId },
          data: { msg_type: 'interactive', content, reply_in_thread: true },
        })
      : await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content },
        })
    // The SDK resolves (not rejects) on some API-level failures; a card the server
    // refused must surface so the caller can fall back to text.
    if (response && typeof response.code === 'number' && response.code !== 0) {
      throw new Error(`card rejected: ${response.code} ${response.msg ?? ''}`.trim())
    }
    return response?.data?.message_id
  }

  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    if (!this.client) throw new Error('LarkTransport has not been started')
    const response = await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    })
    if (response && typeof response.code === 'number' && response.code !== 0) {
      throw new Error(`card update rejected: ${response.code} ${response.msg ?? ''}`.trim())
    }
  }

  async stop(): Promise<void> {
    try {
      // SDK 1.74: WSClient.close() (not stop()); close is synchronous.
      this.wsClient?.close?.()
    } catch {
      /* best effort */
    }
  }
}

function extractText(message: any): string {
  try {
    const content = JSON.parse(message?.content || '{}')
    if (message?.message_type !== 'text') return ''
    let text = String(content.text || '')
    // In group chats an @-mention shows up as a placeholder like "@_user_1".
    // Strip every mention key so "@_user_1 /list" becomes "/list" and
    // commands / forwarded text stay clean.
    const mentions = Array.isArray(message?.mentions) ? message.mentions : []
    for (const mention of mentions) {
      const key = mention?.key
      if (typeof key === 'string' && key) text = text.split(key).join('')
    }
    return text.trim()
  } catch {
    return ''
  }
}

/** `card.action.trigger` (callback v2) -> a command click, or undefined when it is not one of ours. */
export function parseCardAction(data: any): CardAction | undefined {
  const value = data?.action?.value
  const command = typeof value?.cmd === 'string' ? value.cmd.trim() : ''
  if (!command.startsWith('/')) return undefined
  const chatId: string | undefined = data?.context?.open_chat_id ?? data?.open_chat_id
  const messageId: string | undefined = data?.context?.open_message_id ?? data?.open_message_id
  const userId: string | undefined = data?.operator?.open_id ?? data?.open_id
  if (!chatId || !messageId) return undefined
  return { chatId, messageId, userId: userId || 'unknown', command, eventId: data?.event_id }
}
