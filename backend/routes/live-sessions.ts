import type { Express, NextFunction, Request, Response } from 'express'
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import WebSocket, { WebSocketServer } from 'ws'
import type { LiveSessionBrowserEvent, LiveSessionBrowserEventType } from '../../shared/src/live-sessions.js'
import { LiveSessionBrowserAuth, type LiveSessionBrowserIdentity } from '../live-sessions/auth.js'
import { LiveSessionGroupStore } from '../live-sessions/groups.js'
import { LiveSessionMetaStore } from '../live-sessions/meta.js'
import { LiveSessionOrderStore } from '../live-sessions/order.js'
import { LivePiLauncher } from '../live-sessions/launcher.js'
import { LiveSessionProtocolError } from '../live-sessions/protocol.js'
import { LiveSessionRegistry, LiveSessionRegistryError } from '../live-sessions/registry.js'
import { LiveSessionCloseError, closeLiveSession } from '../live-sessions/session-close.js'
import { SessionForkError, createBranchedSessionFile } from '../live-sessions/session-fork.js'
import { SessionTreeError, buildSessionFamilyGraph, readSessionCompactions } from '../live-sessions/session-tree.js'

export interface LiveSessionRouteOptions {
  app: Express
  registry: LiveSessionRegistry
  auth: LiveSessionBrowserAuth
  disconnectGraceMs?: number
  groupStore?: LiveSessionGroupStore
  metaStore?: LiveSessionMetaStore
  orderStore?: LiveSessionOrderStore
  launcher?: LivePiLauncher
  /** Overridable in tests so the close path never signals a real process. */
  closeSession?: typeof closeLiveSession
}

type AuthenticatedRequest = Request & { liveSessionIdentity?: LiveSessionBrowserIdentity }

function errorStatus(error: unknown): number {
  const code = error instanceof LiveSessionRegistryError || error instanceof LiveSessionProtocolError || error instanceof SessionTreeError || error instanceof SessionForkError || error instanceof LiveSessionCloseError ? error.code : ''
  if (code === 'live_session_not_found') return 404
  if (code === 'not_a_subagent') return 403
  if (code === 'live_session_pid_invalid') return 400
  if (code === 'live_session_pid_unverifiable') return 409
  if (code === 'session_already_claimed') return 423
  if (code === 'command_timeout') return 504
  if (code === 'out_of_scope') return 403
  if (code === 'invalid_lease' || code === 'deliver_as_required' || code === 'live_session_unavailable') return 409
  if (code === 'session_file_out_of_scope') return 403
  if (code === 'session_file_not_found') return 404
  if (code === 'session_entry_not_found') return 400
  if (code === 'session_file_unavailable') return 400
  if (code.startsWith('invalid_') || code === 'unsupported_command' || code === 'command_too_large') return 400
  if (error instanceof Error && error.message === 'group_not_found') return 404
  if (error instanceof Error && (error.message === 'group_name_required' || error.message === 'invalid_thinking_level' || error.message === 'model_id_required' || error.message === 'model_provider_required' || error.message === 'invalid_fork_from')) return 400
  if (error instanceof Error && error.message === 'live_pi_start_failed') return 500
  if (error instanceof Error && error.message.includes('outside configured live session roots')) return 403
  return 500
}

function errorBody(error: unknown): { error: string; message: string } {
  return {
    error: error instanceof LiveSessionRegistryError || error instanceof LiveSessionProtocolError || error instanceof SessionTreeError || error instanceof SessionForkError || error instanceof LiveSessionCloseError ? error.code : 'live_session_error',
    message: error instanceof Error ? error.message : String(error),
  }
}

function logRejectedOrigin(request: IncomingMessage): void {
  console.warn('[live-sessions] Rejected browser Origin', JSON.stringify({
    origin: request.headers.origin,
    referer: request.headers.referer,
    host: request.headers.host,
    forwarded: request.headers.forwarded,
    secFetchSite: request.headers['sec-fetch-site'],
    secFetchMode: request.headers['sec-fetch-mode'],
    xForwardedHost: request.headers['x-forwarded-host'],
    xForwardedProto: request.headers['x-forwarded-proto'],
    xOriginalHost: request.headers['x-original-host'],
  }))
}

export class LiveSessionRoutes {
  private readonly app: Express
  private readonly registry: LiveSessionRegistry
  private readonly auth: LiveSessionBrowserAuth
  private readonly disconnectGraceMs: number
  private readonly groupStore: LiveSessionGroupStore
  private readonly metaStore: LiveSessionMetaStore
  private readonly orderStore: LiveSessionOrderStore
  private readonly launcher?: LivePiLauncher
  private readonly closeSession: typeof closeLiveSession
  private readonly wss = new WebSocketServer({ noServer: true })
  private readonly clients = new Map<WebSocket, LiveSessionBrowserIdentity>()
  private readonly releaseTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly listeners = new Map<string, (...args: any[]) => void>()
  /** Last pi `sessionId` seen per process, so an in-process session switch can be told apart from a plain refresh. */
  private readonly knownSessionIds = new Map<string, string>()
  private registered = false
  private active = false
  private startPromise?: Promise<void>

  constructor(options: LiveSessionRouteOptions) {
    this.app = options.app
    this.registry = options.registry
    this.auth = options.auth
    this.disconnectGraceMs = options.disconnectGraceMs ?? 15_000
    this.groupStore = options.groupStore ?? new LiveSessionGroupStore()
    this.metaStore = options.metaStore ?? new LiveSessionMetaStore()
    this.orderStore = options.orderStore ?? new LiveSessionOrderStore()
    this.launcher = options.launcher
    this.closeSession = options.closeSession ?? closeLiveSession
  }

  start(): Promise<void> {
    if (!this.registered) {
      this.registerHttpRoutes()
      this.registered = true
    }
    if (!this.active) {
      this.active = true
      this.subscribeRegistry()
    }
    if (!this.startPromise) this.startPromise = Promise.all([this.auth.start(), this.groupStore.start(), this.metaStore.start(), this.orderStore.start()]).then(() => undefined).catch(error => {
      this.active = false
      this.unsubscribeRegistry()
      this.startPromise = undefined
      throw error
    })
    return this.startPromise
  }

  async stop(): Promise<void> {
    if (!this.active && !this.startPromise) return
    this.active = false
    this.unsubscribeRegistry()
    for (const timer of this.releaseTimers.values()) clearTimeout(timer)
    this.releaseTimers.clear()
    const browserIds = new Set([...this.clients.values()].map(identity => identity.browserClientId))
    for (const client of this.clients.keys()) client.terminate()
    this.clients.clear()
    await Promise.allSettled([...browserIds].map(id => this.registry.releaseByBrowser(id)))
    await this.launcher?.stop()
    this.startPromise = undefined
  }

  async cleanup(): Promise<void> {
    await this.stop()
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(request.url || '/', 'http://live-session.local')
    if (url.pathname !== '/api/live-sessions/ws') return false
    const ticketIdentity = this.auth.consumeWebSocketTicket(url.searchParams.get('ticket'))
    if (!this.active || !this.auth.isOriginAllowed(request, true, ticketIdentity)) {
      if (this.active) logRejectedOrigin(request)
      this.rejectUpgrade(socket, 403, 'Forbidden')
      return true
    }
    const identity = ticketIdentity || this.auth.getIdentity(request)
    if (!identity) {
      this.rejectUpgrade(socket, 401, 'Unauthorized')
      return true
    }
    this.wss.handleUpgrade(request, socket, head, ws => this.acceptWebSocket(ws, identity))
    return true
  }

  private registerHttpRoutes(): void {
    this.app.post('/api/live-sessions/auth', async (req: Request, res: Response) => {
      if (!this.active) return res.status(503).json({ error: 'live_sessions_unavailable' })
      if (!this.auth.isOriginAllowed(req, true)) {
        logRejectedOrigin(req)
        return res.status(403).json({ error: 'cross_origin_forbidden' })
      }
      try {
        const result = await this.auth.authenticate(req.body?.token, this.auth.isSecure(req) || !!(req.socket as any).encrypted)
        if (!result) return res.status(401).json({ error: 'authentication_failed' })
        res.setHeader('Set-Cookie', result.setCookie)
        res.json({ ok: true, browserClientId: result.browserClientId })
      } catch (error) {
        res.status(500).json(errorBody(error))
      }
    })

    const requireAuth = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
      if (!this.active) { res.status(503).json({ error: 'live_sessions_unavailable' }); return }
      const identity = this.auth.getIdentity(req)
      if (!identity) { res.status(401).json({ error: 'authentication_required' }); return }
      this.markBrowserActive(identity.browserClientId)
      req.liveSessionIdentity = identity
      next()
    }
    const requireMutationOrigin = (req: Request, res: Response, next: NextFunction): void => {
      if (!this.auth.isOriginAllowed(req, true)) {
        logRejectedOrigin(req)
        res.status(403).json({ error: 'cross_origin_forbidden' })
        return
      }
      next()
    }

    this.app.post('/api/live-sessions/ws-ticket', requireMutationOrigin, requireAuth, (req: AuthenticatedRequest, res: Response) => {
      const result = this.auth.issueWebSocketTicket(req)
      if (!result) return res.status(401).json({ error: 'authentication_required' })
      res.json({ ok: true, result })
    })

    this.app.post('/api/live-sessions/start', requireMutationOrigin, requireAuth, async (req: Request, res: Response) => {
      await this.respond(res, async () => {
        if (!this.launcher) throw new LiveSessionRegistryError('live_sessions_unavailable', 'live Pi launcher is unavailable')
        const body = req.body || {}
        const cwd = typeof body.cwd === 'string' ? body.cwd.trim() : ''
        if (!cwd) throw new LiveSessionProtocolError('invalid_cwd', 'cwd is required')
        const model = typeof body.model === 'string' ? body.model.trim() : ''
        const separator = model.indexOf('/')
        const forkFrom = typeof body.forkFrom === 'string' ? body.forkFrom.trim() : ''
        const result = await this.launcher.start({
          cwd,
          ...(separator > 0 ? { modelProvider: model.slice(0, separator), modelId: model.slice(separator + 1) } : model ? { modelId: model } : {}),
          ...(typeof body.thinkingLevel === 'string' ? { thinkingLevel: body.thinkingLevel } : {}),
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
          ...(forkFrom ? { forkFrom } : {}),
        })
        // The tmux session is the terminal access path and the close handle, so
        // it is stored with the session (keyed by pi sessionId, like tags/pin).
        // Machine-written: the HTTP PATCH below never accepts this field.
        if (result.sessionId) await this.metaStore.update(result.sessionId, { tmux: result.tmuxSession })
        return { ok: true, result }
      })
    })

    // Entry-level fork: extract the source session's root→entry branch into a NEW
    // session file and start a fresh Pi on it. The source session keeps running,
    // so the fork can sit beside it in the sidebar (group/pin/order are applied
    // by the caller once it knows the new sessionId).
    this.app.post('/api/live-sessions/:processInstanceId/fork', requireMutationOrigin, requireAuth, async (req: Request, res: Response) => {
      await this.respond(res, async () => {
        if (!this.launcher) throw new LiveSessionRegistryError('live_sessions_unavailable', 'live Pi launcher is unavailable')
        const detail = this.registry.get(req.params.processInstanceId as string)
        if (!detail) throw new LiveSessionRegistryError('live_session_not_found', 'live session is not available')
        const entryId = typeof req.body?.entryId === 'string' ? req.body.entryId.trim() : ''
        if (!entryId) throw new LiveSessionProtocolError('invalid_entry_id', 'entryId is required')
        const summary = detail.summary
        if (!summary.sessionFile) throw new LiveSessionProtocolError('session_file_unavailable', 'the session has no session file yet')
        const branched = createBranchedSessionFile(summary.sessionFile, entryId)
        const result = await this.launcher.start({
          cwd: summary.canonicalCwd || summary.cwd,
          ...(summary.model ? { modelProvider: summary.model.provider, modelId: summary.model.id } : {}),
          ...(summary.thinkingLevel ? { thinkingLevel: summary.thinkingLevel } : {}),
          title: `${summary.sessionName || `Pi ${summary.pid}`} · 分叉`,
          sessionFile: branched,
        })
        if (result.sessionId) await this.metaStore.update(result.sessionId, { tmux: result.tmuxSession })
        return { ok: true, result: { ...result, forkedFrom: summary.sessionFile, entryId } }
      })
    })

    this.app.get('/api/live-sessions', requireAuth, (req: AuthenticatedRequest, res: Response) => {
      res.json({ sessions: this.registry.list(), browserClientId: req.liveSessionIdentity!.browserClientId })
    })

    /**
     * Reload every attached session at once.
     *
     * Bulk counterpart of the per-session `重载` button: after dashboard
     * extensions / skills / prompts / themes change, each running Pi has to
     * re-read them, and doing that session by session is tedious. Subagent child
     * processes are skipped so a running task is not killed, and per-session
     * failures come back in `result.failed` instead of failing the whole request.
     */
    this.app.post('/api/live-sessions/reload', requireMutationOrigin, requireAuth, async (_req: Request, res: Response) => {
      await this.respond(res, async () => ({ ok: true, result: await this.registry.reloadAll() }))
    })

    this.app.get('/api/live-session-groups', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
      res.json({ groups: await this.groupStore.list() })
    })

    this.app.post('/api/live-session-groups', requireMutationOrigin, requireAuth, async (req: Request, res: Response) => {
      await this.respond(res, async () => ({ ok: true, groups: await this.groupStore.create(typeof req.body?.name === 'string' ? req.body.name : '') }))
    })

    this.app.patch('/api/live-session-groups/:groupId', requireMutationOrigin, requireAuth, async (req: Request, res: Response) => {
      await this.respond(res, async () => ({ ok: true, groups: await this.groupStore.rename(req.params.groupId as string, typeof req.body?.name === 'string' ? req.body.name : '') }))
    })

    this.app.delete('/api/live-session-groups/:groupId', requireMutationOrigin, requireAuth, async (req: Request, res: Response) => {
      await this.respond(res, async () => ({ ok: true, groups: await this.groupStore.remove(req.params.groupId as string) }))
    })

    this.app.post('/api/live-session-groups/:groupId/members', requireMutationOrigin, requireAuth, async (req: Request, res: Response) => {
      await this.respond(res, async () => {
        const processInstanceId = typeof req.body?.processInstanceId === 'string' ? req.body.processInstanceId : ''
        const detail = processInstanceId ? this.registry.get(processInstanceId) : undefined
        if (!detail) throw new LiveSessionRegistryError('live_session_not_found', 'live session is not available')
        return { ok: true, groups: await this.groupStore.addMember(req.params.groupId as string, detail.summary.sessionId) }
      })
    })

    this.app.delete('/api/live-session-groups/:groupId/members/:sessionId', requireMutationOrigin, requireAuth, async (req: Request, res: Response) => {
      await this.respond(res, async () => ({ ok: true, groups: await this.groupStore.removeMember(req.params.groupId as string, req.params.sessionId as string) }))
    })

    // Sidebar tags/pin for live sessions (keyed by pi sessionId, not the
    // short-lived processInstanceId, so metadata survives a Pi restart).
    this.app.get('/api/live-session-meta', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
      res.json({ meta: await this.metaStore.list() })
    })

    // Manual sidebar order for live sessions (same sessionId keying as meta).
    // Whole-list replace, so one drag costs one request instead of N index bumps.
    this.app.get('/api/live-session-order', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
      res.json({ order: await this.orderStore.list() })
    })

    this.app.put('/api/live-session-order', requireMutationOrigin, requireAuth, async (req: Request, res: Response) => {
      await this.respond(res, async () => ({ ok: true, order: await this.orderStore.replace(req.body?.order) }))
    })

    this.app.patch('/api/live-sessions/:processInstanceId/meta', requireMutationOrigin, requireAuth, async (req: Request, res: Response) => {
      await this.respond(res, async () => {
        const detail = this.registry.get(req.params.processInstanceId as string)
        if (!detail) throw new LiveSessionRegistryError('live_session_not_found', 'live session is not available')
        const body = req.body || {}
        const meta = await this.metaStore.update(detail.summary.sessionId, {
          ...(Object.prototype.hasOwnProperty.call(body, 'tags') ? { tags: body.tags } : {}),
          ...(Object.prototype.hasOwnProperty.call(body, 'pinned') ? { pinned: body.pinned } : {}),
        })
        return { ok: true, meta, all: await this.metaStore.list() }
      })
    })

    this.app.get('/api/live-sessions/:processInstanceId', requireAuth, (req: Request, res: Response) => {
      const detail = this.registry.get(req.params.processInstanceId as string)
      if (!detail) return res.status(404).json({ error: 'live_session_not_found' })
      res.json(detail)
    })

    // Session-family graph (read-only). The focused file plus every session
    // linked through `header.parentSession`, so forked/cloned sessions show up as
    // one tree. Keyed by absolute session file path (not processInstanceId) so a
    // session that is no longer running can still be inspected. No broker
    // round-trip: the files on disk are the truth.
    this.app.get('/api/session-tree', requireAuth, async (req: Request, res: Response) => {
      await this.respond(res, async () => {
        const file = typeof req.query.file === 'string' ? req.query.file.trim() : ''
        if (!file) throw new SessionTreeError('session_file_unavailable', 'file query parameter is required')
        const expandParam = typeof req.query.expand === 'string' ? req.query.expand : ''
        const stepsParam = typeof req.query.steps === 'string' ? Number.parseInt(req.query.steps, 10) : undefined
        const graph = await buildSessionFamilyGraph({
          sessionFile: file,
          liveSessionIds: new Set(this.registry.list().map(summary => summary.sessionId)),
          expandLinearRuns: req.query.detail === 'full',
          // `expand` carries folded-run ids (`run:<headId>`), optionally comma-separated.
          ...(expandParam ? { expandRuns: new Set(expandParam.split(',').map(value => value.trim()).filter(Boolean)) } : {}),
          // `steps` is the per-run step window (the UI's “加载更多” raises it).
          ...(stepsParam !== undefined && Number.isFinite(stepsParam) ? { expandStepLimit: stepsParam } : {}),
        })
        return { ok: true, result: graph }
      })
    })

    /**
     * Compaction markers for one session file.
     *
     * `/compact` is fire-and-forget on the agent side (`ctx.compact()` does not
     * await), so a browser cannot learn from the command ack when compaction really
     * finished. It polls these markers instead, comparing them against the server
     * `now` (browser clocks may be skewed from the machine that writes the file).
     */
    this.app.get('/api/session-compactions', requireAuth, async (req: Request, res: Response) => {
      await this.respond(res, async () => {
        const file = typeof req.query.file === 'string' ? req.query.file.trim() : ''
        if (!file) throw new SessionTreeError('session_file_unavailable', 'file query parameter is required')
        return { ok: true, result: { now: Date.now(), compactions: await readSessionCompactions(file) } }
      })
    })

    this.app.post('/api/live-sessions/:processInstanceId/claim', requireMutationOrigin, requireAuth, async (req: AuthenticatedRequest, res: Response) => {
      await this.respond(res, async () => {
        const requestedLeaseMs = req.body?.requestedLeaseMs ?? 30_000
        const result = await this.registry.claim(req.params.processInstanceId as string, req.liveSessionIdentity!.browserClientId, requestedLeaseMs)
        return { ok: true, result }
      })
    })

    this.app.post('/api/live-sessions/:processInstanceId/renew', requireMutationOrigin, requireAuth, async (req: AuthenticatedRequest, res: Response) => {
      await this.respond(res, async () => ({
        ok: true,
        result: await this.registry.renew(req.params.processInstanceId as string, req.liveSessionIdentity!.browserClientId, req.body?.leaseId),
      }))
    })

    this.app.post('/api/live-sessions/:processInstanceId/release', requireMutationOrigin, requireAuth, async (req: AuthenticatedRequest, res: Response) => {
      await this.respond(res, async () => ({
        ok: true,
        result: await this.registry.release(req.params.processInstanceId as string, req.liveSessionIdentity!.browserClientId, req.body?.leaseId),
      }))
    })

    this.app.post('/api/live-sessions/:processInstanceId/commands', requireMutationOrigin, requireAuth, async (req: AuthenticatedRequest, res: Response) => {
      await this.respond(res, async () => ({
        ok: true,
        result: await this.registry.sendBrowserCommand(req.params.processInstanceId as string, req.liveSessionIdentity!.browserClientId, req.body?.command),
      }))
    })

    /**
     * Close one live session.
     *
     * A tmux-first session dies with its tmux session (the same handle the
     * sidebar row uses). A subagent child process has no tmux session, so it is
     * signalled directly and the registry drops the row once it exits.
     *
     * Only subagent sessions are closable here: ending a main session is a much
     * bigger action and stays with the sidebar's explicit tmux close.
     */
    this.app.post('/api/live-sessions/:processInstanceId/close', requireMutationOrigin, requireAuth, async (req: Request, res: Response) => {
      await this.respond(res, async () => {
        const detail = this.registry.get(req.params.processInstanceId as string)
        if (!detail) throw new LiveSessionRegistryError('live_session_not_found', 'live session is not available')
        const { summary } = detail
        if (summary.role !== 'subagent') throw new LiveSessionRegistryError('not_a_subagent', 'only subagent live sessions can be closed from here')
        const tmuxSession = (await this.metaStore.list())[summary.sessionId]?.tmux
        const result = await this.closeSession({
          pid: summary.pid,
          ...(tmuxSession ? { tmuxSession } : {}),
        })
        return { ok: true, result }
      })
    })
  }

  private async respond(res: Response, operation: () => Promise<unknown>): Promise<void> {
    try { res.json(await operation()) } catch (error) { res.status(errorStatus(error)).json(errorBody(error)) }
  }

  private subscribeRegistry(): void {
    const bindings: [string, LiveSessionBrowserEventType][] = [
      ['attached', 'live_session_attached'],
      ['snapshot', 'live_session_snapshot'],
      ['event', 'live_session_event'],
      ['claim_changed', 'live_session_claim_changed'],
      ['reconnecting', 'live_session_reconnecting'],
      ['detached', 'live_session_detached'],
      ['session_error', 'live_session_error'],
    ]
    for (const [registryEvent, browserEvent] of bindings) {
      const listener = (data: unknown) => {
        // `attached` / `snapshot` carry the summary; the other bindings do not.
        if (registryEvent === 'attached' || registryEvent === 'snapshot') this.followSessionSwitch(data)
        this.broadcast({ type: browserEvent, data })
      }
      this.listeners.set(registryEvent, listener)
      this.registry.on(registryEvent, listener)
    }
  }

  /**
   * Follow an in-process session switch (`/clear`, `/ls-fork`).
   *
   * The row is a `processInstanceId`, but every sidebar store (manual order, task
   * groups, tags/pin) is keyed by the pi `sessionId`, which `/clear` changes while
   * the process keeps running. Detected from the summary itself instead of from
   * registry entry state, so it also covers a row whose entry was torn down and
   * recreated in between.
   */
  private followSessionSwitch(data: unknown): void {
    const summary = (data as { summary?: { processInstanceId?: unknown; sessionId?: unknown } } | undefined)?.summary
    const processInstanceId = typeof summary?.processInstanceId === 'string' ? summary.processInstanceId : ''
    const sessionId = typeof summary?.sessionId === 'string' ? summary.sessionId : ''
    if (!processInstanceId || !sessionId) return
    const previous = this.knownSessionIds.get(processInstanceId)
    this.knownSessionIds.set(processInstanceId, sessionId)
    if (!previous || previous === sessionId) return
    // Storage keys move; a failed write only logs so the switch itself is never
    // held back by sidebar bookkeeping.
    void Promise.all([
      this.orderStore.rekey(previous, sessionId),
      this.metaStore.rekey(previous, sessionId),
      this.groupStore.rekey(previous, sessionId),
    ]).catch(error => console.error('[live-sessions] Failed to re-key sidebar stores:', error))
  }

  private unsubscribeRegistry(): void {
    for (const [event, listener] of this.listeners) this.registry.off(event, listener)
    this.listeners.clear()
  }

  private markBrowserActive(browserClientId: string): void {
    const timer = this.releaseTimers.get(browserClientId)
    if (!timer) return
    clearTimeout(timer)
    this.releaseTimers.delete(browserClientId)
  }

  private acceptWebSocket(ws: WebSocket, identity: LiveSessionBrowserIdentity): void {
    this.markBrowserActive(identity.browserClientId)
    this.clients.set(ws, identity)
    this.send(ws, { type: 'live_session_attached', data: { sessions: this.registry.list() } })
    for (const summary of this.registry.list()) {
      const detail = this.registry.get(summary.processInstanceId)
      if (detail) this.send(ws, { type: 'live_session_snapshot', data: detail })
    }
    ws.on('close', () => this.onWebSocketClose(ws, identity.browserClientId))
    ws.on('error', () => {})
  }

  private onWebSocketClose(ws: WebSocket, browserClientId: string): void {
    this.clients.delete(ws)
    if ([...this.clients.values()].some(identity => identity.browserClientId === browserClientId)) return
    const timer = setTimeout(() => {
      this.releaseTimers.delete(browserClientId)
      void this.registry.releaseByBrowser(browserClientId)
    }, this.disconnectGraceMs)
    timer.unref?.()
    this.releaseTimers.set(browserClientId, timer)
  }

  private broadcast(message: LiveSessionBrowserEvent): void {
    for (const client of this.clients.keys()) this.send(client, message)
  }

  private send(ws: WebSocket, message: LiveSessionBrowserEvent): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
  }

  private rejectUpgrade(socket: Duplex, status: number, message: string): void {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    socket.destroy()
  }
}

export function createLiveSessionRoutes(options: LiveSessionRouteOptions): LiveSessionRoutes {
  return new LiveSessionRoutes(options)
}

export function registerLiveSessionRoutes(options: LiveSessionRouteOptions): LiveSessionRoutes {
  const routes = createLiveSessionRoutes(options)
  void routes.start()
  return routes
}
