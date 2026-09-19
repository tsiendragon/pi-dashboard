import readline from 'node:readline'
import type { ImMessage, ImTransport } from './transport.js'

/**
 * Local transport for testing the gateway without Lark credentials.
 * One fixed chat; every stdin line is a message.
 */
export class StdioTransport implements ImTransport {
  private rl?: readline.Interface

  async start(
    onMessage: (message: ImMessage) => void | Promise<void>,
    _onBotAdded?: (chatId: string) => void | Promise<void>,
  ): Promise<void> {
    this.rl = readline.createInterface({ input: process.stdin })
    this.rl.on('line', line => {
      void onMessage({ chatId: 'stdio', threadId: null, userId: 'stdio', text: line })
    })
    process.stdout.write('[stdio] type a message, or /list /bind <n> /status /unbind; Ctrl-C to exit\n')
  }

  async sendText(_chatId: string, _threadId: string | null, text: string, _replyMessageId?: string): Promise<void> {
    process.stdout.write(`\n<< ${text}\n\n`)
  }

  async stop(): Promise<void> {
    this.rl?.close()
  }
}
