import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, chmod, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { connectWithTransport, projectSessions, type SessionRow, type MachineConnection } from '../machine-connector.js'
import { readMachineConfig, startMachineOutbound } from '../machine-session-outbound.js'

const config = { endpoint: 'wss://example.invalid/machine/v1', machineId: 'test', key: randomBytes(32).toString('base64url') }
const id = randomUUID()
let cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn() })

async function peer(list: () => readonly SessionRow[]) {
  const server = createServer()
  const wss = new WebSocketServer({ server })
  let remote!: WebSocket
  let ready!: () => void
  const readyPromise = new Promise<void>(resolve => { ready = resolve })
  wss.on('connection', ws => {
    remote = ws
    ws.send(JSON.stringify({ v: 1, type: 'challenge', nonce: randomBytes(32).toString('base64url'), ts: Date.now() }))
    ws.once('message', () => { ws.send(JSON.stringify({ v: 1, type: 'ready', machineId: config.machineId })); ready() })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const connection = await connectWithTransport(config, (_url, options) => new WebSocket(`ws://127.0.0.1:${port}`, options), list)
  await readyPromise
  cleanup.push(async () => { connection.close(); remote.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { remote, connection }
}

const row = { processInstanceId: 'abc-123', sessionId: 'session_1', status: 'running' as const, cwd: '/secret/path', pid: 222, model: 'private', claim: 'mine' }

describe('read-only outbound session listing', () => {
  it('projects only approved fields, max 50, and drops unsafe IDs', async () => {
    expect(projectSessions(() => [row, { ...row, processInstanceId: '/secret' }, ...Array(70).fill(row)])).toHaveLength(49)
    const { remote, connection } = await peer(() => [row])
    const response = new Promise<string>(resolve => remote.once('message', bytes => resolve(bytes.toString())))
    remote.send(JSON.stringify({ v: 1, type: 'list_sessions', requestId: id }))
    const text = await response
    expect(JSON.parse(text)).toEqual({ v: 1, type: 'sessions', requestId: id, sessions: [{ processInstanceId: 'abc-123', sessionId: 'session_1', status: 'running' }] })
    expect(text).not.toMatch(/secret|pid|model|claim|cwd|filename|transcript/)
    expect(await Promise.race([connection.closed.then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('open'), 20))])).toBe('open')
  })

  for (const [name, message] of [
    ['spoofed type', JSON.stringify({ v: 1, type: 'command', requestId: id })],
    ['unknown field', JSON.stringify({ v: 1, type: 'list_sessions', requestId: id, cwd: '/private' })],
    ['duplicate field', `{"v":1,"type":"list_sessions","requestId":"${id}","type":"list_sessions"}`],
    ['escaped duplicate', `{"v":1,"type":"list_sessions","requestId":"${id}","typ\\u0065":"list_sessions"}`],
    ['bad request id', '{"v":1,"type":"list_sessions","requestId":"not-a-uuid"}'],
    ['oversize', ' '.repeat(16385)],
  ] as const) {
    it(`rejects ${name}`, async () => {
      const { remote, connection } = await peer(() => [row])
      remote.send(message)
      expect(await connection.closed).toBeInstanceOf(Error)
    })
  }
  it('rejects binary and invalid UTF8', async () => {
    for (const payload of [Buffer.from([0xff]), Buffer.from(JSON.stringify({ v: 1, type: 'list_sessions', requestId: id }))]) {
      const { remote, connection } = await peer(() => [row])
      remote.send(payload)
      expect(await connection.closed).toBeInstanceOf(Error)
    }
  })

  it('requires a private regular config, disallows symlinks and unknown keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machine-test-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const file = join(dir, 'config.json')
    expect(await readMachineConfig(file)).toBeUndefined()
    await writeFile(file, JSON.stringify(config), { mode: 0o600 })
    expect(await readMachineConfig(file)).toEqual(config)
    await chmod(file, 0o644)
    await expect(readMachineConfig(file)).rejects.toThrow()
    await chmod(file, 0o600)
    await writeFile(join(dir, 'link'), JSON.stringify(config))
    await symlink(file, join(dir, 'alias'))
    await expect(readMachineConfig(join(dir, 'alias'))).rejects.toThrow()
    await writeFile(file, JSON.stringify({ ...config, extra: 'x' }))
    await expect(readMachineConfig(file)).rejects.toThrow()
    await writeFile(file, `{"endpoint":"${config.endpoint}","endpoint":"${config.endpoint}","machineId":"${config.machineId}","key":"${config.key}"}`)
    await expect(readMachineConfig(file)).rejects.toThrow()
    await writeFile(file, JSON.stringify({ ...config, endpoint: 'ws://example.invalid/machine/v1' }))
    await expect(readMachineConfig(file)).rejects.toThrow()
  })

  it('retries failed connects with bounded backoff and stops without reconnect', async () => {
    const delays: number[] = []
    let calls = 0
    const outbound = startMachineOutbound(config, () => [], async (): Promise<MachineConnection> => {
      calls++
      throw Error('offline')
    }, async ms => {
      delays.push(ms)
      if (delays.length === 8) void outbound.stop()
    })
    await outbound.done
    expect(calls).toBe(8)
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
    await outbound.stop()
    expect(calls).toBe(8)
  })

  it('aborts a pending reconnect timer on shutdown', async () => {
    let tried!: () => void
    const firstTry = new Promise<void>(resolve => { tried = resolve })
    let calls = 0
    const outbound = startMachineOutbound(config, () => [], async () => {
      calls++; tried(); throw Error('offline')
    })
    await firstTry
    await outbound.stop()
    expect(calls).toBe(1)
  })
})
