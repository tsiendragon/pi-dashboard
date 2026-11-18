import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveSessionSummary } from '../../../shared/src/live-sessions.js'
import type { LarkGatewayConfig } from './config.js'
import { dialogCard, dialogMethodOf, needsTextAnswer } from './dialogs.js'
import { Gateway } from './gateway.js'
import type { CardAction, ImMessage, ImTransport } from './transport.js'

function makeSession(): LiveSessionSummary {
  return {
    processInstanceId: 'process-123',
    sessionId: 'session-123',
    sessionFile: '/tmp/session-123.jsonl',
    sessionName: 'Dialog session',
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

/** Callback payloads of every button in a card. */
function buttonPayloads(value: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    if (record.type === 'callback' && record.value && typeof record.value === 'object') found.push(record.value as Record<string, unknown>)
    Object.values(record).forEach(walk)
  }
  walk(value)
  return found
}

describe('dialog helpers', () => {
  it('recognises the four extension UI methods only', () => {
    expect(dialogMethodOf('select')).toBe('select')
    expect(dialogMethodOf('editor')).toBe('editor')
    expect(dialogMethodOf('banana')).toBeUndefined()
    expect(needsTextAnswer('input')).toBe(true)
    expect(needsTextAnswer('select')).toBe(false)
  })

  it('renders select options as buttons that carry the request id', () => {
    const card = dialogCard({ id: 'ui-1', method: 'select', title: 'Review goal', options: ['Start', 'Edit', 'Cancel'] }, 'open')
    expect(buttonPayloads(card)).toEqual([
      { ui: 'ui-1', value: 'Start' },
      { ui: 'ui-1', value: 'Edit' },
      { ui: 'ui-1', value: 'Cancel' },
      { ui: 'ui-1', cancel: true },
    ])
  })

  it('renders a settled dialog without buttons', () => {
    const card = dialogCard({ id: 'ui-1', method: 'confirm', title: 'Run it?' }, 'answered', 'true')
    expect(buttonPayloads(card)).toEqual([])
    expect(strings(card)).toContain('已回答')
  })

  it('shows that an input dialog is answered by replying in the chat', () => {
    const card = dialogCard({ id: 'ui-2', method: 'input', title: 'Your name?' }, 'open')
    expect(strings(card)).toContain('直接在本聊天里回复')
    expect(buttonPayloads(card)).toEqual([{ ui: 'ui-2', cancel: true }])
  })
})

describe('Lark extension dialogs', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function makeHarness(options: { cards?: boolean; allowed?: string[] } = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lark-dialogs-'))
    const sends: { scope: string; card: unknown }[] = []
    const updates: { id: string; card: unknown }[] = []
    const texts: string[] = []
    let next = 0
    let clickHandler: ((action: CardAction) => void) | undefined
    const transport: ImTransport = {
      async start(_onMessage, _onBotAdded, onCardAction) {
        clickHandler = onCardAction
      },
      async stop() {},
      async sendText(_chatId, _threadId, text) {
        texts.push(text)
      },
      ...(options.cards === false
        ? {}
        : {
            async sendCard(_chatId: string, threadId: string | null, card: Record<string, unknown>) {
              next += 1
              sends.push({ scope: threadId ? `#${threadId}` : '', card })
              return `om_${next}`
            },
            async updateCard(messageId: string, card: Record<string, unknown>) {
              updates.push({ id: messageId, card })
            },
          }),
    }
    const gateway = new Gateway(configFor(directory), transport, options.allowed)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const inputs: string[] = []
    const answers: { id: string; value: string }[] = []
    const stub = (gateway as unknown as { dashboard: Record<string, unknown> }).dashboard
    stub.sendInput = async (_id: string, text: string) => {
      inputs.push(text)
    }
    stub.answerUi = async (_pid: string, id: string, answer: { value?: string; cancelled?: boolean }) => {
      answers.push({ id, value: answer.cancelled ? '(cancel)' : (answer.value ?? '') })
      return { accepted: true }
    }
    // Register the click handler the way Gateway.start() does, without opening a
    // real dashboard connection.
    await transport.start(async () => {}, undefined, action => (gateway as unknown as { onCardAction(a: CardAction): void }).onCardAction(action))
    await gateway.mapping.bind('chat-a', '/tmp/session-123.jsonl', 'demo')
    gateway.catalog.upsert(makeSession())

    const onMessage = (gateway as unknown as { onMessage(m: ImMessage): Promise<void> }).onMessage.bind(gateway)
    let sequence = 10
    const event = (type: string, data: unknown = {}): Promise<void> =>
      (gateway as unknown as { onFrame(f: unknown): Promise<void> }).onFrame({
        type: 'live_session_event',
        data: { processInstanceId: 'process-123', sequence: ++sequence, event: { type, data } },
      })
    const snapshot = (pendingUi: unknown[]): Promise<void> =>
      (gateway as unknown as { onFrame(f: unknown): Promise<void> }).onFrame({
        type: 'live_session_snapshot',
        data: { summary: makeSession(), entries: [], pendingUi },
      })
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve))
    }
    return { gateway, sends, updates, texts, inputs, answers, onMessage, event, snapshot, flush, click: (a: CardAction) => clickHandler?.(a) }
  }

  const selectDialog = (id = 'ui-goal') => ({
    id,
    method: 'select',
    title: 'Review generated goal proposal',
    options: ['Start', 'Edit', 'Cancel'],
  })

  it('shows a dialog as a card that can be answered from the chat', async () => {
    const h = await makeHarness()
    await h.event('extension_ui', selectDialog())
    await h.flush()
    expect(h.sends).toHaveLength(1)
    expect(strings(h.sends[0].card)).toContain('Review generated goal proposal')

    h.click({ chatId: 'chat-a', userId: 'u', messageId: 'om_1', answer: { id: 'ui-goal', value: 'Start' } })
    await h.flush()
    expect(h.answers).toEqual([{ id: 'ui-goal', value: 'Start' }])
    // Same card tells you what was chosen instead of leaving stale buttons.
    expect(h.updates.at(-1)).toMatchObject({ id: 'om_1' })
    expect(strings(h.updates.at(-1)?.card)).toContain('已回答')
    expect(buttonPayloads(h.updates.at(-1)?.card)).toEqual([])
  })

  it('answers a confirmation with value "true" and a cancel with cancelled', async () => {
    const h = await makeHarness()
    await h.event('extension_ui', { id: 'ui-confirm', method: 'confirm', title: 'Allow rm -rf?', message: 'This deletes files.' })
    await h.flush()
    expect(buttonPayloads(h.sends[0].card)).toEqual([{ ui: 'ui-confirm', value: 'true' }, { ui: 'ui-confirm', cancel: true }])

    h.click({ chatId: 'chat-a', userId: 'u', messageId: 'om_1', answer: { id: 'ui-confirm', cancelled: true } })
    await h.flush()
    expect(h.answers).toEqual([{ id: 'ui-confirm', value: '(cancel)' }])
  })

  it('shows one card per dialog even when the request is replayed', async () => {
    const h = await makeHarness()
    await h.event('extension_ui', selectDialog())
    await h.event('extension_ui', selectDialog())
    await h.snapshot([selectDialog()])
    await h.flush()
    expect(h.sends).toHaveLength(1)
  })

  it('restores an unanswered dialog from the session snapshot after a reconnect', async () => {
    const h = await makeHarness()
    await h.snapshot([selectDialog('ui-restored')])
    await h.flush()
    expect(h.sends).toHaveLength(1)
    expect(buttonPayloads(h.sends[0].card)).toContainEqual({ ui: 'ui-restored', value: 'Start' })
  })

  it('folds the card when the dialog is answered elsewhere', async () => {
    const h = await makeHarness()
    await h.event('extension_ui', selectDialog())
    await h.flush()
    await h.event('extension_ui_closed', { id: 'ui-goal' })
    await h.flush()
    expect(strings(h.updates.at(-1)?.card)).toContain('已在其它端处理')
    expect(buttonPayloads(h.updates.at(-1)?.card)).toEqual([])
  })

  it('takes the next chat message as the answer to an input dialog', async () => {
    const h = await makeHarness()
    await h.event('extension_ui', { id: 'ui-name', method: 'input', title: '给我一个分支名' })
    await h.flush()

    await h.onMessage({ chatId: 'chat-a', threadId: null, userId: 'u', messageId: 'm1', text: 'feat/lark-dialogs' })
    await h.flush()
    expect(h.answers).toEqual([{ id: 'ui-name', value: 'feat/lark-dialogs' }])
    // It answered the dialog instead of starting a new agent turn.
    expect(h.inputs).toEqual([])
  })

  it('still forwards slash commands while an input dialog is open', async () => {
    const h = await makeHarness()
    await h.event('extension_ui', { id: 'ui-name', method: 'input', title: '给我一个分支名' })
    await h.flush()

    await h.onMessage({ chatId: 'chat-a', threadId: null, userId: 'u', messageId: 'm1', text: '/context' })
    await h.flush()
    expect(h.answers).toEqual([])
    expect(h.inputs).toEqual([])
  })

  it('ignores clicks from users outside the allow-list', async () => {
    const h = await makeHarness({ allowed: ['u'] })
    await h.event('extension_ui', selectDialog())
    await h.flush()
    h.click({ chatId: 'chat-a', userId: 'stranger', messageId: 'om_1', answer: { id: 'ui-goal', value: 'Start' } })
    await h.flush()
    expect(h.answers).toEqual([])
  })

  it('explains a click on a dialog that has already expired', async () => {
    const h = await makeHarness()
    h.click({ chatId: 'chat-a', userId: 'u', messageId: 'om_unknown', answer: { id: 'ui-gone', value: 'Start' } })
    await h.flush()
    expect(h.answers).toEqual([])
    expect(h.sends.some(entry => strings(entry.card).includes('已经失效'))).toBe(true)
  })

  it('reminds the chat once when a dialog stays unanswered', async () => {
    const h = await makeHarness()
    vi.useFakeTimers()
    await h.event('extension_ui', selectDialog())
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    vi.useRealTimers()
    await h.flush()
    expect(h.sends.filter(entry => strings(entry.card).includes('还在等你回答'))).toHaveLength(1)
  })
})