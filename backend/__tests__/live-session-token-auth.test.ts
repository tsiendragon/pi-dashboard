import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import WebSocket from 'ws'
import { LiveSessionBrowserAuth } from '../live-sessions/auth.js'
import { LiveSessionRegistry } from '../live-sessions/registry.js'
import { LiveSessionGroupStore } from '../live-sessions/groups.js'
import { LiveSessionMetaStore } from '../live-sessions/meta.js'
import { LiveSessionOrderStore } from '../live-sessions/order.js'
import { createLiveSessionRoutes, type LiveSessionRoutes } from '../routes/live-sessions.js'

const WEEK = 7 * 24 * 60 * 60 * 1000

describe('control-token sessions (pairing removed)', () => {
  let base: string, auth: LiveSessionBrowserAuth, token: string, now: number
  const request = (cookie: string) => ({ headers: { cookie } })
  const cookieOf = (result: { setCookie: string }) => result.setCookie.split(';', 1)[0]
  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'pidash-token-'))
    now = 1_700_000_000_000
    auth = new LiveSessionBrowserAuth({ tokenPath: path.join(base, 'control'), now: () => now })
    await auth.start()
    token = (await readFile(auth.tokenPath, 'utf8')).trim()
  })
  afterEach(async () => { await auth.stop(); await rm(base, { recursive: true, force: true }) })

  it('issues an independent HttpOnly session per login and rejects a wrong token', async () => {
    expect(await auth.authenticate('f'.repeat(64), false)).toBeUndefined()
    expect(await auth.authenticate('', false)).toBeUndefined()
    expect(await auth.authenticate(undefined, false)).toBeUndefined()
    const phone = (await auth.authenticate(token, true))!
    const browser = (await auth.authenticate(token, false))!
    expect(phone.browserClientId).not.toBe(browser.browserClientId)
    expect(cookieOf(phone)).not.toBe(cookieOf(browser))
    expect(phone.setCookie).toContain('HttpOnly; SameSite=Strict; Secure')
    expect(auth.getIdentity(request(cookieOf(phone)))?.browserClientId).toBe(phone.browserClientId)
  })

  it('slides while used and ends after a week of idleness', async () => {
    const phone = (await auth.authenticate(token, true))!
    const cookie = cookieOf(phone)
    for (let day = 0; day < 30; day += 2) {
      now += 2 * 24 * 60 * 60 * 1000
      expect(auth.getIdentity(request(cookie))).toBeDefined()
    }
    now += WEEK + 1
    expect(auth.getIdentity(request(cookie))).toBeUndefined()
  })

  it('survives a restart, and logout revokes only that cookie', async () => {
    const phone = (await auth.authenticate(token, true))!
    const browser = (await auth.authenticate(token, false))!
    await auth.stop()
    const reopened = new LiveSessionBrowserAuth({ tokenPath: auth.tokenPath, now: () => now })
    await reopened.start()
    try {
      auth = reopened
      expect(auth.getIdentity(request(cookieOf(phone)))).toBeDefined()
      await auth.forget(request(cookieOf(phone)))
      expect(auth.getIdentity(request(cookieOf(phone)))).toBeUndefined()
      expect(auth.getIdentity(request(cookieOf(browser)))).toBeDefined()
      expect((await stat(`${auth.tokenPath}.sessions.json`)).mode & 0o777).toBe(0o600)
    } finally { await reopened.stop() }
  })

  it('accepts only the token file itself, never anything derived from it', async () => {
    const near = [token.slice(0, -1), `${token}0`, token.toUpperCase(), ` ${token} `]
    for (const candidate of near) {
      if (candidate.trim() === token) continue // the trimmed value is the real token
      expect(await auth.authenticate(candidate, false)).toBeUndefined()
    }
    expect(await auth.authenticate(`${token}\n`, false)).toBeDefined()
  })
})

describe('HTTP surface after pairing removal', () => {
  let base: string, auth: LiveSessionBrowserAuth, registry: LiveSessionRegistry, routes: LiveSessionRoutes, server: Server
  let origin: string, cookie: string
  const sockets: WebSocket[] = []
  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'pidash-token-http-'))
    auth = new LiveSessionBrowserAuth({ tokenPath: path.join(base, 'control') })
    registry = new LiveSessionRegistry()
    const app = express(); app.use(express.json())
    routes = createLiveSessionRoutes({
      app, auth, registry, roots: ['/allowed/project'],
      groupStore: new LiveSessionGroupStore(path.join(base, 'groups')),
      metaStore: new LiveSessionMetaStore(path.join(base, 'meta')),
      orderStore: new LiveSessionOrderStore(path.join(base, 'order')),
    })
    await routes.start()
    server = app.listen(0, '127.0.0.1')
    server.on('upgrade', (req, socket, head) => { if (!routes.handleUpgrade(req, socket, head)) socket.destroy() })
    await new Promise<void>(resolve => server.once('listening', resolve))
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const token = (await readFile(auth.tokenPath, 'utf8')).trim()
    const login = await fetch(`${origin}/api/live-sessions/auth`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }),
    })
    cookie = login.headers.get('set-cookie')!.split(';', 1)[0]
  })
  afterEach(async () => {
    sockets.splice(0).forEach(ws => ws.terminate())
    await routes.stop(); await registry.stop(); await auth.stop()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(base, { recursive: true, force: true })
  })
  function post(route: string, body: unknown = {}, headers: Record<string, string> = { origin }) {
    return fetch(`${origin}/api/live-sessions/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  }
  async function connect(cookie: string) {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/api/live-sessions/ws', { headers: { origin, cookie } })
    sockets.push(ws)
    await new Promise<void>((resolve, reject) => { ws.once('message', () => resolve()); ws.once('error', reject) })
    return ws
  }

  it('no longer exposes pairing endpoints', async () => {
    expect((await post('pairing-code', {}, { origin, cookie })).status).toBe(404)
    expect((await post('pair', { code: 'a'.repeat(32) }, { origin })).status).toBe(404)
  })

  it('requires a matching Origin and the right token, and mints nothing else', async () => {
    const token = (await readFile(auth.tokenPath, 'utf8')).trim()
    for (const headers of [{ 'content-type': 'application/json' }, { 'content-type': 'application/json', origin: 'https://hostile.invalid' }]) {
      const response = await fetch(`${origin}/api/live-sessions/auth`, {
        method: 'POST', headers, body: JSON.stringify({ token }),
      })
      expect(response.status).toBe(403)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    const wrong = await fetch(`${origin}/api/live-sessions/auth`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: 'a'.repeat(64) }),
    })
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toEqual({ error: 'authentication_failed' })
    expect(auth.getIdentity({ headers: { cookie: '' } })).toBeUndefined()
    expect(registry.list()).toEqual([])
  })

  it('logout closes that websocket and revokes that cookie only', async () => {
    const second = await fetch(`${origin}/api/live-sessions/auth`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ token: (await readFile(auth.tokenPath, 'utf8')).trim() }),
    })
    const secondCookie = second.headers.get('set-cookie')!.split(';', 1)[0]
    const secondSocket = await connect(secondCookie)
    const firstSocket = await connect(cookie)
    const closed = new Promise(resolve => secondSocket.once('close', resolve))
    const logout = await fetch(`${origin}/api/live-sessions/auth`, { method: 'DELETE', headers: { origin, cookie: secondCookie } })
    expect(logout.status).toBe(200)
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
    await closed
    expect(auth.getIdentity({ headers: { cookie: secondCookie } })).toBeUndefined()
    expect(auth.getIdentity({ headers: { cookie } })).toBeDefined()
    expect(firstSocket.readyState).toBe(WebSocket.OPEN)
  })

  it('keeps roots behind auth and never claims or launches a session', async () => {
    const claim = vi.spyOn(registry, 'claim')
    expect((await fetch(`${origin}/api/live-sessions/start-options`)).status).toBe(401)
    const options = await fetch(`${origin}/api/live-sessions/start-options`, { headers: { cookie } })
    expect(await options.json()).toEqual({ roots: ['/allowed/project'] })
    expect(claim).not.toHaveBeenCalled()
  })
})
