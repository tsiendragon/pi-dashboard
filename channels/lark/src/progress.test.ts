import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveSessionSummary } from '../../../shared/src/live-sessions.js'
import type { LarkGatewayConfig } from './config.js'
import { Gateway } from './gateway.js'
import { describeTool, formatElapsed } from './progress.js'
import type { ImMessage, ImTransport } from './transport.js'

function makeSession(): LiveSessionSummary {
  return {
    processInstanceId: 'process-123',
    sessionId: 'session-123',
    sessionFile: '/tmp/session-123.jsonl',
    sessionName: 'Progress session',
    pid: 1234,
    cwd: '/tmp/demo',
    canonicalCwd: '/tmp/demo',
    mode: 'rpc',
    model: { provider: 'test', id: 'test-model' },
    status: 'idle',
    claim: { state: 'unclaimed' },
    startedAt: 1,
    lastActivityAt: 1,
    revision: 1,
    eventSequence: 1,
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

function strings(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(strings).join('\n')
  if (value && typeof value === 'object') return Object.values(value).map(strings).join('\n')
  return ''
}

describe('progress helpers', () => {
  it('summarises a tool call by its most telling argument', () => {
    expect(describeTool('bash', { command: 'ls   -la\n/tmp' })).toBe('ls -la /tmp')
    expect(describeTool('read', { path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(describeTool('weird', 42)).toBe('')
    expect(describeTool('bash', { command: 'x'.repeat(200) })).toHaveLength(80)
  })

  it('formats elapsed time', () => {
    expect(formatElapsed(4_200)).toBe('4s')
    expect(formatElapsed(125_000)).toBe('2m05s')
  })
})

describe('Lark progress card', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function makeHarness(options: { cards?: boolean } = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lark-progress-'))
    const log: { op: 'send' | 'update' | 'text'; id: string; card?: unknown; text?: string }[] = []
    let next = 0
    const transport: ImTransport = {
      async start() {},
      async stop() {},
      async sendText(_chatId, _threadId, text) {
        log.push({ op: 'text', id: '', text })
      },
      ...(options.cards === false
        ? {}
        : {
            async sendCard(_chatId: string, _threadId: string | null, card: Record<string, unknown>) {
              next += 1
              log.push({ op: 'send', id: `om_${next}`, card })
              return `om_${next}`
            },
            async updateCard(messageId: string, card: Record<string, unknown>) {
              log.push({ op: 'update', id: messageId, card })
            },
          }),
    }
    const gateway = new Gateway(configFor(directory), transport)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const inputs: string[] = []
    ;(gateway as unknown as { dashboard: { sendInput(id: string, text: string): Promise<void> } }).dashboard.sendInput = async (_id, text) => {
      inputs.push(text)
    }
    await gateway.mapping.bind('chat-a', '/tmp/session-123.jsonl', 'demo')
    gateway.catalog.upsert(makeSession())
    const onMessage = (gateway as unknown as { onMessage(message: ImMessage): Promise<void> }).onMessage.bind(gateway)
    let sequence = 10
    const event = (type: string, data: unknown = {}): Promise<void> =>
      (gateway as unknown as { onFrame(frame: unknown): Promise<void> }).onFrame({
        type: 'live_session_event',
        data: { processInstanceId: 'process-123', sequence: ++sequence, event: { type, data } },
      })
    const answer = (text: string): Promise<void> => event('message_end', { message: { role: 'assistant', content: [{ type: 'text', text }] } })
    /** Let queued sends/patches run. */
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
    }
    return { gateway, log, inputs, onMessage, event, answer, flush }
  }

  it('shows a thinking card at once, tracks tools, then turns that same card into the answer', async () => {
    const h = await makeHarness()
    await h.onMessage({ chatId: 'chat-a', threadId: null, userId: 'u', messageId: 'm1', text: '帮我看看日志' })
    await h.flush()
    expect(h.inputs).toEqual(['帮我看看日志'])
    expect(h.log).toHaveLength(1)
    expect(h.log[0].op).toBe('send')
    expect(strings(h.log[0].card)).toContain('思考中')

    vi.useFakeTimers()
    await h.event('tool_execution_start', { toolCallId: 't1', toolName: 'bash', args: { command: 'tail -n 50 app.log' } })
    await h.event('tool_execution_end', { toolCallId: 't1', toolName: 'bash', isError: false })
    await vi.advanceTimersByTimeAsync(2000)
    vi.useRealTimers()
    await h.flush()
    const patch = h.log.find(entry => entry.op === 'update')
    expect(patch?.id).toBe('om_1')
    expect(strings(patch?.card)).toContain('tail -n 50 app.log')

    await h.answer('日志里有 3 个错误。')
    await h.flush()
    const final = h.log[h.log.length - 1]
    expect(final).toMatchObject({ op: 'update', id: 'om_1' })
    expect(strings(final.card)).toContain('日志里有 3 个错误。')
    expect(strings(final.card)).toContain('执行过程（1 步）')
    // Only one message in the chat for the whole run.
    expect(h.log.filter(entry => entry.op === 'send')).toHaveLength(1)

    await h.event('agent_settled')
    await h.flush()
    expect(h.log[h.log.length - 1]).toBe(final)
  })

  it('marks a run that ended without any answer', async () => {
    const h = await makeHarness()
    await h.onMessage({ chatId: 'chat-a', threadId: null, userId: 'u', messageId: 'm1', text: 'go' })
    await h.flush()
    await h.event('agent_settled')
    await h.flush()
    const last = h.log[h.log.length - 1]
    expect(last).toMatchObject({ op: 'update', id: 'om_1' })
    expect(strings(last.card)).toContain('本轮结束')
  })

  it('does not open a progress card for forwarded slash commands', async () => {
    const h = await makeHarness()
    await h.onMessage({ chatId: 'chat-a', threadId: null, userId: 'u', messageId: 'm1', text: '/clear' })
    await h.flush()
    expect(h.inputs).toEqual(['/clear'])
    expect(h.log).toEqual([])
  })

  it('falls back to plain answers when the transport has no cards', async () => {
    const h = await makeHarness({ cards: false })
    await h.onMessage({ chatId: 'chat-a', threadId: null, userId: 'u', messageId: 'm1', text: 'hi' })
    await h.answer('hello')
    await h.flush()
    expect(h.log).toEqual([{ op: 'text', id: '', text: 'hello' }])
  })

  it('keeps tracking on the same card when a follow-up arrives mid-run', async () => {
    const h = await makeHarness()
    await h.onMessage({ chatId: 'chat-a', threadId: null, userId: 'u', messageId: 'm1', text: 'first' })
    await h.onMessage({ chatId: 'chat-a', threadId: null, userId: 'u', messageId: 'm2', text: 'also this' })
    await h.flush()
    expect(h.inputs).toEqual(['first', 'also this'])
    expect(h.log.filter(entry => entry.op === 'send')).toHaveLength(1)
  })
})
