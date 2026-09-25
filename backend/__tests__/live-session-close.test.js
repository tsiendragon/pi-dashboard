import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import express from 'express'
import { LiveSessionBrowserAuth } from '../live-sessions/auth.js'
import { LiveSessionMetaStore } from '../live-sessions/meta.js'
import {
  LiveSessionCloseError,
  closeLiveSession,
  defaultIsProcessAlive,
  defaultWaitForExit,
} from '../live-sessions/session-close.js'
import { PI_SUBAGENT_CHILD_ENV, isSubagentChildProcess } from '../live-sessions/process-env.js'
import { createLiveSessionRoutes } from '../routes/live-sessions.js'

const cleanups = []
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()))
})

describe('closeLiveSession', () => {
  it('closes a tmux-backed session through its tmux handle', async () => {
    const killTmuxSession = vi.fn()
    const signalProcess = vi.fn()

    const result = await closeLiveSession({ pid: 10, tmuxSession: 'live-abcd1234' }, { killTmuxSession, signalProcess })

    expect(result).toEqual({ method: 'tmux', pid: 10, alreadyGone: false })
    expect(killTmuxSession).toHaveBeenCalledWith('live-abcd1234')
    expect(signalProcess).not.toHaveBeenCalled()
  })

  it('refuses a pid that is not the workbench subagent child', async () => {
    const signalProcess = vi.fn()

    await expect(closeLiveSession({ pid: 123 }, { isSubagentProcess: () => false, signalProcess }))
      .rejects.toMatchObject({ code: 'live_session_pid_unverifiable' })
    expect(signalProcess).not.toHaveBeenCalled()
  })

  it('refuses an unusable pid before touching the process table', async () => {
    const isSubagentProcess = vi.fn(() => true)

    await expect(closeLiveSession({ pid: 0 }, { isSubagentProcess })).rejects.toMatchObject({ code: 'live_session_pid_invalid' })

    expect(isSubagentProcess).not.toHaveBeenCalled()
  })

  it('terminates the subagent process and stops once it exits', async () => {
    const signalProcess = vi.fn()

    const result = await closeLiveSession({ pid: 321 }, {
      isSubagentProcess: () => true,
      signalProcess,
      isProcessAlive: () => true,
      waitForExit: async () => true,
    })

    expect(result).toEqual({ method: 'signal', pid: 321, alreadyGone: false })
    expect(signalProcess.mock.calls).toEqual([[321, 'SIGTERM']])
  })

  it('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    const signalProcess = vi.fn()

    await closeLiveSession({ pid: 321 }, {
      isSubagentProcess: () => true,
      signalProcess,
      isProcessAlive: () => true,
      waitForExit: async () => false,
    })

    expect(signalProcess.mock.calls).toEqual([[321, 'SIGTERM'], [321, 'SIGKILL']])
  })

  it('reports an already-exited process without signalling it', async () => {
    const signalProcess = vi.fn()

    const result = await closeLiveSession({ pid: 321 }, {
      isSubagentProcess: () => true,
      signalProcess,
      isProcessAlive: () => false,
    })

    expect(result).toEqual({ method: 'signal', pid: 321, alreadyGone: true })
    expect(signalProcess).not.toHaveBeenCalled()
  })

  it('detects a live process and waits for it only up to the timeout', async () => {
    expect(defaultIsProcessAlive(process.pid)).toBe(true)
    expect(await defaultWaitForExit(process.pid, 150)).toBe(false)
  })

  it('really ends a marked child process', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
      env: { ...process.env, [PI_SUBAGENT_CHILD_ENV]: '1' },
      stdio: 'ignore',
    })
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))

    const result = await closeLiveSession({ pid: child.pid })

    expect(result).toEqual({ method: 'signal', pid: child.pid, alreadyGone: false })
    expect(await exited).toMatchObject({ signal: 'SIGTERM' })
    expect(defaultIsProcessAlive(child.pid)).toBe(false)
  })
})

describe('isSubagentChildProcess', () => {
  it('accepts exactly the workbench child marker', () => {
    expect(isSubagentChildProcess(5, () => new Map([[PI_SUBAGENT_CHILD_ENV, '1']]))).toBe(true)
    expect(isSubagentChildProcess(5, () => new Map([[PI_SUBAGENT_CHILD_ENV, '0']]))).toBe(false)
    expect(isSubagentChildProcess(5, () => new Map())).toBe(false)
    expect(isSubagentChildProcess(5, () => undefined)).toBe(false)
  })

  it('rejects an impossible pid without reading its environment', () => {
    const readEnviron = vi.fn(() => new Map([[PI_SUBAGENT_CHILD_ENV, '1']]))

    expect(isSubagentChildProcess(0, readEnviron)).toBe(false)
    expect(isSubagentChildProcess(-3, readEnviron)).toBe(false)
    expect(isSubagentChildProcess(Number.NaN, readEnviron)).toBe(false)

    expect(readEnviron).not.toHaveBeenCalled()
  })

  it('recognizes a real child process carrying the workbench marker', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], {
      env: { ...process.env, [PI_SUBAGENT_CHILD_ENV]: '1' },
      stdio: 'ignore',
    })
    try {
      expect(isSubagentChildProcess(child.pid)).toBe(true)
      // The test runner itself has no marker, so it must not look closable.
      expect(isSubagentChildProcess(process.pid)).toBe(false)
    } finally {
      child.kill('SIGKILL')
    }
  })
})

describe('live-session close HTTP route', () => {
  /** Registry stub: only the ids handed in exist, keyed by processInstanceId. */
  function stubRegistry(sessions) {
    const registry = new EventEmitter()
    registry.list = () => []
    registry.get = id => sessions[id]
    registry.releaseByBrowser = async () => {}
    registry.stop = async () => {}
    return registry
  }

  async function serve(options = {}) {
    const { sessions = {}, seedMeta, ...routeOptions } = options
    const base = await mkdtemp(join(tmpdir(), 'pi-live-close-'))
    const app = express()
    app.use(express.json())
    const registry = stubRegistry(sessions)
    const auth = new LiveSessionBrowserAuth({ tokenPath: join(base, 'live-control-token') })
    const metaStore = new LiveSessionMetaStore(join(base, 'live-session-meta.json'))
    if (seedMeta) for (const [sessionId, patch] of Object.entries(seedMeta)) await metaStore.update(sessionId, patch)
    const routes = createLiveSessionRoutes({ app, registry, auth, metaStore, ...routeOptions })
    await routes.start()
    const server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const token = readFileSync(auth.tokenPath, 'utf8').trim()
    const login = await fetch(`${origin}/api/live-sessions/auth`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ token }),
    })
    const cookie = login.headers.get('set-cookie')?.split(';')[0]
    const close = async () => {
      await routes.stop(); await auth.stop()
      await new Promise(resolve => server.close(resolve))
      await rm(base, { recursive: true, force: true })
    }
    cleanups.push(close)
    return { origin, cookie, metaStore }
  }

  const subagent = { processInstanceId: 'child-a', sessionId: 'session-child', pid: 4242, role: 'subagent' }

  const closeRequest = (srv, id, extraHeaders = {}) => fetch(`${srv.origin}/api/live-sessions/${id}/close`, {
    method: 'POST', headers: { cookie: srv.cookie, origin: srv.origin, 'content-type': 'application/json', ...extraHeaders },
  })

  it('requires authentication and a same-origin request', async () => {
    const srv = await serve({ sessions: { 'child-a': { summary: subagent } } })

    // Origin is checked before auth, so the credential check needs a same-origin request.
    const anonymous = await fetch(`${srv.origin}/api/live-sessions/child-a/close`, {
      method: 'POST', headers: { origin: srv.origin, 'content-type': 'application/json' },
    })
    expect(anonymous.status).toBe(401)
    expect((await closeRequest(srv, 'child-a', { origin: 'https://evil.example.test' })).status).toBe(403)
  })

  it('404s for an unknown session and 403s for a main session', async () => {
    const srv = await serve({
      sessions: { 'main-a': { summary: { ...subagent, processInstanceId: 'main-a', role: 'main' } } },
    })

    expect((await closeRequest(srv, 'nope')).status).toBe(404)

    const main = await closeRequest(srv, 'main-a')
    expect(main.status).toBe(403)
    expect((await main.json()).error).toBe('not_a_subagent')
  })

  it('forwards the tmux handle stored for the session', async () => {
    const closeSession = vi.fn(async () => ({ method: 'tmux', pid: 4242, alreadyGone: false }))
    const srv = await serve({
      sessions: { 'child-a': { summary: subagent } },
      seedMeta: { 'session-child': { tmux: 'pi-dash-live-abcd1234' } },
      closeSession,
    })

    const res = await closeRequest(srv, 'child-a')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, result: { method: 'tmux', pid: 4242, alreadyGone: false } })
    expect(closeSession).toHaveBeenCalledWith({ pid: 4242, tmuxSession: 'pi-dash-live-abcd1234' })
  })

  it('closes a subagent without a tmux session by pid', async () => {
    const closeSession = vi.fn(async () => ({ method: 'signal', pid: 4242, alreadyGone: false }))
    const srv = await serve({ sessions: { 'child-a': { summary: subagent } }, closeSession })

    const res = await closeRequest(srv, 'child-a')
    expect(res.status).toBe(200)
    expect(closeSession).toHaveBeenCalledWith({ pid: 4242 })
  })

  it('maps an unverifiable pid to 409 instead of guessing', async () => {
    const closeSession = vi.fn(async () => {
      throw new LiveSessionCloseError('live_session_pid_unverifiable', 'pid does not belong to a subagent process')
    })
    const srv = await serve({ sessions: { 'child-a': { summary: subagent } }, closeSession })

    const res = await closeRequest(srv, 'child-a')
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('live_session_pid_unverifiable')
  })
})