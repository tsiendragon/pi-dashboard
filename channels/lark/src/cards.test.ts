import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveSessionSummary } from '../../../shared/src/live-sessions.js'
import { button, escapeMarkdown, inline } from './cards.js'
import type { LarkGatewayConfig } from './config.js'
import { Gateway } from './gateway.js'
import { parseCardAction } from './larkTransport.js'
import type { CardAction, ImMessage, ImTransport } from './transport.js'

function makeSession(): LiveSessionSummary {
  return {
    processInstanceId: 'process-123',
    sessionId: 'session-123',
    sessionFile: '/tmp/session-123.jsonl',
    sessionName: 'Lark card session',
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

/** Every string inside a card, so tests can assert on what the user sees. */
function cardStrings(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(cardStrings).join('\n')
  if (value && typeof value === 'object') return Object.values(value).map(cardStrings).join('\n')
  return ''
}

/** Commands bound to the card's buttons. */
function cardCommands(value: unknown): string[] {
  const found: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    if (record.type === 'callback' && record.value && typeof (record.value as { cmd?: unknown }).cmd === 'string') {
      found.push((record.value as { cmd: string }).cmd)
    }
    Object.values(record).forEach(walk)
  }
  walk(value)
  return found
}

describe('card markdown escaping', () => {
  it('neutralises angle brackets outside code but keeps code verbatim', () => {
    const out = escapeMarkdown('List<T> and a < b\n`Map<K, V>`\n```ts\nconst x: Array<number> = []\n```')
    expect(out).toContain('List&#60;T&#62;')
    expect(out).toContain('a &#60; b')
    expect(out).toContain('`Map<K, V>`')
    expect(out).toContain('const x: Array<number> = []')
  })

  it('escapes markdown syntax inside our own inline labels', () => {
    expect(inline('feat/*wip*_[x]')).toBe('feat/\\*wip\\*\\_\\[x\\]')
  })

  it('binds a button to its command as a callback value', () => {
    expect(button({ text: '绑定', command: '/bind 2' })).toMatchObject({
      tag: 'button',
      behaviors: [{ type: 'callback', value: { cmd: '/bind 2' } }],
    })
  })
})

describe('parseCardAction', () => {
  it('reads a card.action.trigger v2 callback', () => {
    expect(
      parseCardAction({
        event_id: 'ev_1',
        operator: { open_id: 'ou_1' },
        action: { tag: 'button', value: { cmd: '/list' } },
        context: { open_message_id: 'om_1', open_chat_id: 'oc_1' },
      }),
    ).toEqual({ chatId: 'oc_1', messageId: 'om_1', userId: 'ou_1', command: '/list', eventId: 'ev_1' })
  })

  it('ignores clicks that do not carry a slash command', () => {
    expect(parseCardAction({ action: { value: { cmd: 'rm -rf' } }, context: { open_message_id: 'om', open_chat_id: 'oc' } })).toBeUndefined()
    expect(parseCardAction({ action: { value: {} }, context: { open_message_id: 'om', open_chat_id: 'oc' } })).toBeUndefined()
  })
})

describe('Lark gateway cards', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  interface CardHarness {
    gateway: Gateway
    cards: { chatId: string; threadId: string | null; card: Record<string, unknown>; anchor?: string }[]
    texts: string[]
    onMessage(message: ImMessage): Promise<void>
    click(action: CardAction): void
    frame(type: string, data: unknown): Promise<void>
  }

  async function makeHarness(options: { rejectCards?: boolean; allowed?: string[] } = {}): Promise<CardHarness> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lark-cards-'))
    const cards: CardHarness['cards'] = []
    const texts: string[] = []
    let clickHandler: ((action: CardAction) => void) | undefined
    let next = 0
    const transport: ImTransport = {
      async start(_onMessage, _onBotAdded, onCardAction) {
        clickHandler = onCardAction
      },
      async stop() {},
      async sendText(_chatId, _threadId, text) {
        texts.push(text)
      },
      async sendCard(chatId, threadId, card, anchor) {
        if (options.rejectCards) throw new Error('card rejected: 230099 bad card')
        cards.push({ chatId, threadId, card, anchor })
        next += 1
        return `om_card_${next}`
      },
    }
    const gateway = new Gateway(configFor(directory), transport, options.allowed)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Wire the click handler without a live dashboard: start() would try to connect.
    await transport.start(async () => {}, undefined, action => (gateway as unknown as { onCardAction(a: CardAction): void }).onCardAction(action))
    const onMessage = (gateway as unknown as { onMessage(message: ImMessage): Promise<void> }).onMessage.bind(gateway)
    const frame = (type: string, data: unknown): Promise<void> =>
      (gateway as unknown as { onFrame(frame: unknown): Promise<void> }).onFrame({ type, data })
    return { gateway, cards, texts, onMessage, click: action => clickHandler?.(action), frame }
  }

  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20))

  it('answers /help with a card whose buttons run commands', async () => {
    const harness = await makeHarness()
    await harness.onMessage({ chatId: 'chat-a', threadId: null, userId: 'u', messageId: 'om_1', text: '/help' })

    expect(harness.texts).toEqual([])
    expect(harness.cards).toHaveLength(1)
    const commands = cardCommands(harness.cards[0].card)
    expect(commands).toEqual(expect.arrayContaining(['/list', '/status', '/context', '/compact', '/abort']))
  })

  it('renders an assistant answer as a card titled with the session', async () => {
    const harness = await makeHarness()
    await harness.gateway.mapping.bind('chat-a', '/tmp/session-123.jsonl', 'demo')
    await harness.frame('live_session_attached', { sessions: [makeSession()] })
    await harness.frame('live_session_event', {
      processInstanceId: 'process-123',
      sequence: 5,
      event: { type: 'message_end', data: { message: { role: 'assistant', content: [{ type: 'text', text: '**done** with List<T>' }] } } },
    })

    expect(harness.cards).toHaveLength(1)
    const shown = cardStrings(harness.cards[0].card)
    expect(shown).toContain('Lark card session')
    expect(shown).toContain('**done** with List&#60;T&#62;')
  })

  it('falls back to plain text when Lark rejects the card', async () => {
    const harness = await makeHarness({ rejectCards: true })
    await harness.onMessage({ chatId: 'chat-a', threadId: null, userId: 'u', messageId: 'om_1', text: '/status' })

    expect(harness.texts).toEqual(['当前未绑定会话。用 /list 和 /bind 绑定。'])
  })

  it('runs a clicked button as the command, in the thread the card was sent to', async () => {
    const harness = await makeHarness()
    await harness.onMessage({ chatId: 'chat-a', threadId: 'omt_9', userId: 'u', messageId: 'om_1', text: '/help' })
    const sent = harness.cards[0]
    expect(sent.threadId).toBe('omt_9')

    harness.click({ chatId: 'chat-a', userId: 'u', messageId: 'om_card_1', command: '/status', eventId: 'ev_1' })
    await settle()

    expect(harness.cards).toHaveLength(2)
    expect(harness.cards[1].threadId).toBe('omt_9')
    expect(cardStrings(harness.cards[1].card)).toContain('未绑定会话')
  })

  it('drops a redelivered click and clicks from users outside the allow-list', async () => {
    const harness = await makeHarness({ allowed: ['u'] })
    harness.click({ chatId: 'chat-a', userId: 'u', messageId: 'om_x', command: '/help', eventId: 'ev_dup' })
    harness.click({ chatId: 'chat-a', userId: 'u', messageId: 'om_x', command: '/help', eventId: 'ev_dup' })
    harness.click({ chatId: 'chat-a', userId: 'stranger', messageId: 'om_x', command: '/help', eventId: 'ev_2' })
    await settle()

    expect(harness.cards).toHaveLength(1)
  })

  it('offers bind buttons in /list and an unbind button for the bound session', async () => {
    const harness = await makeHarness()
    const other = { ...makeSession(), processInstanceId: 'process-456', sessionFile: '/tmp/session-456.jsonl', sessionName: 'Other', startedAt: 2 }
    harness.gateway.catalog.upsert(makeSession())
    harness.gateway.catalog.upsert(other)
    await harness.gateway.mapping.bind('chat-a', '/tmp/session-123.jsonl', 'demo')
    // `/list` refreshes from the dashboard; offline here, so it answers from the catalog.
    await harness.onMessage({ chatId: 'chat-a', threadId: null, userId: 'u', messageId: 'om_1', text: '/list' })

    const commands = cardCommands(harness.cards[0].card)
    expect(commands).toContain('/unbind')
    expect(commands).toContain('/bind 2')
    expect(commands).not.toContain('/bind 1')
  })
})
