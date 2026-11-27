import { afterEach, describe, expect, it } from 'vitest'
import { LiveSessionRegistry, type LiveSessionTransport } from '../live-sessions/registry.js'
import { compactBrowserMessage, compactDetail } from '../live-sessions/compact.js'
import type { LiveSessionEventMessage } from '../../shared/src/live-sessions.js'

function turnEndEvent() {
  return {
    type: 'turn_end',
    data: {
      turnIndex: 7,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'turn complete' }],
      },
      toolResults: [{ toolCallId: 'call-1', toolName: 'bash', isError: false }],
      context: {
        contextEntries: [
          { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'large context entry' }] } },
        ],
        contextMessages: [{ role: 'user', content: [{ type: 'text', text: 'large context message' }] }],
        llmMessages: [{ role: 'user', content: 'large llm message' }],
        pendingMessages: [],
        canContinue: true,
      },
    },
  }
}

const registries: LiveSessionRegistry[] = []
afterEach(async () => {
  await Promise.all(registries.splice(0).map(registry => registry.stop()))
})

function attachedRegistry() {
  const registry = new LiveSessionRegistry({
    commandTimeoutMs: 1_000,
    goalFileSyncIntervalMs: 0,
    resyncRetryIntervalMs: 0,
  })
  registries.push(registry)
  const transport: LiveSessionTransport = { send() {} }
  registry.connect({
    type: 'hello', protocolVersion: 2, brokerToken: 'token',
    processInstanceId: 'process-a', pid: 4242, cwd: '/tmp/root/task',
    mode: 'tui', sessionId: 'session-a',
  }, '/tmp/root/task', transport)
  registry.applySnapshot({
    type: 'snapshot', processInstanceId: 'process-a', revision: 1, sequence: 0,
    summary: {
      processInstanceId: 'process-a', sessionId: 'session-a', pid: 4242,
      cwd: '/tmp/root/task', canonicalCwd: '/tmp/root/task', mode: 'tui',
      status: 'idle', claim: { state: 'unclaimed' }, startedAt: 1,
      lastActivityAt: 2, revision: 1, eventSequence: 0,
    },
    entries: [],
  }, transport, '/tmp/root/task')
  return { registry, transport }
}

function apply(registry: LiveSessionRegistry, transport: LiveSessionTransport, event: unknown): void {
  registry.applyEvent({
    type: 'event', processInstanceId: 'process-a', sequence: 1,
    event: event as { type: string; data?: unknown },
  }, transport)
}

describe('turn_end context stripping', () => {
  it('strips registry turn_end context but retains its activity-boundary payload', () => {
    const { registry, transport } = attachedRegistry()
    apply(registry, transport, turnEndEvent())

    const stored = registry.get('process-a')?.entries[0] as ReturnType<typeof turnEndEvent>
    expect(stored.type).toBe('turn_end')
    expect(stored.data.context).toBeUndefined()
    expect(stored.data.turnIndex).toBe(7)
    expect(stored.data.message).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'turn complete' }],
    })
    expect(stored.data.toolResults).toEqual([{ toolCallId: 'call-1', toolName: 'bash', isError: false }])
  })

  it('strips turn_end context from compactDetail and compactBrowserMessage', () => {
    const detail = compactDetail({ entries: [turnEndEvent()] }) as { entries: ReturnType<typeof turnEndEvent>[] }
    expect(detail.entries[0].data.context).toBeUndefined()
    expect(detail.entries[0].data.turnIndex).toBe(7)
    expect(detail.entries[0].data.message.content[0].text).toBe('turn complete')
    expect(detail.entries[0].data.toolResults[0].toolCallId).toBe('call-1')

    const message = compactBrowserMessage({
      type: 'live_session_event',
      data: { processInstanceId: 'process-a', event: turnEndEvent() },
    }) as { data: { event: ReturnType<typeof turnEndEvent> } }
    expect(message.data.event.data.context).toBeUndefined()
    expect(message.data.event.data.turnIndex).toBe(7)
    expect(message.data.event.data.message.content[0].text).toBe('turn complete')
    expect(message.data.event.data.toolResults[0].toolCallId).toBe('call-1')
  })

  it('does not mutate source events in the registry or compact projections', () => {
    const { registry, transport } = attachedRegistry()
    const registryEvent = turnEndEvent()
    const registryData = registryEvent.data
    const registryContext = registryEvent.data.context
    apply(registry, transport, registryEvent)
    expect(registryEvent.data).toBe(registryData)
    expect(registryEvent.data.context).toBe(registryContext)
    expect(registryEvent.data.context.contextEntries).toHaveLength(1)

    const compactEvent = turnEndEvent()
    const compactSnapshot = structuredClone(compactEvent)
    compactDetail({ entries: [compactEvent] })
    compactBrowserMessage({ type: 'live_session_event', data: { event: compactEvent } })
    expect(compactEvent).toEqual(compactSnapshot)
  })

  it('leaves non-turn_end events unchanged', () => {
    const { registry, transport } = attachedRegistry()
    const event = {
      type: 'message_end',
      data: {
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        context: { marker: 'only turn_end owns this field' },
      },
    }
    apply(registry, transport, event)
    expect(registry.get('process-a')?.entries[0]).toEqual(event)

    const message = compactBrowserMessage({
      type: 'live_session_event',
      data: { processInstanceId: 'process-a', event },
    })
    expect(message).toEqual({
      type: 'live_session_event',
      data: { processInstanceId: 'process-a', event },
    })
  })

  it('strips turn_end context from the live event broadcast without mutating the input message', () => {
    const { registry, transport } = attachedRegistry()
    const event = turnEndEvent()
    const input: LiveSessionEventMessage = {
      type: 'event', processInstanceId: 'process-a', sequence: 1, event,
    }
    const emitted: LiveSessionEventMessage[] = []
    registry.on('event', (message: LiveSessionEventMessage) => emitted.push(message))

    expect(registry.applyEvent(input, transport)).toBe(true)

    expect(emitted).toHaveLength(1)
    const broadcast = emitted[0]!
    const data = broadcast.event.data as ReturnType<typeof turnEndEvent>['data']
    expect(broadcast).not.toBe(input)
    expect(broadcast.type).toBe('event')
    expect(broadcast.processInstanceId).toBe('process-a')
    expect(broadcast.sequence).toBe(1)
    expect(data.context).toBeUndefined()
    expect(data.turnIndex).toBe(7)
    expect(data.toolResults).toEqual(event.data.toolResults)
    expect(data.message).toEqual(event.data.message)
    expect(registry.get('process-a')?.entries[0]).toBe(broadcast.event)
    expect(input.event).toBe(event)
    expect(event.data.context).toBeDefined()
  })

  it('reuses an already slim turn_end event without losing fields', () => {
    const { registry, transport } = attachedRegistry()
    const emitted: LiveSessionEventMessage[] = []
    registry.on('event', (message: LiveSessionEventMessage) => emitted.push(message))
    apply(registry, transport, turnEndEvent())
    const slimEvent = emitted[0]!.event

    expect(registry.applyEvent({
      type: 'event', processInstanceId: 'process-a', sequence: 2, event: slimEvent,
    }, transport)).toBe(true)

    const broadcast = emitted[1]!
    const data = broadcast.event.data as ReturnType<typeof turnEndEvent>['data']
    expect(broadcast.event).toBe(slimEvent)
    expect(broadcast.sequence).toBe(2)
    expect(data.context).toBeUndefined()
    expect(data.turnIndex).toBe(7)
    expect(data.toolResults).toEqual([{ toolCallId: 'call-1', toolName: 'bash', isError: false }])
    expect(data.message).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'turn complete' }],
    })
  })

  it('broadcasts non-turn_end events unchanged', () => {
    const { registry, transport } = attachedRegistry()
    const event = {
      type: 'message_end',
      data: {
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        context: { marker: 'only turn_end owns this field' },
      },
    }
    const input: LiveSessionEventMessage = {
      type: 'event', processInstanceId: 'process-a', sequence: 1, event,
    }
    const emitted: LiveSessionEventMessage[] = []
    registry.on('event', (message: LiveSessionEventMessage) => emitted.push(message))

    expect(registry.applyEvent(input, transport)).toBe(true)

    expect(emitted).toEqual([input])
    expect(emitted[0]).toBe(input)
    expect(emitted[0]!.event).toBe(event)
    expect(emitted[0]!.event.data).toBe(event.data)
  })
})
