import { afterEach, describe, expect, it } from 'vitest'
import { LiveSessionRegistry, type LiveSessionTransport } from '../live-sessions/registry.js'
import type { LiveSessionCommandEnvelope } from '../../shared/src/live-sessions.js'

const processId = 'process-a'
const sessionId = 'session-a'
const owner = 'remote-a'
const leaseId = 'lease-a'

function harness(commandTimeoutMs = 100) {
  let now = 1000
  const registry = new LiveSessionRegistry({ now: () => now, commandTimeoutMs })
  const sent: LiveSessionCommandEnvelope[] = []
  const held: LiveSessionCommandEnvelope[] = []
  let hold = false
  const transport: LiveSessionTransport = {
    send(message) {
      if (message.type !== 'command') return
      sent.push(message)
      if (hold) { held.push(message); return }
      queueMicrotask(() => registry.handleCommandResult({
        type: 'command_result', requestId: message.requestId, ok: true,
        result: message.command.type === 'claim' ? { leaseId, expiresAt: now + 10_000 } : { ok: true },
      }, transport))
    },
  }
  const hello = (session = sessionId) => ({
    type: 'hello' as const, protocolVersion: 2 as const, brokerToken: 'token',
    processInstanceId: processId, pid: 4242, cwd: '/tmp', mode: 'tui' as const, sessionId: session,
  })
  const snapshot = (session = sessionId, revision = 1) => ({
    type: 'snapshot' as const, processInstanceId: processId, revision, sequence: 0, entries: [],
    summary: {
      processInstanceId: processId, sessionId: session, pid: 4242, cwd: '/tmp', canonicalCwd: '/tmp',
      mode: 'tui' as const, status: 'idle' as const, claim: { state: 'unclaimed' as const },
      startedAt: 1, lastActivityAt: 1, revision, eventSequence: 0,
    },
  })
  registry.connect(hello(), '/tmp', transport)
  registry.applySnapshot(snapshot(), transport, '/tmp')
  return {
    registry, sent, held, transport, hello, snapshot,
    setNow(value: number) { now = value },
    setHold(value: boolean) { hold = value },
    settle(message: LiveSessionCommandEnvelope) {
      registry.handleCommandResult({ type: 'command_result', requestId: message.requestId, ok: true, result: {} }, transport)
    },
    input(text = 'hello') { return registry.sendRemoteInput(processId, sessionId, owner, leaseId, text) },
    async claim() { await registry.claim(processId, owner, 10_000) },
  }
}

const active = new Set<LiveSessionRegistry>()
afterEach(async () => {
  await Promise.all([...active].map(registry => registry.stop()))
  active.clear()
})
function setup(timeout?: number) {
  const h = harness(timeout)
  active.add(h.registry)
  return h
}

describe('remote Pi input dispatch boundary', () => {
  it('dispatches only mobile text after the exact lease is claimed; local browser input remains lease-free', async () => {
    const h = setup()
    await h.claim()
    await h.input('hello')
    expect(h.sent.at(-1)?.command).toEqual({ type: 'input', text: 'hello', channel: 'mobile' })
    await h.registry.sendBrowserCommand(processId, 'other-browser', { type: 'input', text: '/clear', channel: 'web' })
    expect(h.sent.at(-1)?.command).toEqual({ type: 'input', text: '/clear', channel: 'web' })
  })

  it('rejects no lease, other owner, wrong lease, and expired lease without sending input', async () => {
    const h = setup()
    await expect(h.input()).rejects.toMatchObject({ code: 'invalid_lease' })
    await h.claim()
    await expect(h.registry.sendRemoteInput(processId, sessionId, 'remote-b', leaseId, 'hi')).rejects.toMatchObject({ code: 'invalid_lease' })
    await expect(h.registry.sendRemoteInput(processId, sessionId, owner, 'wrong', 'hi')).rejects.toMatchObject({ code: 'invalid_lease' })
    h.setNow(11_000)
    await expect(h.input()).rejects.toMatchObject({ code: 'invalid_lease' })
    expect(h.sent.filter(message => message.command.type === 'input')).toHaveLength(0)
  })

  it('rejects malformed arguments, empty or oversized UTF-8 text, and slash commands', async () => {
    const h = setup()
    await h.claim()
    for (const text of ['', '  ', '/clear', '  /clear', '界'.repeat(1366)]) {
      await expect(h.input(text)).rejects.toMatchObject({ code: 'invalid_remote_input' })
    }
    await expect(h.registry.sendRemoteInput(processId, sessionId, owner, leaseId, null as unknown as string)).rejects.toMatchObject({ code: 'invalid_remote_input' })
    await expect(h.registry.sendRemoteInput(processId, sessionId, '' as string, leaseId, 'hi')).rejects.toMatchObject({ code: 'invalid_remote_input' })
    await h.input('a'.repeat(4096))
    expect(h.sent.filter(message => message.command.type === 'input')).toHaveLength(1)
  })

  it('rejects the wrong session and a session switched while queued', async () => {
    const h = setup()
    await h.claim()
    await expect(h.registry.sendRemoteInput(processId, 'wrong-session', owner, leaseId, 'hi')).rejects.toMatchObject({ code: 'live_session_unavailable' })
    h.setHold(true)
    const blocker = h.registry.dispatch(processId, { type: 'get_models' })
    await Promise.resolve()
    const queued = h.input()
    h.registry.applySnapshot(h.snapshot('session-b', 1), h.transport, '/tmp')
    h.settle(h.held[0])
    await blocker
    await expect(queued).rejects.toMatchObject({ code: 'live_session_unavailable' })
    expect(h.sent.filter(message => message.command.type === 'input')).toHaveLength(0)
  })

  it('rejects lease expiry or owner change while input waits behind a command', async () => {
    for (const change of ['expiry', 'owner']) {
      const h = setup()
      await h.claim()
      h.setHold(true)
      const blocker = h.registry.dispatch(processId, { type: 'get_models' })
      await Promise.resolve()
      const queued = h.input()
      if (change === 'expiry') h.setNow(11_000)
      else h.registry.applyEvent({ type: 'event', processInstanceId: processId, sequence: 1, event: { type: 'claim_changed', data: { claim: { state: 'unclaimed' } } } }, h.transport)
      h.settle(h.held[0])
      await blocker
      await expect(queued).rejects.toMatchObject({ code: 'invalid_lease' })
      expect(h.sent.filter(message => message.command.type === 'input')).toHaveLength(0)
    }
  })

  it('rejects queued input after connection replacement, even when the same session and lease survive', async () => {
    const h = setup()
    await h.claim()
    h.setHold(true)
    const blocker = h.registry.dispatch(processId, { type: 'get_models' })
    await Promise.resolve()
    const queued = h.input()
    h.registry.connect(h.hello(), '/tmp', h.transport)
    h.registry.applySnapshot(h.snapshot(sessionId, 2), h.transport, '/tmp')
    await expect(blocker).rejects.toMatchObject({ code: 'live_session_reconnected' })
    await expect(queued).rejects.toMatchObject({ code: 'live_session_unavailable' })
    expect(h.sent.filter(message => message.command.type === 'input')).toHaveLength(0)
  })

  it('does not retry non-idempotent input after timeout or late acknowledgement', async () => {
    const h = setup(15)
    await h.claim()
    h.setHold(true)
    const request = h.input()
    await expect(request).rejects.toMatchObject({ code: 'command_timeout' })
    const input = h.sent.filter(message => message.command.type === 'input')
    expect(input).toHaveLength(1)
    h.settle(input[0])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.sent.filter(message => message.command.type === 'input')).toHaveLength(1)
  })
})
