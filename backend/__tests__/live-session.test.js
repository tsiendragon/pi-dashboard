import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'fs/promises'
import { createConnection } from 'net'
import express from 'express'
import WebSocket from 'ws'
import os from 'os'
import path from 'path'
import { parseLiveSessionConfig } from '../live-sessions/config.js'
import { LiveSessionPathPolicy, isPathWithinRoot } from '../live-sessions/path-policy.js'
import { LiveSessionRegistry } from '../live-sessions/registry.js'
import { validateLiveSessionCommand } from '../live-sessions/protocol.js'
import { LiveSessionBroker } from '../live-sessions/broker.js'
import { LiveSessionBrowserAuth } from '../live-sessions/auth.js'
import { createLiveSessionRoutes } from '../routes/live-sessions.js'
import { resetSessionTreeCaches } from '../live-sessions/session-tree.js'

const cleanups = []
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()))
})

function summary(overrides = {}) {
  return {
    processInstanceId: 'process-a', sessionId: 'session-a', pid: 4242,
    cwd: '/tmp/root/task', canonicalCwd: '/tmp/root/task', mode: 'tui',
    status: 'idle', claim: { state: 'unclaimed' }, startedAt: 1,
    lastActivityAt: 2, revision: 1, eventSequence: 0,
    ...overrides,
  }
}

function hello(overrides = {}) {
  return {
    type: 'hello', protocolVersion: 2, brokerToken: 'token',
    processInstanceId: 'process-a', pid: 4242, cwd: '/tmp/root/task',
    mode: 'tui', sessionId: 'session-a', ...overrides,
  }
}

describe('LiveSession input channel tagging', () => {
  it('accepts known channels and preserves them on the command', () => {
    const command = validateLiveSessionCommand({ type: 'input', text: 'hi', channel: 'terminal' })
    expect(command).toMatchObject({ type: 'input', channel: 'terminal' })
    expect(validateLiveSessionCommand({ type: 'input', text: 'hi', channel: 'mobile' })).toMatchObject({ type: 'input', channel: 'mobile' })
  })

  it('accepts image attachments and allows image-only inputs', () => {
    const image = { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }
    expect(validateLiveSessionCommand({ type: 'input', text: '', channel: 'web', images: [image] })).toMatchObject({
      type: 'input', text: '', channel: 'web', images: [image],
    })
    expect(() => validateLiveSessionCommand({ type: 'input', text: 'hi', channel: 'web', images: null })).toThrow()
  })

  it('requires a known channel and rejects unknown fields', () => {
    expect(() => validateLiveSessionCommand({ type: 'input', text: 'hi', channel: 'carrier-pigeon' })).toThrow()
    expect(() => validateLiveSessionCommand({ type: 'input', text: 'hi', channel: 'web', expandPromptTemplates: true })).toThrow()
    expect(() => validateLiveSessionCommand({ type: 'input', leaseId: 'lease-1', text: 'hi', channel: 'web' })).toThrow()
  })
})

describe('LiveSession path/config policy', () => {
  it('accepts canonical children and rejects prefix and symlink escapes', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'pi-live-path-'))
    cleanups.push(() => rm(base, { recursive: true, force: true }))
    const root = path.join(base, 'worktree')
    const child = path.join(root, 'task-a')
    const outside = path.join(base, 'worktree-evil')
    await Promise.all([mkdir(child, { recursive: true }), mkdir(outside)])
    expect(isPathWithinRoot(root, child)).toBe(true)
    expect(isPathWithinRoot(root, outside)).toBe(false)
    const policy = new LiveSessionPathPolicy([root])
    await policy.start()
    expect((await policy.authorize(child)).allowed).toBe(true)
    expect((await policy.authorize(outside)).code).toBe('out_of_scope')
    await policy.stop()
  })

  it('defaults to the requested worktree root and fails closed for invalid config', () => {
    expect(parseLiveSessionConfig(undefined)).toMatchObject({
      enabled: true,
      roots: ['/mnt/workspace/lilong/repos/worktree'],
      claimMode: 'on-first-input',
    })
    expect(parseLiveSessionConfig({ roots: ['relative/path'] })).toMatchObject({ enabled: false, roots: [] })
  })
})

describe('LiveSessionRegistry', () => {
  it('mirrors unanswered extension dialogs into the session detail', async () => {
    const registry = new LiveSessionRegistry({ commandTimeoutMs: 1_000 })
    cleanups.push(() => registry.stop())
    const transport = {
      send(envelope) {
        if (envelope.type !== 'command') return
        queueMicrotask(() => registry.handleCommandResult({ type: 'command_result', requestId: envelope.requestId, ok: true, result: { resynced: true } }, transport))
      },
    }
    registry.connect(hello(), '/tmp/root/task', transport)
    registry.applySnapshot({ type: 'snapshot', processInstanceId: 'process-a', revision: 1, sequence: 0, summary: summary(), entries: [] }, transport, '/tmp/root/task')

    // A browser that reconnects (page switch) reads this from the snapshot; the
    // one-shot event alone would leave an unanswered dialog invisible forever.
    registry.applyEvent({ type: 'event', processInstanceId: 'process-a', sequence: 1, event: { type: 'extension_ui', data: { id: 'ui-1', method: 'select', title: 'Pick', options: ['a', 'b'] } } }, transport)
    expect(registry.get('process-a').pendingUi).toEqual([{ id: 'ui-1', method: 'select', title: 'Pick', options: ['a', 'b'] }])

    registry.applyEvent({ type: 'event', processInstanceId: 'process-a', sequence: 2, event: { type: 'extension_ui_closed', data: { id: 'ui-1' } } }, transport)
    expect(registry.get('process-a').pendingUi).toEqual([])
  })

  it('projects status events and makes same-browser claim idempotent', async () => {
    const registry = new LiveSessionRegistry({ commandTimeoutMs: 1_000 })
    cleanups.push(() => registry.stop())
    const commands = []
    const transport = {
      send(envelope) {
        if (envelope.type !== 'command') return
        commands.push(envelope.command)
        const result = envelope.command.type === 'claim'
          ? { state: 'claimed', leaseId: 'lease-a', expiresAt: Date.now() + 30_000 }
          : envelope.command.type === 'renew'
            ? { state: 'claimed', leaseId: 'lease-a', expiresAt: Date.now() + 30_000 }
            : { released: true }
        queueMicrotask(() => registry.handleCommandResult({ type: 'command_result', requestId: envelope.requestId, ok: true, result }, transport))
      },
    }
    registry.connect(hello(), '/tmp/root/task', transport)
    registry.applySnapshot({ type: 'snapshot', processInstanceId: 'process-a', revision: 1, sequence: 0, summary: summary(), entries: [] }, transport, '/tmp/root/task')
    const first = await registry.claim('process-a', 'browser-a', 30_000)
    const second = await registry.claim('process-a', 'browser-a', 30_000)
    expect(first.leaseId).toBe('lease-a')
    expect(second).toMatchObject({ leaseId: 'lease-a', alreadyClaimed: true })
    expect(commands.filter(command => command.type === 'claim')).toHaveLength(1)

    await registry.sendBrowserCommand('process-a', 'browser-b', { type: 'input', text: 'shared prompt', channel: 'web' })
    expect(commands.at(-1)).toEqual({ type: 'input', text: 'shared prompt', channel: 'web' })
    await registry.sendBrowserCommand('process-a', 'browser-b', {
      type: 'input', text: 'inspect this', channel: 'web',
      images: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    })
    expect(commands.at(-1)).toEqual({
      type: 'input', text: 'inspect this', channel: 'web',
      images: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    })
    await registry.sendBrowserCommand('process-a', 'browser-a', { type: 'compact', leaseId: 'lease-a' })
    expect(commands.at(-1)).toEqual({ type: 'compact', leaseId: 'lease-a' })
    await registry.sendBrowserCommand('process-a', 'browser-b', { type: 'input', text: '/clear', channel: 'web' })
    expect(commands.at(-1)).toEqual({ type: 'input', text: '/clear', channel: 'web' })

    registry.applyEvent({ type: 'event', processInstanceId: 'process-a', sequence: 1, event: { type: 'agent_start', data: {} } }, transport)
    expect(registry.get('process-a').summary.status).toBe('running')
    registry.applyEvent({ type: 'event', processInstanceId: 'process-a', sequence: 2, event: { type: 'agent_settled', data: {} } }, transport)
    expect(registry.get('process-a').summary.status).toBe('idle')
  })

  it('accepts the first snapshot of an in-process session switch whose revision restarts', () => {
    const registry = new LiveSessionRegistry({ commandTimeoutMs: 1_000 })
    cleanups.push(() => registry.stop())
    const transportA = { send() {} }
    registry.connect(hello(), '/tmp/root/task', transportA)
    registry.applySnapshot({ type: 'snapshot', processInstanceId: 'process-a', revision: 7, sequence: 6, summary: summary({ revision: 7, eventSequence: 6 }), entries: [] }, transportA, '/tmp/root/task')

    // `/clear`: the extension reconnects with a fresh projector (revision 1, sequence 0).
    const transportB = { send() {} }
    registry.connect(hello({ sessionId: 'session-b' }), '/tmp/root/task', transportB)
    expect(registry.applySnapshot({ type: 'snapshot', processInstanceId: 'process-a', revision: 1, sequence: 0, summary: summary({ sessionId: 'session-b', revision: 1 }), entries: [] }, transportB, '/tmp/root/task')).toBe(true)
    expect(registry.get('process-a').summary.sessionId).toBe('session-b')

    // Same session, same revision → still treated as a duplicate.
    expect(registry.applySnapshot({ type: 'snapshot', processInstanceId: 'process-a', revision: 1, sequence: 0, summary: summary({ sessionId: 'session-b', revision: 1 }), entries: [] }, transportB, '/tmp/root/task')).toBe(false)
    // And the old connection cannot push the previous session back.
    expect(() => registry.applySnapshot({ type: 'snapshot', processInstanceId: 'process-a', revision: 8, sequence: 7, summary: summary({ revision: 8, eventSequence: 7 }), entries: [] }, transportA, '/tmp/root/task')).toThrow()
  })

  it('dispatches answer_ui from a non-lease holder so any channel can answer a UI request', async () => {
    const registry = new LiveSessionRegistry({ commandTimeoutMs: 1_000 })
    cleanups.push(() => registry.stop())
    const commands = []
    const transport = {
      send(envelope) {
        if (envelope.type !== 'command') return
        commands.push(envelope.command)
        queueMicrotask(() => registry.handleCommandResult({ type: 'command_result', requestId: envelope.requestId, ok: true, result: { accepted: true } }, transport))
      },
    }
    registry.connect(hello(), '/tmp/root/task', transport)
    registry.applySnapshot({ type: 'snapshot', processInstanceId: 'process-a', revision: 1, sequence: 0, summary: summary(), entries: [] }, transport, '/tmp/root/task')

    // browser-b holds no lease, yet must be able to answer a pending UI request
    // (the live-session analogue of the RPC ExtensionUiModal). Previously this
    // was rejected as unsupported_command, so the click never reached the TUI.
    await registry.sendBrowserCommand('process-a', 'browser-b', { type: 'answer_ui', id: 'ui-1', value: 'a' })
    expect(commands.at(-1)).toEqual({ type: 'answer_ui', id: 'ui-1', value: 'a' })

    await registry.sendBrowserCommand('process-a', 'browser-b', { type: 'answer_ui', id: 'ui-2', cancelled: true })
    expect(commands.at(-1)).toEqual({ type: 'answer_ui', id: 'ui-2', cancelled: true })
  })

  it('exposes every attached Pi process, including multiple sessions in one worktree', () => {
    const registry = new LiveSessionRegistry()
    cleanups.push(() => registry.stop())
    const olderTransport = { send: vi.fn() }
    const newerTransport = { send: vi.fn() }
    registry.connect(hello(), '/tmp/root/task', olderTransport)
    registry.applySnapshot({ type: 'snapshot', processInstanceId: 'process-a', revision: 1, sequence: 0, summary: summary({ startedAt: 10 }), entries: [] }, olderTransport, '/tmp/root/task')
    registry.connect(hello({ processInstanceId: 'process-b', sessionId: 'session-b', pid: 5252 }), '/tmp/root/task', newerTransport)
    registry.applySnapshot({
      type: 'snapshot', processInstanceId: 'process-b', revision: 1, sequence: 0,
      summary: summary({ processInstanceId: 'process-b', sessionId: 'session-b', pid: 5252, startedAt: 20 }), entries: [],
    }, newerTransport, '/tmp/root/task')

    expect(registry.list().map(item => item.processInstanceId)).toEqual(['process-a', 'process-b'])
    expect(registry.get('process-a')?.summary.sessionId).toBe('session-a')
    expect(registry.get('process-b')?.summary.sessionId).toBe('session-b')
  })

  it('coalesces streaming message updates into one final timeline entry', () => {
    const registry = new LiveSessionRegistry()
    cleanups.push(() => registry.stop())
    const transport = { send: vi.fn() }
    registry.connect(hello(), '/tmp/root/task', transport)
    registry.applySnapshot({ type: 'snapshot', processInstanceId: 'process-a', revision: 1, sequence: 0, summary: summary(), entries: [] }, transport, '/tmp/root/task')
    for (let sequence = 1; sequence <= 50; sequence++) {
      registry.applyEvent({ type: 'event', processInstanceId: 'process-a', sequence, event: {
        type: 'message_update', data: { message: { role: 'assistant', content: `partial-${sequence}` } },
      } }, transport)
    }
    registry.applyEvent({ type: 'event', processInstanceId: 'process-a', sequence: 51, event: {
      type: 'message_end', data: { message: { role: 'assistant', content: 'final' } },
    } }, transport)

    expect(registry.get('process-a').entries).toEqual([expect.objectContaining({ type: 'message_end' })])
  })

  it('requests a resync on an event sequence gap', () => {
    const registry = new LiveSessionRegistry()
    cleanups.push(() => registry.stop())
    const send = vi.fn()
    const transport = { send }
    registry.connect(hello(), '/tmp/root/task', transport)
    registry.applySnapshot({ type: 'snapshot', processInstanceId: 'process-a', revision: 1, sequence: 4, summary: summary({ eventSequence: 4 }), entries: [] }, transport, '/tmp/root/task')
    expect(registry.applyEvent({ type: 'event', processInstanceId: 'process-a', sequence: 6, event: { type: 'agent_start', data: {} } }, transport)).toBe(false)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ command: { type: 'resync' } }))
  })

  it('bulk-reloads every main session and skips subagent children', async () => {
    const registry = new LiveSessionRegistry({ commandTimeoutMs: 1_000 })
    cleanups.push(() => registry.stop())
    const commands = []
    const attach = (id, summaryOverrides, behavior = 'ok') => {
      const transport = {
        send(envelope) {
          if (envelope.type !== 'command') return
          commands.push({ id, command: envelope.command })
          if (behavior === 'error') {
            queueMicrotask(() => registry.handleCommandResult({
              type: 'command_result', requestId: envelope.requestId, ok: false, error: { code: 'reload_failed', message: 'bridge refused' },
            }, transport))
            return
          }
          queueMicrotask(() => registry.handleCommandResult({ type: 'command_result', requestId: envelope.requestId, ok: true, result: { reloaded: true } }, transport))
        },
      }
      registry.connect(hello({ processInstanceId: id, sessionId: `session-${id}`, pid: summaryOverrides.pid }), '/tmp/root/task', transport)
      registry.applySnapshot({
        type: 'snapshot', processInstanceId: id, revision: 1, sequence: 0,
        summary: summary({ processInstanceId: id, sessionId: `session-${id}`, ...summaryOverrides }), entries: [],
      }, transport, '/tmp/root/task')
      return transport
    }
    attach('process-main', { pid: 4242, role: 'main' })
    attach('process-bad', { pid: 5252, role: 'main' }, 'error')
    attach('process-child', { pid: 6262, role: 'subagent' })

    const result = await registry.reloadAll()
    expect(result.reloaded).toEqual(['process-main'])
    expect(result.skipped).toEqual(['process-child'])
    expect(result.failed).toEqual([{ processInstanceId: 'process-bad', code: 'reload_failed', message: 'bridge refused' }])
    expect(commands.filter(entry => entry.command.type === 'reload').map(entry => entry.id)).toEqual(['process-main', 'process-bad'])
  })
})

describe('LiveSession browser routes', () => {
  it('accepts canonical proxy hosts and constrains DSW gateway origins by port', () => {
    const auth = new LiveSessionBrowserAuth({ tokenPath: '/unused' })
    expect(auth.isOriginAllowed({ headers: {
      origin: 'https://dashboard.example.test', host: '127.0.0.1:7777',
      'x-forwarded-host': 'dashboard.example.test, internal-proxy:7777',
    } }, true)).toBe(true)
    expect(auth.isOriginAllowed({ headers: {
      origin: 'https://forwarded.example.test', host: '127.0.0.1:7777',
      forwarded: 'for=192.0.2.1;proto=https;host="forwarded.example.test"',
    } }, true)).toBe(true)
    expect(auth.isOriginAllowed({ headers: {
      origin: 'https://375-proxy-7777.dsw-gateway-cn-hongkong.data.aliyuncs.com',
      host: 'dsw-worker.internal:7777',
    } }, true)).toBe(true)
    expect(auth.isOriginAllowed({ headers: {
      origin: 'https://375-proxy-9999.dsw-gateway-cn-hongkong.data.aliyuncs.com',
      host: 'dsw-worker.internal:7777',
    } }, true)).toBe(false)
    expect(auth.isOriginAllowed({ headers: {
      origin: 'http://375-proxy-7777.dsw-gateway-cn-hongkong.data.aliyuncs.com',
      host: 'dsw-worker.internal:7777',
      'x-forwarded-proto': 'http',
    } }, true)).toBe(true)
    const strippedOriginRequest = { headers: {
      referer: 'https://375-proxy-7777.dsw-gateway-cn-hongkong.data.aliyuncs.com/live-sessions',
      host: '375-proxy-7777.dsw-gateway-cn-hongkong.data.aliyuncs.com',
      'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'x-forwarded-proto': 'http',
    } }
    expect(auth.isOriginAllowed(strippedOriginRequest, true)).toBe(true)
    expect(auth.isSecure(strippedOriginRequest)).toBe(true)
    expect(auth.isOriginAllowed({ headers: {
      ...strippedOriginRequest.headers, 'sec-fetch-site': 'cross-site',
    } }, true)).toBe(false)
    expect(auth.isOriginAllowed({ headers: {
      referer: 'https://attacker.example.test/live-sessions',
      host: '375-proxy-7777.dsw-gateway-cn-hongkong.data.aliyuncs.com',
      'sec-fetch-site': 'same-origin',
    } }, true)).toBe(false)
  })

  it('accepts an authenticated DSW WebSocket upgrade when the gateway strips origin headers', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'pi-live-auth-dsw-'))
    const tokenPath = path.join(base, 'live-control-token')
    const auth = new LiveSessionBrowserAuth({ tokenPath })
    cleanups.push(async () => { await auth.stop(); await rm(base, { recursive: true, force: true }) })
    await auth.start()
    const token = (await readFile(tokenPath, 'utf8')).trim()
    const result = await auth.authenticate(token, true)
    const cookie = result.setCookie.split(';', 1)[0]
    const headers = {
      host: '375-proxy-7777.dsw-gateway-cn-hongkong.data.aliyuncs.com',
      cookie,
      'x-forwarded-proto': 'http',
    }
    expect(auth.isOriginAllowed({ headers }, true)).toBe(true)
    expect(auth.isOriginAllowed({ headers: { ...headers, cookie: undefined } }, true)).toBe(false)
    const ticket = auth.issueWebSocketTicket({ headers: { cookie } })
    expect(ticket).toMatchObject({ ticket: expect.stringMatching(/^[a-f0-9]{64}$/), expiresAt: expect.any(Number) })
    expect(auth.consumeWebSocketTicket(ticket?.ticket)?.browserClientId).toBe(result.browserClientId)
    expect(auth.consumeWebSocketTicket(ticket?.ticket)).toBeUndefined()
  })

  it('rejects a symlinked browser control token', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'pi-live-auth-link-'))
    cleanups.push(() => rm(base, { recursive: true, force: true }))
    const target = path.join(base, 'target')
    const tokenPath = path.join(base, 'live-control-token')
    await writeFile(target, `${'a'.repeat(64)}\n`)
    await symlink(target, tokenPath)
    const auth = new LiveSessionBrowserAuth({ tokenPath })
    await expect(auth.start()).rejects.toThrow(/regular single-link file/)
  })

  it('does not expose session metadata before token authentication', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'pi-live-routes-'))
    const registry = new LiveSessionRegistry()
    const auth = new LiveSessionBrowserAuth({ tokenPath: path.join(base, 'live-control-token') })
    const app = express()
    app.use(express.json())
    const routes = createLiveSessionRoutes({ app, registry, auth })
    await routes.start()
    const server = app.listen(0, '127.0.0.1')
    server.on('upgrade', (request, socket, head) => {
      if (!routes.handleUpgrade(request, socket, head)) socket.destroy()
    })
    cleanups.push(async () => {
      await routes.stop(); await auth.stop(); await registry.stop()
      await new Promise(resolve => server.close(resolve))
      await rm(base, { recursive: true, force: true })
    })
    await new Promise(resolve => server.once('listening', resolve))
    const address = server.address()
    const origin = `http://127.0.0.1:${address.port}`
    expect((await fetch(`${origin}/api/live-sessions`)).status).toBe(401)
    const token = (await readFile(auth.tokenPath, 'utf8')).trim()
    const login = await fetch(`${origin}/api/live-sessions/auth`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ token }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')?.split(';')[0]
    expect(cookie).toContain('pi_live_session=')
    const list = await fetch(`${origin}/api/live-sessions`, { headers: { cookie } })
    expect(list.status).toBe(200)
    await expect(list.json()).resolves.toMatchObject({ sessions: [], browserClientId: expect.any(String) })
    const ticketResponse = await fetch(`${origin}/api/live-sessions/ws-ticket`, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: '{}',
    })
    expect(ticketResponse.status).toBe(200)
    const ticket = (await ticketResponse.json()).result.ticket
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/live-sessions/ws', {
      headers: { cookie, origin },
    })
    const firstFrame = await new Promise((resolve, reject) => {
      socket.once('message', data => resolve(JSON.parse(String(data))))
      socket.once('error', reject)
    })
    expect(firstFrame).toEqual({ type: 'live_session_attached', data: { sessions: [] } })
    socket.close()
    const proxySocket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/live-sessions/ws?ticket=${encodeURIComponent(ticket)}`,
      { headers: { Host: '375-proxy-7777.dsw-gateway-cn-hongkong.data.aliyuncs.com', 'X-Forwarded-Proto': 'http' } },
    )
    const proxyFirstFrame = await new Promise((resolve, reject) => {
      proxySocket.once('message', data => resolve(JSON.parse(String(data))))
      proxySocket.once('error', reject)
    })
    expect(proxyFirstFrame).toEqual({ type: 'live_session_attached', data: { sessions: [] } })
    proxySocket.close()
  })

  it('reloads every attached session through the bulk endpoint, and only for an authenticated browser', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'pi-live-reload-'))
    const registry = new LiveSessionRegistry({ commandTimeoutMs: 1_000 })
    const auth = new LiveSessionBrowserAuth({ tokenPath: path.join(base, 'live-control-token') })
    const app = express()
    app.use(express.json())
    const routes = createLiveSessionRoutes({ app, registry, auth })
    await routes.start()
    const server = app.listen(0, '127.0.0.1')
    cleanups.push(async () => {
      await routes.stop(); await auth.stop(); await registry.stop()
      await new Promise(resolve => server.close(resolve))
      await rm(base, { recursive: true, force: true })
    })
    await new Promise(resolve => server.once('listening', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`

    const commands = []
    const transport = {
      send(envelope) {
        if (envelope.type !== 'command') return
        commands.push(envelope.command)
        queueMicrotask(() => registry.handleCommandResult({ type: 'command_result', requestId: envelope.requestId, ok: true, result: {} }, transport))
      },
    }
    registry.connect(hello(), '/tmp/root/task', transport)
    registry.applySnapshot({ type: 'snapshot', processInstanceId: 'process-a', revision: 1, sequence: 0, summary: summary({ role: 'main' }), entries: [] }, transport, '/tmp/root/task')

    const token = (await readFile(auth.tokenPath, 'utf8')).trim()
    const login = await fetch(`${origin}/api/live-sessions/auth`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ token }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie').split(';', 1)[0]

    const anonymous = await fetch(`${origin}/api/live-sessions/reload`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}',
    })
    expect(anonymous.status).toBe(401)

    const response = await fetch(`${origin}/api/live-sessions/reload`, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: '{}',
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, result: { reloaded: ['process-a'], skipped: [], failed: [] } })
    expect(commands.filter(command => command.type === 'reload')).toEqual([{ type: 'reload' }])
  })
})

describe('LiveSessionBroker', () => {
  it('authenticates a real Unix socket client and cleans owned runtime files', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'pi-live-broker-'))
    const root = path.join(base, 'worktree')
    const cwd = path.join(root, 'task-a')
    const runDirectory = path.join(base, 'run')
    await mkdir(cwd, { recursive: true })
    const registry = new LiveSessionRegistry()
    const broker = new LiveSessionBroker({ registry, roots: [root], runDirectory, heartbeatMs: 1_000 })
    cleanups.push(async () => { await broker.stop(); await registry.stop(); await rm(base, { recursive: true, force: true }) })
    await broker.start()
    expect((await stat(runDirectory)).mode & 0o777).toBe(0o700)
    expect((await stat(broker.socketPath)).mode & 0o777).toBe(0o600)
    const token = (await readFile(broker.brokerTokenPath, 'utf8')).trim()
    const socket = createConnection(broker.socketPath)
    socket.setEncoding('utf8')
    let received = ''
    socket.on('data', chunk => { received += chunk })
    await new Promise(resolve => socket.once('connect', resolve))
    socket.write(`${JSON.stringify(hello({ brokerToken: token, cwd }))}\n`)
    await vi.waitFor(() => expect(received).toContain('"type":"welcome"'))
    socket.write(`${JSON.stringify({
      type: 'snapshot', processInstanceId: 'process-a', revision: 1, sequence: 0,
      summary: summary({ cwd, canonicalCwd: cwd }), entries: [],
    })}\n`)
    await vi.waitFor(() => expect(registry.list()).toHaveLength(1))
    socket.destroy()
    await broker.stop()
    await expect(stat(broker.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serves the session-family graph only to an authenticated browser, and only inside the pi sessions dir', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'pi-live-tree-routes-'))
    const sessionsRoot = path.join(base, 'sessions')
    const projectDir = path.join(sessionsRoot, '--tmp-tree-route--')
    await mkdir(projectDir, { recursive: true })
    const sessionHeader = JSON.stringify({
      type: 'session', version: 3, id: 'child-id', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/tree-route',
    })
    const userEntry = JSON.stringify({
      type: 'message', id: 'u1', parentId: null, timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    })
    const sessionFile = path.join(projectDir, 'child.jsonl')
    await writeFile(sessionFile, `${sessionHeader}\n${userEntry}\n`)

    const previousRoot = process.env.PI_DASH_SESSIONS_DIR
    process.env.PI_DASH_SESSIONS_DIR = sessionsRoot
    resetSessionTreeCaches()

    const registry = new LiveSessionRegistry()
    const auth = new LiveSessionBrowserAuth({ tokenPath: path.join(base, 'live-control-token') })
    const app = express()
    app.use(express.json())
    const routes = createLiveSessionRoutes({ app, registry, auth })
    await routes.start()
    const server = app.listen(0, '127.0.0.1')
    cleanups.push(async () => {
      await routes.stop(); await auth.stop(); await registry.stop()
      await new Promise(resolve => server.close(resolve))
      if (previousRoot === undefined) delete process.env.PI_DASH_SESSIONS_DIR
      else process.env.PI_DASH_SESSIONS_DIR = previousRoot
      resetSessionTreeCaches()
      await rm(base, { recursive: true, force: true })
    })
    await new Promise(resolve => server.once('listening', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const treeUrl = `${origin}/api/session-tree?file=${encodeURIComponent(sessionFile)}`

    // Mounted (not 404) and gated like every other live-session read route.
    expect((await fetch(treeUrl)).status).toBe(401)

    const token = (await readFile(auth.tokenPath, 'utf8')).trim()
    const login = await fetch(`${origin}/api/live-sessions/auth`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ token }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')?.split(';')[0]

    const missingParam = await fetch(`${origin}/api/session-tree`, { headers: { cookie } })
    expect(missingParam.status).toBe(400)
    await expect(missingParam.json()).resolves.toMatchObject({ error: 'session_file_unavailable' })

    const outside = path.join(base, 'outside.jsonl')
    await writeFile(outside, `${sessionHeader}\n`)
    const escaped = await fetch(`${origin}/api/session-tree?file=${encodeURIComponent(outside)}`, { headers: { cookie } })
    expect(escaped.status).toBe(403)
    await expect(escaped.json()).resolves.toMatchObject({ error: 'session_file_out_of_scope' })

    const absent = await fetch(`${origin}/api/session-tree?file=${encodeURIComponent(path.join(projectDir, 'nope.jsonl'))}`, { headers: { cookie } })
    expect(absent.status).toBe(404)
    await expect(absent.json()).resolves.toMatchObject({ error: 'session_file_not_found' })

    const ok = await fetch(treeUrl, { headers: { cookie } })
    expect(ok.status).toBe(200)
    await expect(ok.json()).resolves.toMatchObject({
      ok: true,
      result: { focusKey: 'child', sessions: [{ key: 'child', isFocus: true }], nodes: [{ id: 'u1', isHead: true }] },
    })
  })
})

describe('LiveSession timeline entry-id binding', () => {
  it('folds a message_entry carrier into the message it belongs to, and never renders it', () => {
    const registry = new LiveSessionRegistry()
    const transport = { send: () => {} }
    registry.connect(hello(), '/tmp/root/task', transport)
    registry.applySnapshot(
      { type: 'snapshot', processInstanceId: 'process-a', revision: 1, sequence: 0, summary: summary(), entries: [] },
      transport,
      '/tmp/root/task',
    )

    registry.applyEvent({
      type: 'event', processInstanceId: 'process-a', sequence: 1,
      event: { type: 'message_end', data: { message: { role: 'user', content: 'fork me' } } },
    }, transport)
    registry.applyEvent({
      type: 'event', processInstanceId: 'process-a', sequence: 2,
      event: { type: 'message_entry', data: { entryId: 'entry-9' } },
    }, transport)

    const entries = registry.get('process-a').entries
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ type: 'message_end', data: { entryId: 'entry-9' } })
  })
})
