/**
 * Tests for live-sessions/order.ts — manual sidebar order for live Pi sessions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { EventEmitter } from 'events'
import express from 'express'
import { tmpdir } from 'os'
import { join } from 'path'
import { LiveSessionOrderStore, normalizeOrder } from '../live-sessions/order.js'
import { LiveSessionMetaStore } from '../live-sessions/meta.js'
import { LiveSessionGroupStore } from '../live-sessions/groups.js'
import { LiveSessionBrowserAuth } from '../live-sessions/auth.js'
import { createLiveSessionRoutes } from '../routes/live-sessions.js'

describe('normalizeOrder', () => {
  it('trims, drops empties and de-duplicates keeping the first slot', () => {
    expect(normalizeOrder([' b ', 'a', '', null, 'b', 'c'])).toEqual(['b', 'a', 'c'])
  })
  it('tolerates non-arrays', () => {
    expect(normalizeOrder(undefined)).toEqual([])
    expect(normalizeOrder('session-a')).toEqual([])
  })
  it('caps the list so a long-lived file cannot grow without bound', () => {
    expect(normalizeOrder(Array.from({ length: 1200 }, (_, i) => `s${i}`))).toHaveLength(1000)
  })
})

describe('LiveSessionOrderStore', () => {
  let dir, file, store
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'live-order-'))
    file = join(dir, 'live-session-order.json')
    store = new LiveSessionOrderStore(file)
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('is empty when the file does not exist', async () => {
    expect(await store.list()).toEqual([])
  })

  it('replaces the whole list and writes it 0600', async () => {
    expect(await store.replace(['session-b', 'session-a'])).toEqual(['session-b', 'session-a'])
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    expect(raw).toEqual({ version: 1, order: ['session-b', 'session-a'] })
  })

  it('clearing the list (auto-sort) is a real, persisted state', async () => {
    await store.replace(['session-a'])
    expect(await store.replace([])).toEqual([])
    expect(await new LiveSessionOrderStore(file).list()).toEqual([])
  })

  it('reloads persisted state from disk', async () => {
    await store.replace(['session-b', 'session-a', 'session-c'])
    expect(await new LiveSessionOrderStore(file).list()).toEqual(['session-b', 'session-a', 'session-c'])
  })

  it('survives a corrupt file without throwing', async () => {
    writeFileSync(file, '{not json', 'utf8')
    expect(await new LiveSessionOrderStore(file).list()).toEqual([])
  })

  it('re-keys one entry in place when the same live Pi switches session', async () => {
    await store.replace(['session-a', 'session-b', 'session-c'])
    expect(await store.rekey('session-b', 'session-cleared')).toEqual(['session-a', 'session-cleared', 'session-c'])
    expect(await new LiveSessionOrderStore(file).list()).toEqual(['session-a', 'session-cleared', 'session-c'])
  })

  it('re-key is a no-op for unlisted ids, equal ids and a target that is already listed', async () => {
    await store.replace(['session-a', 'session-b'])
    expect(await store.rekey('session-missing', 'session-new')).toEqual(['session-a', 'session-b'])
    expect(await store.rekey('session-a', 'session-a')).toEqual(['session-a', 'session-b'])
    expect(await store.rekey('session-a', 'session-b')).toEqual(['session-b'])
  })
})

describe('live-session order HTTP routes', () => {

  function stubRegistry() {
    const registry = new EventEmitter()
    registry.list = () => []
    registry.get = () => undefined
    registry.releaseByBrowser = async () => {}
    registry.stop = async () => {}
    return registry
  }

  async function serve() {
    const base = await mkdtemp(join(tmpdir(), 'pi-live-order-'))
    const app = express()
    app.use(express.json())
    const auth = new LiveSessionBrowserAuth({ tokenPath: join(base, 'live-control-token') })
    const orderStore = new LiveSessionOrderStore(join(base, 'live-session-order.json'))
    const metaStore = new LiveSessionMetaStore(join(base, 'live-session-meta.json'))
    const groupStore = new LiveSessionGroupStore(join(base, 'live-session-groups.json'))
    const registry = stubRegistry()
    const routes = createLiveSessionRoutes({ app, registry, auth, orderStore, metaStore, groupStore })
    await routes.start()
    const server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const token = (await (await import('fs/promises')).readFile(auth.tokenPath, 'utf8')).trim()
    const login = await fetch(`${origin}/api/live-sessions/auth`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ token }),
    })
    const cookie = login.headers.get('set-cookie')?.split(';')[0]
    return {
      origin, cookie, orderStore, metaStore, groupStore, registry,
      close: async () => {
        await routes.stop(); await auth.stop()
        await new Promise(resolve => server.close(resolve))
        await rm(base, { recursive: true, force: true })
      },
    }
  }

  it('rejects unauthenticated reads', async () => {
    const srv = await serve()
    try {
      expect((await fetch(`${srv.origin}/api/live-session-order`)).status).toBe(401)
    } finally { await srv.close() }
  })

  it('round-trips a dragged order and persists it', async () => {
    const srv = await serve()
    try {
      expect(await (await fetch(`${srv.origin}/api/live-session-order`, { headers: { cookie: srv.cookie } })).json())
        .toEqual({ order: [] })

      const put = await fetch(`${srv.origin}/api/live-session-order`, {
        method: 'PUT', headers: { cookie: srv.cookie, origin: srv.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ order: ['session-b', 'session-a'] }),
      })
      expect(put.status).toBe(200)
      expect(await put.json()).toEqual({ ok: true, order: ['session-b', 'session-a'] })
      expect(await srv.orderStore.list()).toEqual(['session-b', 'session-a'])

      const after = await (await fetch(`${srv.origin}/api/live-session-order`, { headers: { cookie: srv.cookie } })).json()
      expect(after).toEqual({ order: ['session-b', 'session-a'] })
    } finally { await srv.close() }
  })

  it('403s cross-origin writes and ignores a non-array payload', async () => {
    const srv = await serve()
    try {
      const crossOrigin = await fetch(`${srv.origin}/api/live-session-order`, {
        method: 'PUT', headers: { cookie: srv.cookie, origin: 'https://evil.example.test', 'content-type': 'application/json' },
        body: JSON.stringify({ order: ['session-a'] }),
      })
      expect(crossOrigin.status).toBe(403)
      expect(await srv.orderStore.list()).toEqual([])

      const garbage = await fetch(`${srv.origin}/api/live-session-order`, {
        method: 'PUT', headers: { cookie: srv.cookie, origin: srv.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ order: 'session-a' }),
      })
      expect(garbage.status).toBe(200)
      expect(await srv.orderStore.list()).toEqual([])
    } finally { await srv.close() }
  })

  it('re-keys every sidebar store when the same live Pi switches session in-process', async () => {
    const srv = await serve()
    try {
      await srv.orderStore.replace(['session-a', 'session-b'])
      await srv.metaStore.update('session-a', { tags: ['ocr'], pinned: true })
      const [group] = await srv.groupStore.create('任务A')
      await srv.groupStore.addMember(group.id, 'session-a')

      // `/clear` (and `/ls-fork`) keep the process but hand it a new pi sessionId.
      const detail = sessionId => ({ summary: { processInstanceId: 'process-a', sessionId }, entries: [] })
      srv.registry.emit('snapshot', detail('session-a'))
      srv.registry.emit('snapshot', detail('session-cleared'))

      await vi.waitFor(async () => {
        expect(await srv.orderStore.list()).toEqual(['session-cleared', 'session-b'])
        expect(await srv.metaStore.list()).toEqual({ 'session-cleared': expect.objectContaining({ tags: ['ocr'], pinned: true }) })
        expect((await srv.groupStore.list())[0].sessionIds).toEqual(['session-cleared'])
      })
    } finally { await srv.close() }
  })
})