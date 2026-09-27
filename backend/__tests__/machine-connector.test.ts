import { afterEach, describe, expect, it } from 'vitest'
import { createHmac, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'
import { connectMachine, connectWithTransport } from '../machine-connector.js'

const key = randomBytes(32).toString('base64url')
const machineId = 'machine_1'
const endpoint = 'wss://example.invalid/machine/v1'
const config = { endpoint, machineId, key }
let server: Server | undefined
let wss: WebSocketServer | undefined
const clients: WebSocket[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate()
  if (wss) { const s = wss; wss = undefined; await new Promise<void>(resolve => s.close(() => resolve())) }
  if (server) { const s = server; server = undefined; await new Promise<void>(resolve => s.close(() => resolve())) }
})

async function fixture(onConnection: (ws: WebSocket) => void) {
  server = createServer()
  wss = new WebSocketServer({ server })
  wss.on('connection', ws => { clients.push(ws); onConnection(ws) })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return () => connectWithTransport(config, (_endpoint, options) => new WebSocket(`ws://127.0.0.1:${port}`, options))
}

const nonce = () => randomBytes(32).toString('base64url')
const challenge = (overrides: Record<string, unknown> = {}) => ({ v: 1, type: 'challenge', nonce: nonce(), ts: Date.now(), ...overrides })

async function expectFailure(message: unknown) {
  const connect = await fixture(ws => ws.send(typeof message === 'string' ? message : JSON.stringify(message)))
  await expect(connect()).rejects.toThrow()
}

describe('machine outbound connector', () => {
  it('rejects insecure, non-exact or credentialed endpoints before transport creation', () => {
    for (const value of ['ws://localhost/machine/v1', 'wss://host/machine/v1/', 'wss://host/machine/v1?x=1', 'wss://user:pass@host/machine/v1', 'wss://host/other']) {
      expect(() => connectMachine({ ...config, endpoint: value })).toThrow()
    }
    expect(() => connectWithTransport({ ...config, key: 'abc' }, () => { throw Error('called') })).toThrow()
    expect(() => connectWithTransport({ ...config, machineId: 'bad id' }, () => { throw Error('called') })).toThrow()
  })

  it('responds with a verifiable proof and accepts only matching ready', async () => {
    const c = challenge()
    const connect = await fixture(ws => {
      ws.send(JSON.stringify(c))
      ws.on('message', bytes => {
        const hello = JSON.parse(bytes.toString())
        expect(Object.keys(hello).sort()).toEqual(['machineId', 'proof', 'type', 'v'])
        expect(hello).toEqual({ v: 1, type: 'hello', machineId, proof: createHmac('sha256', Buffer.from(key, 'base64url'))
          .update(`pi-bridge-v1\n${machineId}\n${c.nonce}\n${c.ts}`).digest('base64url') })
        ws.send(JSON.stringify({ v: 1, type: 'ready', machineId }))
      })
    })
    const connection = await connect()
    clients[0].send(JSON.stringify({ v: 1, type: 'command' }))
    expect((await connection.closed)?.message).toMatch(/Invalid connector protocol/)
  })

  it('rejects malformed, oversized, binary, stale and future challenges', async () => {
    for (const msg of ['not json', challenge({ nonce: 'a' }), challenge({ ts: Date.now() - 11_000 }), challenge({ ts: Date.now() + 11_000 }), challenge({ v: 2 }), challenge({ extra: 1 }), ' '.repeat(2049)]) {
      await expectFailure(msg)
      for (const client of clients.splice(0)) client.terminate()
      await new Promise<void>(resolve => wss!.close(() => resolve()))
      wss = undefined
      await new Promise<void>(resolve => server!.close(() => resolve()))
      server = undefined
    }
    const connect = await fixture(ws => ws.send(Buffer.from('binary')))
    await expect(connect()).rejects.toThrow()
  })

  it('rejects wrong ready and premature close', async () => {
    const connect = await fixture(ws => {
      ws.send(JSON.stringify(challenge()))
      ws.on('message', () => ws.send(JSON.stringify({ v: 1, type: 'ready', machineId: 'other' })))
    })
    await expect(connect()).rejects.toThrow()
  })
})
