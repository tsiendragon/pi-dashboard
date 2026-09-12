/**
 * Tests for live-sessions/meta.ts — sidebar tags + pin store for live Pi sessions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { EventEmitter } from 'events'
import express from 'express'
import { tmpdir } from 'os'
import { join } from 'path'
import { LiveSessionMetaStore, normalizeTags } from '../live-sessions/meta.js'
import { LiveSessionBrowserAuth } from '../live-sessions/auth.js'
import { createLiveSessionRoutes } from '../routes/live-sessions.js'

describe('normalizeTags', () => {
  it('lowercases, trims, dedupes and drops empties', () => {
    expect(normalizeTags([' OCR ', 'ocr', '', null, 'router'])).toEqual(['ocr', 'router'])
  })
  it('rejects namespaced (system-looking) tags and caps length/count', () => {
    expect(normalizeTags(['job:123'])).toEqual([])
    expect(normalizeTags(['x'.repeat(50)])[0]).toHaveLength(32)
    expect(normalizeTags(Array.from({ length: 40 }, (_, i) => `t${i}`))).toHaveLength(12)
  })
  it('tolerates non-arrays', () => {
    expect(normalizeTags(undefined)).toEqual([])
    expect(normalizeTags('ocr')).toEqual([])
  })
})

describe('LiveSessionMetaStore', () => {
  let dir, file, store
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'live-meta-'))
    file = join(dir, 'live-session-meta.json')
    store = new LiveSessionMetaStore(file)
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('is empty when the file does not exist', async () => {
    expect(await store.list()).toEqual({})
  })

  it('writes tags + pin keyed by sessionId with a 0600 file', async () => {
    const meta = await store.update('sess-1', { tags: ['ocr', 'OCR', 'router'], pinned: true })
    expect(meta.tags).toEqual(['ocr', 'router'])
    expect(meta.pinned).toBe(true)
    const mode = statSync(file).mode & 0o777
    expect(mode).toBe(0o600)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    expect(raw.version).toBe(1)
    expect(Object.keys(raw.meta)).toEqual(['sess-1'])
  })

  it('merges partial patches and keeps untouched fields', async () => {
    await store.update('sess-1', { tags: ['a'], pinned: true })
    expect(await store.update('sess-1', { tags: ['b'] })).toMatchObject({ tags: ['b'], pinned: true })
    expect(await store.update('sess-1', { pinned: false })).toMatchObject({ tags: ['b'], pinned: false })
  })

  it('prunes entries that become empty (no ghost records)', async () => {
    await store.update('sess-1', { tags: ['a'] })
    await store.update('sess-1', { tags: [] })
    expect(await store.list()).toEqual({})
  })

  it('keeps separate entries per session', async () => {
    await store.update('sess-1', { pinned: true })
    await store.update('sess-2', { tags: ['x'] })
    const all = await store.list()
    expect(Object.keys(all).sort()).toEqual(['sess-1', 'sess-2'])
  })

  it('reloads persisted state from disk', async () => {
    await store.update('sess-1', { tags: ['ocr'], pinned: true })
    const reopened = new LiveSessionMetaStore(file)
    expect(await reopened.list()).toMatchObject({ 'sess-1': { tags: ['ocr'], pinned: true } })
  })

  it('survives a corrupt file without throwing', async () => {
    const { writeFileSync } = await import('fs')
    writeFileSync(file, '{not json', 'utf8')
    const reopened = new LiveSessionMetaStore(file)
    expect(await reopened.list()).toEqual({})
  })

  it('removes an entry explicitly', async () => {
    await store.update('sess-1', { tags: ['a'] })
    await store.remove('sess-1')
    expect(await store.list()).toEqual({})
  })
})

describe('live-session meta HTTP routes', () => {

  /** Registry stub: one attached session, 'pid-a' → 'session-a'. */
  function stubRegistry() {
    const registry = new EventEmitter()
    registry.list = () => []
    registry.get = id => (id === 'pid-a' ? { summary: { processInstanceId: 'pid-a', sessionId: 'session-a' } } : undefined)
    registry.releaseByBrowser = async () => {}
    registry.stop = async () => {}
    return registry
  }

  async function serve() {
    const base = await mkdtemp(join(tmpdir(), 'pi-live-meta-'))
    const app = express()
    app.use(express.json())
    const registry = stubRegistry()
    const auth = new LiveSessionBrowserAuth({ tokenPath: join(base, 'live-control-token') })
    const metaStore = new LiveSessionMetaStore(join(base, 'live-session-meta.json'))
    const routes = createLiveSessionRoutes({ app, registry, auth, metaStore })
    await routes.start()
    const server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const token = (await readFileSync(auth.tokenPath, 'utf8')).trim()
    const login = await fetch(`${origin}/api/live-sessions/auth`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ token }),
    })
    const cookie = login.headers.get('set-cookie')?.split(';')[0]
    return {
      origin, cookie, metaStore,
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
      expect((await fetch(`${srv.origin}/api/live-session-meta`)).status).toBe(401)
    } finally { await srv.close() }
  })

  it('reads, writes and persists tags/pin for a live session', async () => {
    const srv = await serve()
    try {
      expect(await (await fetch(`${srv.origin}/api/live-session-meta`, { headers: { cookie: srv.cookie } })).json())
        .toEqual({ meta: {} })

      const res = await fetch(`${srv.origin}/api/live-sessions/pid-a/meta`, {
        method: 'PATCH', headers: { cookie: srv.cookie, origin: srv.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ tags: ['OCR', 'ocr', 'router'], pinned: true }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.meta).toMatchObject({ tags: ['ocr', 'router'], pinned: true })
      expect(body.all['session-a']).toMatchObject({ pinned: true })

      const after = await (await fetch(`${srv.origin}/api/live-session-meta`, { headers: { cookie: srv.cookie } })).json()
      expect(after.meta['session-a']).toMatchObject({ tags: ['ocr', 'router'], pinned: true })
      expect(await srv.metaStore.list()).toMatchObject({ 'session-a': { pinned: true } })
    } finally { await srv.close() }
  })

  it('404s for an unknown process instance and 403s cross-origin writes', async () => {
    const srv = await serve()
    try {
      const missing = await fetch(`${srv.origin}/api/live-sessions/nope/meta`, {
        method: 'PATCH', headers: { cookie: srv.cookie, origin: srv.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ pinned: true }),
      })
      expect(missing.status).toBe(404)

      const crossOrigin = await fetch(`${srv.origin}/api/live-sessions/pid-a/meta`, {
        method: 'PATCH', headers: { cookie: srv.cookie, origin: 'https://evil.example.test', 'content-type': 'application/json' },
        body: JSON.stringify({ pinned: true }),
      })
      expect(crossOrigin.status).toBe(403)
      expect(await srv.metaStore.list()).toEqual({})
    } finally { await srv.close() }
  })
})
