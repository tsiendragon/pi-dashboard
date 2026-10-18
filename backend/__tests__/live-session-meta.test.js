/**
 * Tests for live-sessions/meta.ts — sidebar tags + pin store for live Pi sessions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, statSync, writeFileSync } from 'fs'
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

  it('persists appearance-only entries and preserves it during tags, pin and terminal updates', async () => {
    await store.update('sess-1', { color: '#5287BE', emoji: '  🐈‍⬛  ' })
    await store.update('sess-1', { tags: ['ocr'], pinned: true, tmux: 'pi-dash-live-test' })
    expect(await new LiveSessionMetaStore(file).list()).toMatchObject({
      'sess-1': { color: '#5287be', emoji: '🐈‍⬛', tags: ['ocr'], pinned: true, tmux: 'pi-dash-live-test' },
    })
    await store.update('sess-2', { emoji: '😊' })
    expect(await new LiveSessionMetaStore(file).list()).toHaveProperty('sess-2.emoji', '😊')
    await store.update('sess-3', { color: '#54937d' })
    expect(await new LiveSessionMetaStore(file).list()).toHaveProperty('sess-3.color', '#54937d')
  })

  it('clears only requested appearance fields and prunes empty entries', async () => {
    await store.update('sess-1', { color: '#9571c4', emoji: '😊' })
    await store.update('sess-1', { color: '' })
    expect((await store.list())['sess-1']).toMatchObject({ emoji: '😊' })
    expect((await store.list())['sess-1']).not.toHaveProperty('color')
    await store.update('sess-1', { emoji: '' })
    expect(await store.list()).toEqual({})
    await store.update('sess-1', { tags: ['ocr'], pinned: true, tmux: 'pi-dash-live-test', color: '#9571c4', emoji: '😊' })
    await store.update('sess-1', { color: '', emoji: '' })
    expect((await store.list())['sess-1']).toMatchObject({ tags: ['ocr'], pinned: true, tmux: 'pi-dash-live-test' })
    expect((await store.list())['sess-1']).not.toHaveProperty('color')
    expect((await store.list())['sess-1']).not.toHaveProperty('emoji')
  })

  it.each([
    { color: null }, { color: 3 }, { color: '#fff' }, { color: 'red' }, { color: 'url(javascript:x)' },
    { emoji: null }, { emoji: {} }, { emoji: 'x'.repeat(25) }, { emoji: 'a\u0001b' }, { emoji: '\n😊' },
  ])('rejects invalid appearance without partially writing other fields: %j', async patch => {
    await store.update('sess-1', { tags: ['ocr'], color: '#54937d', emoji: '📖' })
    await expect(store.update('sess-1', { tags: ['changed'], ...patch })).rejects.toThrow(/invalid_session_/)
    expect((await store.list())['sess-1']).toMatchObject({ tags: ['ocr'], color: '#54937d', emoji: '📖' })
    expect((await new LiveSessionMetaStore(file).list())['sess-1']).toMatchObject({ tags: ['ocr'], color: '#54937d', emoji: '📖' })
  })

  it('loads old entries and drops malformed appearance fields without losing tags', async () => {
    writeFileSync(file, JSON.stringify({ version: 1, meta: {
      old: { tags: ['ocr'], pinned: false, updatedAt: '' },
      malformed: { tags: ['router'], color: 'red', emoji: 'x'.repeat(25) },
      appearance: { color: '#9571c4', emoji: '😊' },
    } }))
    expect(await store.list()).toEqual({
      old: { tags: ['ocr'], pinned: false, updatedAt: '' },
      malformed: { tags: ['router'], pinned: false, updatedAt: expect.any(String) },
      appearance: { tags: [], pinned: false, color: '#9571c4', emoji: '😊', updatedAt: expect.any(String) },
    })
  })

  it('moves appearance with a session switch and respects the existing target', async () => {
    await store.update('sess-1', { color: '#9571c4', emoji: '😊' })
    await store.rekey('sess-1', 'sess-new')
    expect(await new LiveSessionMetaStore(file).list()).toEqual({ 'sess-new': expect.objectContaining({ color: '#9571c4', emoji: '😊' }) })
    await store.update('sess-target', { emoji: '🚀' })
    await store.rekey('sess-new', 'sess-target')
    expect(await store.list()).toEqual({ 'sess-target': expect.objectContaining({ emoji: '🚀' }) })
  })

  it('rolls back a failed disk write and can retry after storage is repaired', async () => {
    await store.update('sess-1', { emoji: '📖' })
    const original = readFileSync(file, 'utf8')
    rmSync(file)
    mkdirSync(file)
    await expect(store.update('sess-1', { emoji: '😊' })).rejects.toThrow()
    expect((await store.list())['sess-1'].emoji).toBe('📖')
    rmSync(file, { recursive: true })
    writeFileSync(file, original)
    await store.update('sess-1', { emoji: '🚀' })
    expect((await new LiveSessionMetaStore(file).list())['sess-1'].emoji).toBe('🚀')
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

  it('re-keys tags and pin when the same live Pi switches session in-process', async () => {
    await store.update('sess-1', { tags: ['ocr'], pinned: true })
    expect(await store.rekey('sess-1', 'sess-cleared')).toMatchObject({ 'sess-cleared': { tags: ['ocr'], pinned: true } })
    expect(await new LiveSessionMetaStore(file).list()).toEqual({ 'sess-cleared': expect.objectContaining({ tags: ['ocr'], pinned: true }) })
  })

  it('re-key is a no-op for unknown ids, equal ids and an existing target entry', async () => {
    expect(await store.rekey('sess-missing', 'sess-x')).toEqual({})
    await store.update('sess-1', { tags: ['a'] })
    expect(await store.rekey('sess-1', 'sess-1')).toMatchObject({ 'sess-1': { tags: ['a'] } })
    await store.update('sess-2', { pinned: true })
    expect(await store.rekey('sess-1', 'sess-2')).toEqual({ 'sess-2': expect.objectContaining({ pinned: true }) })
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

  async function serve(options = {}) {
    const base = await mkdtemp(join(tmpdir(), 'pi-live-meta-'))
    const app = express()
    app.use(express.json())
    const registry = stubRegistry()
    const auth = new LiveSessionBrowserAuth({ tokenPath: join(base, 'live-control-token') })
    const metaStore = new LiveSessionMetaStore(join(base, 'live-session-meta.json'))
    const routes = createLiveSessionRoutes({ app, registry, auth, metaStore, ...options })
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

  it('writes, reads and resets appearance through the authenticated metadata endpoint', async () => {
    const srv = await serve()
    const headers = { cookie: srv.cookie, origin: srv.origin, 'content-type': 'application/json' }
    try {
      const written = await fetch(`${srv.origin}/api/live-sessions/pid-a/meta`, { method: 'PATCH', headers, body: JSON.stringify({ color: '#9571c4', emoji: '😊', tags: ['ocr'], pinned: true }) })
      expect(written.status).toBe(200)
      expect(await written.json()).toMatchObject({ all: { 'session-a': { color: '#9571c4', emoji: '😊', tags: ['ocr'], pinned: true } } })
      const read = await fetch(`${srv.origin}/api/live-session-meta`, { headers: { cookie: srv.cookie } })
      expect(await read.json()).toMatchObject({ meta: { 'session-a': { color: '#9571c4', emoji: '😊' } } })
      const reset = await fetch(`${srv.origin}/api/live-sessions/pid-a/meta`, { method: 'PATCH', headers, body: JSON.stringify({ color: '', emoji: '' }) })
      expect(reset.status).toBe(200)
      expect((await reset.json()).all['session-a']).toEqual({ tags: ['ocr'], pinned: true, updatedAt: expect.any(String) })
    } finally { await srv.close() }
  })

  it('returns 400 for invalid appearance and does not save a partial patch', async () => {
    const srv = await serve()
    try {
      for (const patch of [{ color: null }, { color: '#fff' }, { emoji: [] }, { emoji: 'x'.repeat(25) }, { emoji: 'a\nb' }]) {
        const response = await fetch(`${srv.origin}/api/live-sessions/pid-a/meta`, {
          method: 'PATCH', headers: { cookie: srv.cookie, origin: srv.origin, 'content-type': 'application/json' },
          body: JSON.stringify({ pinned: true, ...patch }),
        })
        expect(response.status).toBe(400)
        expect(await srv.metaStore.list()).toEqual({})
      }
    } finally { await srv.close() }
  })

  it('records the tmux session of a tmux-first live start, and refuses browser writes to it', async () => {
    const launcher = {
      start: async () => ({ tmuxSession: 'pi-dash-live-abcd1234', cwd: '/tmp/app', title: 'Live \u00b7 app', sessionId: 'session-a', processInstanceId: 'pid-a' }),
      stop: async () => {},
    }
    const srv = await serve({ launcher })
    try {
      const started = await fetch(`${srv.origin}/api/live-sessions/start`, {
        method: 'POST', headers: { cookie: srv.cookie, origin: srv.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp/app', thinkingLevel: 'high' }),
      })
      expect(started.status).toBe(200)
      expect(await started.json()).toMatchObject({ ok: true, result: { tmuxSession: 'pi-dash-live-abcd1234' } })
      expect(await srv.metaStore.list()).toMatchObject({ 'session-a': { tmux: 'pi-dash-live-abcd1234' } })

      // The tmux name is machine-written: a browser PATCH must not overwrite it.
      const patched = await fetch(`${srv.origin}/api/live-sessions/pid-a/meta`, {
        method: 'PATCH', headers: { cookie: srv.cookie, origin: srv.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ tags: ['ocr'], tmux: 'pi-dash-attacker' }),
      })
      expect(patched.status).toBe(200)
      expect(await srv.metaStore.list()).toMatchObject({
        'session-a': { tags: ['ocr'], tmux: 'pi-dash-live-abcd1234' },
      })
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
