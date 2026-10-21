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

describe('one-use native Live authorization (isolated temporary state)', () => {
  let base: string, auth: LiveSessionBrowserAuth, token: string
  let now: number
  const request = (cookie: string) => ({ headers: { cookie } })
  const cookieOf = (result: { setCookie: string }) => result.setCookie.split(';', 1)[0]
  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'pidash-pairing-'))
    now = 1_700_000_000_000
    auth = new LiveSessionBrowserAuth({ tokenPath: path.join(base, 'control'), now: () => now })
    await auth.start()
    token = (await readFile(auth.tokenPath, 'utf8')).trim() // synthetic test fixture, never production
  })
  afterEach(async () => { await auth.stop(); await rm(base, { recursive: true, force: true }) })
  async function login() { return (await auth.authenticate(token, false))! }

  it('requires an issuer and gives the phone an independent identity', async () => {
    expect(auth.issuePairingCode({ headers: {} })).toBeUndefined()
    const browser = await login()
    const code = auth.issuePairingCode(request(cookieOf(browser)))!
    expect(code.code).toMatch(/^[a-f0-9]{32}$/)
    expect(code.expiresAt - now).toBeLessThanOrEqual(180_000)
    const phone = (await auth.redeemPairingCode(code.code, true))!
    expect(phone.browserClientId).not.toBe(browser.browserClientId)
    expect(cookieOf(phone)).not.toBe(cookieOf(browser))
    expect(phone.setCookie).toContain('HttpOnly; SameSite=Strict; Secure')
    expect(auth.getIdentity(request(cookieOf(phone)))?.browserClientId).toBe(phone.browserClientId)
    await auth.forget(request(cookieOf(browser)))
    expect(auth.getIdentity(request(cookieOf(phone)))).toBeDefined()
  })
  it('keeps a paired phone idle for 30 days while a token login expires after 12h', async () => {
    const browser = await login()
    const phone = (await auth.redeemPairingCode(auth.issuePairingCode(request(cookieOf(browser)))!.code, true))!
    now += 12 * 60 * 60 * 1000 + 1
    // Idle expiry: the browser session is gone, the paired device is not.
    expect(auth.getIdentity(request(cookieOf(browser)))).toBeUndefined()
    expect(auth.getIdentity(request(cookieOf(phone)))).toBeDefined()
    now += 25 * 24 * 60 * 60 * 1000
    expect(auth.getIdentity(request(cookieOf(phone)))).toBeDefined()
    // 30 days of real inactivity still ends it — long-lived is not eternal.
    now += 30 * 24 * 60 * 60 * 1000 + 1
    expect(auth.getIdentity(request(cookieOf(phone)))).toBeUndefined()
  })
  it('persists the device flag so a restart does not shorten a paired phone', async () => {
    const browser = await login()
    const phone = (await auth.redeemPairingCode(auth.issuePairingCode(request(cookieOf(browser)))!.code, true))!
    now += 20 * 24 * 60 * 60 * 1000
    await auth.stop()
    const reopened = new LiveSessionBrowserAuth({ tokenPath: auth.tokenPath, now: () => now })
    await reopened.start()
    try {
      expect(reopened.getIdentity(request(cookieOf(phone)))).toBeDefined()
    } finally { await reopened.stop() }
  })
  it('consumes once, atomically, including concurrent redemption', async () => {
    const browser = await login()
    const code = auth.issuePairingCode(request(cookieOf(browser)))!
    const results = await Promise.all(Array.from({ length: 8 }, () => auth.redeemPairingCode(code.code, false)))
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await auth.redeemPairingCode(code.code, false)).toBeUndefined()
  })
  it('rejects expiry at the exact boundary and replaces the same issuer old code', async () => {
    const browser = await login()
    const first = auth.issuePairingCode(request(cookieOf(browser)))!
    const second = auth.issuePairingCode(request(cookieOf(browser)))!
    expect(await auth.redeemPairingCode(first.code, false)).toBeUndefined()
    now = second.expiresAt
    expect(await auth.redeemPairingCode(second.code, false)).toBeUndefined()
  })
  it('invalidates outstanding codes on issuer logout or expiry', async () => {
    const browser = await login()
    const code = auth.issuePairingCode(request(cookieOf(browser)))!
    await auth.forget(request(cookieOf(browser)))
    expect(await auth.redeemPairingCode(code.code, false)).toBeUndefined()
    const next = await login()
    const another = auth.issuePairingCode(request(cookieOf(next)))!
    now += 12 * 60 * 60 * 1000 + 1
    expect(await auth.redeemPairingCode(another.code, false)).toBeUndefined()
  })
  it('bounds memory and stores only hashes, never the code on disk', async () => {
    const issued: string[] = []
    for (let i = 0; i < 34; i++) {
      const identity = await login()
      issued.push(auth.issuePairingCode(request(cookieOf(identity)))!.code)
    }
    const map = (auth as unknown as { pairingCodes: Map<string, unknown> }).pairingCodes
    expect(map.size).toBe(32)
    expect([...map.keys()].every(key => /^[a-f0-9]{64}$/.test(key))).toBe(true)
    expect([...map.keys()]).not.toContain(issued[33])
    expect(await auth.redeemPairingCode(issued[0], false)).toBeUndefined()
    expect(await auth.redeemPairingCode(issued[33], false)).toBeDefined()
    expect(await readFile(`${auth.tokenPath}.sessions.json`, 'utf8')).not.toContain(issued[33])
  })
  it.each([undefined, null, {}, [], '', 'z'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), 'a'.repeat(32)])('rejects malformed or unknown code %j', async code => {
    expect(await auth.redeemPairingCode(code, false)).toBeUndefined()
  })
  it('persists revocation without resurrecting a cookie after reload or concurrent writes', async () => {
    const browser = await login()
    const browserCookie = cookieOf(browser)
    const otherLogin = login()
    await Promise.resolve() // enqueue a pre-logout snapshot while its atomic write is still in flight
    await auth.forget(request(browserCookie))
    const other = await otherLogin
    await auth.stop(); await auth.start()
    expect(auth.getIdentity(request(browserCookie))).toBeUndefined()
    expect(auth.getIdentity(request(cookieOf(other)))).toBeDefined()
    expect((await stat(`${auth.tokenPath}.sessions.json`)).mode & 0o777).toBe(0o600)
  })
})

describe('native pairing HTTP routes', () => {
  let base: string, auth: LiveSessionBrowserAuth, registry: LiveSessionRegistry, routes: LiveSessionRoutes, server: Server
  let origin: string, cookie: string
  const sockets: WebSocket[] = []
  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'pidash-pairing-http-'))
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
  function post(route: string, body: unknown = {}, headers: Record<string, string> = { origin, cookie }) {
    return fetch(`${origin}/api/live-sessions/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  }
  async function mint() { return (await (await post('pairing-code')).json()).result.code as string }
  async function connect(cookie: string) {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/api/live-sessions/ws', { headers: { origin, cookie } })
    sockets.push(ws)
    await new Promise<void>((resolve, reject) => { ws.once('message', () => resolve()); ws.once('error', reject) })
    return ws
  }
  it('requires both existing auth and matching Origin to mint or logout', async () => {
    for (const headers of [{ origin }, { cookie }, { origin: 'https://hostile.invalid', cookie }]) {
      const response = await post('pairing-code', {}, headers)
      expect(response.status).toBe(headers.origin === origin ? 401 : 403)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    const logout = await fetch(`${origin}/api/live-sessions/auth`, { method: 'DELETE', headers: { cookie } })
    expect(logout.status).toBe(403)
    expect(auth.getIdentity({ headers: { cookie } })).toBeDefined()
  })
  it('rejects wrong/missing Origin without consuming a valid code; redemption is single-use', async () => {
    const code = await mint()
    for (const headers of [{}, { origin: 'https://hostile.invalid' }]) {
      expect((await post('pair', { code }, headers)).status).toBe(403)
    }
    const redeemed = await post('pair', { code }, { origin })
    expect(redeemed.status).toBe(200)
    expect(redeemed.headers.get('cache-control')).toBe('no-store')
    expect((await redeemed.json()).browserClientId).toMatch(/^[a-f0-9]{32}$/)
    expect(redeemed.headers.get('set-cookie')).toContain('HttpOnly')
    const replay = await post('pair', { code }, { origin })
    expect(replay.status).toBe(401)
    expect(await replay.json()).toEqual({ error: 'authentication_failed' })
    expect(replay.headers.get('cache-control')).toBe('no-store')
  })
  it('pairing never launches or claims; configured roots are auth protected', async () => {
    const claim = vi.spyOn(registry, 'claim')
    expect((await fetch(`${origin}/api/live-sessions/start-options`)).status).toBe(401)
    const options = await fetch(`${origin}/api/live-sessions/start-options`, { headers: { cookie } })
    expect(await options.json()).toEqual({ roots: ['/allowed/project'] })
    await post('pair', { code: await mint() }, { origin })
    expect(claim).not.toHaveBeenCalled()
    expect(registry.list()).toEqual([])
  })
  it('logout closes only this identity websocket and revokes only this cookie', async () => {
    const native = await post('pair', { code: await mint() }, { origin })
    const nativeCookie = native.headers.get('set-cookie')!.split(';', 1)[0]
    const nativeSocket = await connect(nativeCookie)
    const browserSocket = await connect(cookie)
    const closed = new Promise(resolve => nativeSocket.once('close', resolve))
    const logout = await fetch(`${origin}/api/live-sessions/auth`, { method: 'DELETE', headers: { origin, cookie: nativeCookie } })
    expect(logout.status).toBe(200)
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(logout.headers.get('cache-control')).toBe('no-store')
    await closed
    expect(auth.getIdentity({ headers: { cookie: nativeCookie } })).toBeUndefined()
    expect(auth.getIdentity({ headers: { cookie } })).toBeDefined()
    expect(browserSocket.readyState).toBe(WebSocket.OPEN)
  })
})
