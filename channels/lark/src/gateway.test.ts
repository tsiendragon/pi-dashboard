import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

/** A completed assistant message, i.e. what the gateway forwards to chats. */
function assistantEnd(sequence: number, text: string): unknown {
  return {
    processInstanceId: 'process-123',
    sequence,
    event: { type: 'message_end', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } },
  }
}

function configFor(directory: string): LarkGatewayConfig {
  return {
    dashboardBaseUrl: 'http://127.0.0.1:1',
    controlTokenPath: path.join(directory, 'missing-control-token'),
    mappingPath: path.join(directory, 'mapping.json'),
    accountsPath: path.join(directory, 'accounts.json'),
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

describe('Lark gateway outbound delivery', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  interface Harness {
    gateway: Gateway
    sent: { chatId: string; text: string }[]
    warnings: string[]
    errors: string[]
    frame(type: string, data: unknown): Promise<void>
  }

  async function makeHarness(options: { failFor?: readonly string[] } = {}): Promise<Harness> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lark-gateway-out-'))
    const sent: { chatId: string; text: string }[] = []
    const transport: ImTransport = {
      async start() {},
      async stop() {},
      async sendText(chatId, _threadId, text) {
        if (options.failFor?.includes(chatId)) throw new Error('Lark send failed')
        sent.push({ chatId, text })
      },
    }
    const gateway = new Gateway(configFor(directory), transport)
    const warnings: string[] = []
    const errors: string[] = []
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(String(args[0])) })
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(String(args[0])) })
    const frame = (type: string, data: unknown): Promise<void> =>
      (gateway as unknown as { onFrame(frame: unknown): Promise<void> }).onFrame({ type, data })
    return { gateway, sent, warnings, errors, frame }
  }

  /**
   * Regression for the outage this suite was written for: `live_session_attached`
   * carries a single `LiveSessionDetail` (`{ summary, entries }`) when a session
   * attaches after the socket opened — not `{ sessions: [...] }`. Ignoring that
   * shape left the catalog empty, and every answer of that session was dropped.
   */
  it('learns a session from a single-session attached detail and forwards its replies', async () => {
    const harness = await makeHarness()
    await harness.gateway.mapping.bind('chat-a', '/tmp/session-123.jsonl')

    await harness.frame('live_session_attached', { summary: makeSession(), entries: [], pendingUi: [] })
    await harness.frame('live_session_event', assistantEnd(7, 'progress: 3 of 5'))

    expect(harness.sent).toEqual([{ chatId: 'chat-a', text: 'progress: 3 of 5' }])
  })

  it('still learns sessions from the connect frame with a sessions array', async () => {
    const harness = await makeHarness()
    await harness.gateway.mapping.bind('chat-a', '/tmp/session-123.jsonl')

    await harness.frame('live_session_attached', { sessions: [makeSession()] })
    await harness.frame('live_session_event', assistantEnd(7, 'hello there'))

    expect(harness.sent).toEqual([{ chatId: 'chat-a', text: 'hello there' }])
  })

  it('reports a reply that cannot be routed instead of dropping it silently', async () => {
    const harness = await makeHarness()
    // Bound, but the session never made it into the catalog.
    await harness.gateway.mapping.bind('chat-a', '/tmp/session-123.jsonl')

    await harness.frame('live_session_event', assistantEnd(1, 'nobody is listening'))

    expect(harness.sent).toEqual([])
    expect(harness.warnings.some(line => line.includes('[out] dropped') && line.includes('process-123'))).toBe(true)
  })

  it('keeps delivering to the remaining chats when one send fails', async () => {
    const harness = await makeHarness({ failFor: ['chat-a'] })
    await harness.gateway.mapping.bind('chat-a', '/tmp/session-123.jsonl')
    await harness.gateway.mapping.bind('chat-b', '/tmp/session-123.jsonl')

    await harness.frame('live_session_attached', { sessions: [makeSession()] })
    await harness.frame('live_session_event', assistantEnd(3, 'hello'))

    expect(harness.sent).toEqual([{ chatId: 'chat-b', text: 'hello' }])
    expect(harness.errors.some(line => line.includes('[out] send failed -> chat-a'))).toBe(true)
  })
})
