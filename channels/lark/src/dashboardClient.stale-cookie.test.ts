import { mkdtemp, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LarkGatewayConfig } from './config.js'
import { DashboardClient } from './dashboardClient.js'

/**
 * Regression cover for the stale-cookie outage: the gateway holds a long-lived
 * WS and makes no HTTP calls, so the backend prunes its browser session after
 * 12h. Every HTTP call then 401s forever unless the client re-authenticates.
 */
describe('DashboardClient stale cookie', () => {
  let server: http.Server
  let cfg: LarkGatewayConfig
  /** Cookie values the fake dashboard still accepts. */
  let validCookies: Set<string>
  let authCount: number
  let commandBodies: string[]
  let issued: number

  beforeEach(async () => {
    validCookies = new Set()
    authCount = 0
    commandBodies = []
    issued = 0

    server = http.createServer((req, res) => {
      const cookie = (req.headers.cookie || '').replace('pi_live_session=', '')
      const read = () =>
        new Promise<string>(resolve => {
          const chunks: Buffer[] = []
          req.on('data', c => chunks.push(c as Buffer))
          req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        })

      if (req.url === '/api/live-sessions/auth') {
        authCount += 1
        const value = `cookie-${(issued += 1)}`
        validCookies.add(value)
        res.setHeader('Set-Cookie', `pi_live_session=${value}; Path=/api; HttpOnly`)
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (!validCookies.has(cookie)) {
        res.statusCode = 401
        res.end(JSON.stringify({ error: 'authentication_required' }))
        return
      }
      if (req.url?.endsWith('/commands')) {
        void read().then(body => {
          commandBodies.push(body)
          res.end(JSON.stringify({ ok: true }))
        })
        return
      }
      res.end(JSON.stringify({ sessions: [] }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    const dir = await mkdtemp(path.join(tmpdir(), 'lark-client-'))
    const controlTokenPath = path.join(dir, 'live-control-token')
    await writeFile(controlTokenPath, 'test-token\n', 'utf8')
    cfg = {
      dashboardBaseUrl: `http://127.0.0.1:${port}`,
      controlTokenPath,
      mappingPath: path.join(dir, 'mapping.json'),
      accountsPath: path.join(dir, 'accounts.json'),
    }
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('re-authenticates and retries when the cookie has been pruned', async () => {
    const client = new DashboardClient(cfg)
    await client.sendInput('proc-1', 'hello')
    expect(authCount).toBe(1)
    expect(commandBodies).toHaveLength(1)

    // The backend prunes the session (12h TTL, or a restart).
    validCookies.clear()

    await client.sendInput('proc-1', 'what is the progress')
    expect(authCount).toBe(2)
    expect(commandBodies).toHaveLength(2)
    expect(JSON.parse(commandBodies[1]!)).toEqual({
      command: { type: 'input', text: 'what is the progress', channel: 'chatapp' },
    })
  })

  it('surfaces a real failure instead of looping on re-auth', async () => {
    const client = new DashboardClient(cfg)
    await client.sendInput('proc-1', 'hello')
    validCookies.clear()
    // Auth now yields a cookie the request handler never accepts.
    const original = validCookies.add.bind(validCookies)
    validCookies.add = (() => validCookies) as typeof validCookies.add
    await expect(client.sendInput('proc-1', 'hello again')).rejects.toThrow(/command_failed: 401/)
    expect(authCount).toBe(2)
    validCookies.add = original
  })

  it('refreshes the cookie for listSessions too', async () => {
    const client = new DashboardClient(cfg)
    expect(await client.listSessions()).toEqual([])
    validCookies.clear()
    expect(await client.listSessions()).toEqual([])
    expect(authCount).toBe(2)
  })
})
