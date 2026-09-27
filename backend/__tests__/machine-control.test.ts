import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openMachineInputReplay } from '../machine-input-replay.js'
import WebSocket, { WebSocketServer } from 'ws'
import { connectWithTransport, type MachineControl } from '../machine-connector.js'
import { LiveSessionRegistryError } from '../live-sessions/registry.js'

const config = { endpoint: 'wss://example.invalid/machine/v1', machineId: 'm', key: randomBytes(32).toString('base64url') }
const clientId = `remote-${randomBytes(32).toString('base64url')}`
const target = { clientId, processInstanceId: 'proc', sessionId: 'session' }
let dispose: (() => Promise<void>)[] = []
afterEach(async () => { vi.useRealTimers(); for (const fn of dispose.splice(0)) await fn() })

function registry() {
  return {
    get: vi.fn(() => ({ summary: { sessionId: 'session' } })),
    claim: vi.fn(async () => ({ leaseId: 'lease', expiresAt: Date.now() + 30_000 })),
    release: vi.fn(async () => ({ released: true })),
    sendRemoteInput: vi.fn(async () => ({ accepted: true })),
    releaseByBrowser: vi.fn(async () => {}),
  }
}
async function fixture(control = registry(), reserve?: (client: string, id: string) => boolean) {
  const server = createServer()
  const wss = new WebSocketServer({ server })
  let remote!: WebSocket
  wss.on('connection', ws => {
    remote = ws
    ws.send(JSON.stringify({ v: 1, type: 'challenge', nonce: randomBytes(32).toString('base64url'), ts: Date.now() }))
    ws.once('message', () => ws.send(JSON.stringify({ v: 1, type: 'ready', machineId: config.machineId })))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const reserved = new Set<string>()
  const connection = await connectWithTransport(config, (_url, options) => new WebSocket(`ws://127.0.0.1:${port}`, options), () => [], undefined, control as MachineControl,
    reserve ?? ((client, id) => { const key = `${client}:${id}`; if (reserved.has(key)) return false; reserved.add(key); return true }))
  dispose.push(async () => { connection.close(); await connection.closed; remote.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())) })
  const send = (message: unknown): Promise<any> => new Promise(resolve => {
    remote.once('message', bytes => resolve(JSON.parse(bytes.toString())))
    remote.send(typeof message === 'string' ? message : JSON.stringify(message))
  })
  const claim = () => send({ v: 1, type: 'claim_session', requestId: randomUUID(), ...target })
  const input = (requestId = randomUUID()) => ({ v: 1, type: 'send_input', requestId, ...target, leaseId: 'lease', text: 'hello' })
  return { remote, connection, control, send, claim, input }
}

describe('outbound CONTROL', () => {
  it('requires reservation and performs it before any Pi dispatch; failed reservations never dispatch', async () => {
    expect(() => connectWithTransport(config, () => { throw Error('must not connect') }, () => [], undefined, registry())).toThrow('reservation')
    const control = registry()
    const reserve = vi.fn(() => { expect(control.sendRemoteInput).not.toHaveBeenCalled(); throw Error('disk unavailable') })
    const f = await fixture(control, reserve)
    await f.claim()
    expect(await f.send(f.input())).toMatchObject({ ok: false, error: 'indeterminate' })
    expect(reserve).toHaveBeenCalledOnce()
    expect(control.sendRemoteInput).not.toHaveBeenCalled()
  })
  it('rejects a changed-payload replay after reconnect with a reopened durable store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-machine-control-'))
    const path = join(dir, 'machine-input-replay.json')
    const first = openMachineInputReplay(path)
    try {
      const input = { v: 1, type: 'send_input', requestId: randomUUID(), ...target, leaseId: 'lease', text: 'before crash' }
      expect(first.reserve(clientId, input.requestId)).toBe(true) // crash before receiving a result
      first.close()
      const restarted = openMachineInputReplay(path)
      try {
        const control = registry()
        const g = await fixture(control, restarted.reserve)
        await g.claim()
        expect(await g.send({ ...input, text: 'changed after restart' })).toMatchObject({ ok: false, error: 'indeterminate' })
        expect(control.sendRemoteInput).not.toHaveBeenCalled()
      } finally { restarted.close() }
    } finally { first.close(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('keeps a queued input reserved when disconnect aborts it before Pi dispatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-machine-abort-'))
    const path = join(dir, 'machine-input-replay.json')
    const store = openMachineInputReplay(path)
    try {
      const control = registry()
      const reserved = vi.fn(store.reserve)
      const f = await fixture(control, reserved)
      await f.claim()
      let settle!: (value: unknown) => void
      control.release.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
      f.remote.send(JSON.stringify({ v: 1, type: 'release_session', requestId: randomUUID(), ...target, leaseId: 'lease' }))
      await vi.waitFor(() => expect(control.release).toHaveBeenCalledOnce())
      const input = f.input()
      f.remote.send(JSON.stringify(input))
      await vi.waitFor(() => expect(reserved).toHaveBeenCalledWith(clientId, input.requestId))
      f.connection.close()
      settle({ released: true })
      await f.connection.closed
      expect(control.sendRemoteInput).not.toHaveBeenCalled()
      store.close()
      const restarted = openMachineInputReplay(path)
      try { expect(restarted.reserve(clientId, input.requestId)).toBe(false) }
      finally { restarted.close() }
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('retains a reservation even when Pi rejects an input', async () => {
    const control = registry()
    const ids = new Set<string>()
    const f = await fixture(control, (client, id) => {
      const key = `${client}:${id}`
      if (ids.has(key)) return false
      ids.add(key)
      return true
    })
    await f.claim()
    const input = f.input()
    control.sendRemoteInput.mockRejectedValueOnce(new LiveSessionRegistryError('invalid_lease', 'aborted'))
    expect((await f.send(input)).error).toBe('lease_invalid')
    expect((await f.send(input)).error).toBe('indeterminate')
    expect(ids.size).toBe(1)
  })
  it('rejects unknown operation, binary, duplicate keys and unauthorized client without dispatch', async () => {
    const f = await fixture()
    expect((await f.send({ v: 1, type: 'claim_session', requestId: randomUUID(), ...target, clientId: 'remote-invalid' })).error).toBe('invalid_request')
    expect(f.control.claim).not.toHaveBeenCalled()
    f.remote.send(JSON.stringify({ v: 1, type: 'command', requestId: randomUUID() }))
    expect(await f.connection.closed).toBeInstanceOf(Error)
  })
  it('rejects binary and duplicate fields after ready', async () => {
    const f = await fixture()
    f.remote.send(Buffer.from(JSON.stringify({ v: 1, type: 'claim_session', requestId: randomUUID(), ...target })))
    expect(await f.connection.closed).toBeInstanceOf(Error)
    const g = await fixture()
    g.remote.send(`{"v":1,"type":"claim_session","type":"claim_session","requestId":"${randomUUID()}","clientId":"${clientId}","processInstanceId":"proc","sessionId":"session"}`)
    expect(await g.connection.closed).toBeInstanceOf(Error)
  })
  it('enforces target matching, conflicts, lease expiry and narrow success schema', async () => {
    const f = await fixture()
    f.control.get.mockReturnValueOnce({ summary: { sessionId: 'other' } })
    expect((await f.claim()).error).toBe('stale_target')
    expect((await f.send({ v: 1, type: 'release_session', requestId: randomUUID(), ...target, leaseId: 'lease', sessionId: 'other' })).error).toBe('lease_invalid')
    f.control.claim.mockRejectedValueOnce(new LiveSessionRegistryError('session_already_claimed', 'conflict'))
    expect((await f.claim()).error).toBe('conflict')
    const claimed = await f.claim()
    expect(Object.keys(claimed).sort()).toEqual(['expiresAt', 'leaseId', 'ok', 'requestId', 'type', 'v'])
    expect(f.control.claim).toHaveBeenCalledWith('proc', clientId, 30_000)
    f.control.get.mockReturnValueOnce({ summary: { sessionId: 'other' } })
    expect((await f.send({ v: 1, type: 'release_session', requestId: randomUUID(), ...target, leaseId: 'lease' })).error).toBe('stale_target')
    f.control.sendRemoteInput.mockRejectedValueOnce(new LiveSessionRegistryError('invalid_lease', 'expired'))
    expect((await f.send(f.input())).error).toBe('lease_invalid')
    const releaseId = randomUUID()
    expect(await f.send({ v: 1, type: 'release_session', requestId: releaseId, ...target, leaseId: 'lease' })).toEqual({ v: 1, type: 'result', requestId: releaseId, ok: true })
  })
  it('never resends duplicate input even with changed payload, and releases only its remote owner on disconnect', async () => {
    const f = await fixture()
    await f.claim()
    const message = f.input()
    expect(await f.send(message)).toEqual({ v: 1, type: 'result', requestId: message.requestId, ok: true })
    expect(await f.send({ ...message, text: 'different' })).toMatchObject({ ok: false, error: 'indeterminate' })
    expect(f.control.sendRemoteInput).toHaveBeenCalledTimes(1)
    f.remote.close()
    await f.connection.closed
    expect(f.control.releaseByBrowser).toHaveBeenCalledWith(clientId)
    expect(f.control.releaseByBrowser).toHaveBeenCalledTimes(1)
  })
  it('fences queued claim, release and input before dispatch, acks without waiting, and cleans up only its client', async () => {
    const f = await fixture()
    await f.claim()
    let settle!: (value: unknown) => void
    f.control.release.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
    const firstId = randomUUID()
    f.remote.send(JSON.stringify({ v: 1, type: 'release_session', requestId: firstId, ...target, leaseId: 'lease' }))
    await vi.waitFor(() => expect(f.control.release).toHaveBeenCalledOnce())
    const replies = new Map<string, any>()
    f.remote.on('message', bytes => {
      const reply = JSON.parse(bytes.toString())
      replies.set(reply.requestId, reply)
    })
    const queuedClaim = randomUUID()
    const queuedRelease = randomUUID()
    const queuedInput = f.input()
    f.remote.send(JSON.stringify({ v: 1, type: 'claim_session', requestId: queuedClaim, ...target }))
    f.remote.send(JSON.stringify({ v: 1, type: 'release_session', requestId: queuedRelease, ...target, leaseId: 'lease' }))
    f.remote.send(JSON.stringify(queuedInput))
    const revokeId = randomUUID()
    f.remote.send(JSON.stringify({ v: 1, type: 'revoke_client', requestId: revokeId, clientId }))
    await vi.waitFor(() => expect(replies.get(revokeId)).toEqual({ v: 1, type: 'result', requestId: revokeId, ok: true }))
    expect(f.control.releaseByBrowser).not.toHaveBeenCalled()
    expect(f.control.sendRemoteInput).not.toHaveBeenCalled()
    settle({ released: true })
    await vi.waitFor(() => expect(replies.get(queuedInput.requestId)).toMatchObject({ ok: false, error: 'indeterminate' }))
    expect(replies.get(queuedClaim)).toMatchObject({ ok: false, error: 'lease_invalid' })
    expect(replies.get(queuedRelease)).toMatchObject({ ok: false, error: 'lease_invalid' })
    expect(f.control.claim).toHaveBeenCalledTimes(1)
    expect(f.control.release).toHaveBeenCalledTimes(1)
    expect(f.control.sendRemoteInput).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(f.control.releaseByBrowser).toHaveBeenCalledExactlyOnceWith(clientId))
    expect((await f.send(f.input())).error).toBe('indeterminate')
    expect(f.control.sendRemoteInput).not.toHaveBeenCalled()
  })
  it('rejects malformed, unknown, binary and duplicate revocations without revoking a client', async () => {
    const bad = [
      { v: 1, type: 'revoke_client', requestId: randomUUID(), clientId: 'remote-invalid' },
      { v: 1, type: 'revoke_client', requestId: randomUUID(), clientId, extra: true },
      { v: 1, type: 'revoke_client', requestId: 'bad', clientId },
      { v: 1, type: 'revoke_client', requestId: randomUUID(), clientId: `remote-${'A'.repeat(42)}!` },
      { v: 1, type: 'unknown_revoke', requestId: randomUUID(), clientId },
      Buffer.from(JSON.stringify({ v: 1, type: 'revoke_client', requestId: randomUUID(), clientId })),
      `{"v":1,"type":"revoke_client","requestId":"${randomUUID()}","clientId":"${clientId}","clientId":"${clientId}"}`,
    ]
    for (const message of bad) {
      const f = await fixture()
      f.remote.send(typeof message === 'string' || Buffer.isBuffer(message) ? message : JSON.stringify(message))
      expect(await f.connection.closed).toBeInstanceOf(Error)
      expect(f.control.releaseByBrowser).not.toHaveBeenCalled()
      expect(f.control.claim).not.toHaveBeenCalled()
    }
  })
  it('releases a claim that completes after the revocation ack', async () => {
    const f = await fixture()
    let settle!: (value: unknown) => void
    f.control.claim.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
    f.remote.send(JSON.stringify({ v: 1, type: 'claim_session', requestId: randomUUID(), ...target }))
    await vi.waitFor(() => expect(f.control.claim).toHaveBeenCalledOnce())
    const requestId = randomUUID()
    expect(await f.send({ v: 1, type: 'revoke_client', requestId, clientId })).toEqual({ v: 1, type: 'result', requestId, ok: true })
    expect(f.control.releaseByBrowser).not.toHaveBeenCalled()
    settle({ leaseId: 'lease', expiresAt: Date.now() + 30_000 })
    await vi.waitFor(() => expect(f.control.releaseByBrowser).toHaveBeenCalledExactlyOnceWith(clientId))
    expect((await f.send(f.input())).error).toBe('indeterminate')
  })
  it('does not release a different client on revocation', async () => {
    const f = await fixture()
    await f.claim()
    const other = `remote-${randomBytes(32).toString('base64url')}`
    const requestId = randomUUID()
    expect(await f.send({ v: 1, type: 'revoke_client', requestId, clientId: other })).toEqual({ v: 1, type: 'result', requestId, ok: true })
    expect(f.control.releaseByBrowser).not.toHaveBeenCalled()
    expect((await f.send(f.input())).ok).toBe(true)
  })
  it('returns indeterminate on timeout and does not retry or dispatch subsequent work while uncertain', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = await fixture()
    await f.claim()
    let settle!: (value: unknown) => void
    f.control.sendRemoteInput.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
    const first = f.send(f.input())
    await vi.waitFor(() => expect(f.control.sendRemoteInput).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(12_000)
    expect(await first).toMatchObject({ ok: false, error: 'indeterminate' })
    const second = f.send(f.input())
    expect(f.control.sendRemoteInput).toHaveBeenCalledTimes(1)
    settle({ accepted: true })
    expect(await second).toMatchObject({ ok: true })
  })
})
