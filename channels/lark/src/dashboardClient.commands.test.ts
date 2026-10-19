import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DashboardClient, DashboardRequestError } from './dashboardClient.js'
import type { LarkGatewayConfig } from './config.js'

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server has no TCP address')
  return `http://127.0.0.1:${address.port}`
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()))
  })
}

async function makeClient(handler: (req: { url?: string; body: string }, res: import('node:http').ServerResponse) => void): Promise<{ client: DashboardClient; server: Server; bodies: string[] }> {
  const bodies: string[] = []
  const server = createServer((req, res) => {
    req.setEncoding('utf8')
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (req.url === '/api/live-sessions/auth') {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'pi_live_session=test; Path=/; HttpOnly' })
        res.end('{"ok":true}')
        return
      }
      bodies.push(body)
      handler({ url: req.url, body }, res)
    })
  })
  const base = await listen(server)
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lark-command-'))
  const controlTokenPath = path.join(directory, 'live-control-token')
  await writeFile(controlTokenPath, 'test-token\n', 'utf8')
  const cfg: LarkGatewayConfig = {
    dashboardBaseUrl: base,
    controlTokenPath,
    mappingPath: path.join(directory, 'mapping.json'),
    accountsPath: path.join(directory, 'accounts.json'),
  }
  return { client: new DashboardClient(cfg), server, bodies }
}

describe('DashboardClient structured commands', () => {
  it('posts a browser command and unwraps its result', async () => {
    const { client, server, bodies } = await makeClient((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true,"result":{"models":[{"provider":"p","id":"m"}]}}')
    })
    try {
      const models = await client.models('process-1')
      expect(models).toEqual([{ provider: 'p', id: 'm' }])
      expect(JSON.parse(bodies[0]!)).toEqual({ command: { type: 'get_models' } })
    } finally {
      await close(server)
    }
  })

  it('keeps the status and the machine-readable code of a rejection', async () => {
    const { client, server } = await makeClient((_req, res) => {
      res.writeHead(423, { 'content-type': 'application/json' })
      res.end('{"error":"session_already_claimed","message":"live session is already claimed"}')
    })
    try {
      const error = await client.claim('process-1').catch(caught => caught)
      expect(error).toBeInstanceOf(DashboardRequestError)
      expect(error).toMatchObject({ status: 423, code: 'session_already_claimed' })
      expect(String(error.message)).toContain('claim_failed: 423')
    } finally {
      await close(server)
    }
  })

  it('claims a lease and hands it back', async () => {
    const { client, server, bodies } = await makeClient((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(req.url?.endsWith('/claim') ? '{"ok":true,"result":{"leaseId":"lease-9"}}' : '{"ok":true,"result":{"released":true}}')
    })
    try {
      expect(await client.claim('process-1')).toEqual({ leaseId: 'lease-9' })
      await client.release('process-1', 'lease-9')
      expect(JSON.parse(bodies[1]!)).toEqual({ leaseId: 'lease-9' })
    } finally {
      await close(server)
    }
  })
})
