import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DashboardClient } from './dashboardClient.js'
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

describe('DashboardClient authentication refresh', () => {
  it('reauthenticates once and retries a live-session input after 401', async () => {
    let authRequests = 0
    const commandCookies: string[] = []
    const commandBodies: string[] = []
    const server = createServer((req, res) => {
      if (req.url === '/api/live-sessions/auth') {
        authRequests += 1
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': `pi_live_session=session-${authRequests}; Path=/; HttpOnly`,
        })
        res.end('{"ok":true}')
        return
      }

      if (req.url === '/api/live-sessions/process-123/commands') {
        let body = ''
        req.setEncoding('utf8')
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          commandCookies.push(String(req.headers.cookie || ''))
          commandBodies.push(body)
          if (commandBodies.length === 1) {
            res.writeHead(401, { 'content-type': 'application/json' })
            res.end('{"error":"authentication_required"}')
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"ok":true}')
        })
        return
      }

      res.writeHead(404).end()
    })
    const baseUrl = await listen(server)
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lark-dashboard-client-'))
    const controlTokenPath = path.join(directory, 'control-token')
    const client = new DashboardClient({
      dashboardBaseUrl: baseUrl,
      controlTokenPath,
      mappingPath: path.join(directory, 'mapping.json'),
      accountsPath: path.join(directory, 'accounts.json'),
    } satisfies LarkGatewayConfig)

    try {
      await writeFile(controlTokenPath, 'test-control-token\n')
      await client.sendInput('process-123', 'hello from Lark')

      expect(authRequests).toBe(2)
      expect(commandCookies).toEqual(['pi_live_session=session-1', 'pi_live_session=session-2'])
      expect(commandBodies).toEqual([
        '{"command":{"type":"input","text":"hello from Lark","channel":"chatapp"}}',
        '{"command":{"type":"input","text":"hello from Lark","channel":"chatapp"}}',
      ])
    } finally {
      client.close()
      await close(server)
      await rm(directory, { recursive: true, force: true })
    }
  })
})
