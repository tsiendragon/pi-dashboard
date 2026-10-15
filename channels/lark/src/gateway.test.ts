import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { LiveSessionSummary } from '../../../shared/src/live-sessions.js'
import { Gateway } from './gateway.js'
import type { LarkGatewayConfig } from './config.js'
import type { ImMessage, ImTransport } from './transport.js'

function makeSession(): LiveSessionSummary {
  return {
    processInstanceId: 'process-123',
    sessionId: 'session-123',
    sessionFile: '/tmp/session-123.jsonl',
    sessionName: 'Lark test session',
    pid: 1234,
    cwd: '/tmp',
    canonicalCwd: '/tmp',
    mode: 'rpc',
    model: { provider: 'test', id: 'test-model' },
    status: 'idle',
    claim: { state: 'unclaimed' },
    startedAt: 1,
    lastActivityAt: 1,
    revision: 1,
    eventSequence: 1,
    git: { branch: 'main' },
  }
}

describe('Lark gateway inbound delivery', () => {
  it('releases failed message reservations and replies when dashboard forwarding fails', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lark-gateway-'))
    const replies: string[] = []
    let sendAttempts = 0
    const transport: ImTransport = {
      async start() {},
      async sendText(_chatId, _threadId, text) {
        sendAttempts += 1
        if (sendAttempts === 1) throw new Error('Lark reply failed')
        replies.push(text)
      },
      async stop() {},
    }
    const config: LarkGatewayConfig = {
      dashboardBaseUrl: 'http://127.0.0.1:1',
      controlTokenPath: path.join(directory, 'missing-control-token'),
      mappingPath: path.join(directory, 'mapping.json'),
      accountsPath: path.join(directory, 'accounts.json'),
    }
    const gateway = new Gateway(config, transport)
    const onMessage = (
      gateway as unknown as { onMessage(message: ImMessage): Promise<void> }
    ).onMessage.bind(gateway)
    const message: ImMessage = {
      chatId: 'chat-123',
      threadId: null,
      userId: 'user-123',
      messageId: 'message-123',
      text: 'please continue',
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await gateway.mapping.bind(message.chatId, '/tmp/session-123.jsonl', 'Lark test session')
      gateway.catalog.upsert(makeSession())

      await expect(onMessage(message)).rejects.toThrow('Lark reply failed')
      await onMessage(message)
      await onMessage(message)

      expect(sendAttempts).toBe(2)
      expect(replies).toEqual(['消息暂时未能送达 Agent，请稍后重试。'])
    } finally {
      logSpy.mockRestore()
      errorSpy.mockRestore()
      await gateway.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
