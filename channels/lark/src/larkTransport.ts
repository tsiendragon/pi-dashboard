import type { LarkGatewayConfig } from './config.js'
import type { ImMessage, ImTransport } from './transport.js'

type Handler = (message: ImMessage) => void | Promise<void>

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

  async start(onMessage: Handler): Promise<void> {
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
        const text = extractText(data?.message)
        if (!chatId || !text) return
        await onMessage({ chatId, threadId: null, userId: userId || 'unknown', text, messageId })
      },
    })

    this.wsClient = new lark.WSClient({ appId: this.cfg.larkAppId, appSecret: this.cfg.larkAppSecret, domain })
    await this.wsClient.start({ eventDispatcher: dispatcher })
  }

  async sendText(chatId: string, _threadId: string | null, text: string): Promise<void> {
    if (!this.client) throw new Error('LarkTransport has not been started')
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
    })
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
