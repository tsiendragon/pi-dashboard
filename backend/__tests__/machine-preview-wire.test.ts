import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import WebSocket, { WebSocketServer } from 'ws'
import { connectWithTransport } from '../machine-connector.js'
import { projectMachinePreview } from '../machine-preview.js'
import type { LiveSessionDetail } from '../../shared/src/live-sessions.js'

const config = { endpoint: 'wss://example.invalid/machine/v1', machineId: 'm', key: randomBytes(32).toString('base64url') }
const lookup = vi.fn((id: string) => id === 'proc' ? ({ summary: { sessionId: 'session', status: 'idle', cwd: '/secret' },
  entries: [{ type: 'message_end', data: { message: { role: 'assistant', content: 'hello', token: 'secret' } } }] }) as unknown as LiveSessionDetail : undefined)
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); lookup.mockClear() })

async function fixture() {
  const server = createServer()
  const wss = new WebSocketServer({ server })
  let remote!: WebSocket
  wss.on('connection', ws => {
    remote = ws
    ws.send(JSON.stringify({ v: 1, type: 'challenge', nonce: randomBytes(32).toString('base64url'), ts: Date.now() }))
    ws.once('message', () => ws.send(JSON.stringify({ v: 1, type: 'ready', machineId: 'm' })))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const connection = await connectWithTransport(config, (_url, options) => new WebSocket(`ws://127.0.0.1:${port}`, options),
    () => [], undefined, undefined, undefined, (id, session) => projectMachinePreview(lookup, id, session, () => 42))
  cleanup.push(async () => { connection.close(); await connection.closed; remote.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())) })
  const send = (value: unknown): Promise<any> => new Promise(resolve => {
    remote.once('message', bytes => resolve(JSON.parse(bytes.toString())))
    remote.send(typeof value === 'string' ? value : JSON.stringify(value))
  })
  return { remote, connection, send }
}

it('replies with exact preview schema, never forwards registry fields, and returns no stale text', async () => {
  const f = await fixture()
  const requestId = randomUUID()
  expect(await f.send({ v: 1, type: 'get_preview', requestId, processInstanceId: 'proc', sessionId: 'session' })).toEqual({
    v: 1, type: 'preview', requestId, sessionId: 'session', status: 'idle', observedAt: 42,
    messages: [{ role: 'assistant', text: 'hello' }],
  })
  expect(await f.send({ v: 1, type: 'get_preview', requestId: randomUUID(), processInstanceId: 'proc', sessionId: 'old' }))
    .toMatchObject({ type: 'preview', sessionId: 'old', status: 'unavailable', messages: [] })
  expect(lookup).toHaveBeenCalledTimes(2)
})

it('closes on invalid, duplicate, oversized or unknown frames without forwarding anything', async () => {
  for (const invalid of [
    { v: 1, type: 'get_preview', requestId: randomUUID(), processInstanceId: 'proc', sessionId: 'session', path: '/secret' },
    { v: 1, type: 'get_preview', requestId: 'invalid', processInstanceId: 'proc', sessionId: 'session' },
    { v: 1, type: 'get_preview', requestId: randomUUID(), processInstanceId: '../proc', sessionId: 'session' },
    { v: 1, type: 'get_preview', requestId: randomUUID(), processInstanceId: 'proc', sessionId: 'x'.repeat(129) },
    { v: 1, type: 'get_transcript', requestId: randomUUID(), processInstanceId: 'proc', sessionId: 'session' },
    `{"v":1,"type":"get_preview","type":"get_preview","requestId":"${randomUUID()}","processInstanceId":"proc","sessionId":"session"}`,
    ' '.repeat(16385),
  ]) {
    const f = await fixture()
    f.remote.send(typeof invalid === 'string' ? invalid : JSON.stringify(invalid))
    expect(await f.connection.closed).toBeInstanceOf(Error)
  }
  expect(lookup).not.toHaveBeenCalled()
})
