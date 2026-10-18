import { readFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import WebSocket from 'ws'
import type {
  LiveSessionBrowserEvent,
  LiveSessionInputChannel,
  LiveSessionModelOption,
  LiveSessionSummary,
} from '../../../shared/src/live-sessions.js'
import type { LarkGatewayConfig } from './config.js'

/**
 * A dashboard HTTP failure that keeps the status and the machine-readable code,
 * so callers can react to a specific rejection (e.g. `session_already_claimed`)
 * instead of matching on message text.
 */
export class DashboardRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DashboardRequestError'
  }
}

/** Keep the historical `label: status body` message, plus the parsed code. */
function requestError(label: string, status: number, body: string): DashboardRequestError {
  let code = label
  try {
    const parsed = JSON.parse(body) as { error?: unknown; code?: unknown }
    const reported = typeof parsed?.error === 'string' ? parsed.error : typeof parsed?.code === 'string' ? parsed.code : ''
    if (reported) code = reported
  } catch {
    /* non-JSON body: the label stays the code */
  }
  return new DashboardRequestError(status, code, `${label}: ${status} ${body}`)
}

/** `{ ok, result }` envelopes come from the live-session routes; plain bodies from the rest. */
function readResult(body: string): unknown {
  const parsed = JSON.parse(body) as { result?: unknown }
  return parsed && typeof parsed === 'object' && 'result' in parsed ? parsed.result : parsed
}

interface HttpResult {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

function httpRequest(
  url: string,
  options: { method: string; headers: Record<string, string>; body?: string },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const lib = target.protocol === 'https:' ? https : http
    const req = lib.request(
      target,
      { method: options.method, headers: options.headers },
      res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk as Buffer))
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

/**
 * A headless "browser" client for pi-dashboard live-sessions.
 *
 * Uses the exact same public client channel the web frontend uses, so the
 * dashboard backend needs no changes: token -> cookie -> ws-ticket -> WS.
 */
export class DashboardClient {
  private cookie?: string
  private ws?: WebSocket
  private onFrame?: (frame: LiveSessionBrowserEvent) => void
  private stopped = false
  private reconnectAttempts = 0
  private reconnectTimer?: NodeJS.Timeout

  constructor(private readonly cfg: LarkGatewayConfig) {}

  get origin(): string {
    return new URL(this.cfg.dashboardBaseUrl).origin
  }

  /** Attach the dashboard origin so `isOriginAllowed` accepts our requests. */
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { origin: this.origin, ...extra }
  }

  private async ensureCookie(): Promise<string> {
    if (this.cookie) return this.cookie
    const token = (await readFile(this.cfg.controlTokenPath, 'utf8')).trim()
    const res = await httpRequest(`${this.cfg.dashboardBaseUrl}/api/live-sessions/auth`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ token }),
    })
    if (res.status !== 200) throw new Error(`auth_failed: ${res.status} ${res.body}`)
    const setCookie = res.headers['set-cookie']?.[0]
    if (!setCookie) throw new Error('auth_failed: no cookie returned')
    this.cookie = setCookie.split(';')[0]
    return this.cookie
  }

  private async requestWithCookie(
    url: string,
    options: { method: string; headers?: Record<string, string>; body?: string },
    refreshStatuses: readonly number[] = [401],
  ): Promise<HttpResult> {
    const request = (cookie: string) =>
      httpRequest(url, {
        ...options,
        headers: this.headers({ ...options.headers, cookie }),
      })

    let cookie = await this.ensureCookie()
    let res = await request(cookie)
    if (refreshStatuses.includes(res.status)) {
      if (this.cookie === cookie) this.cookie = undefined
      cookie = await this.ensureCookie()
      res = await request(cookie)
    }
    return res
  }

  async listSessions(): Promise<LiveSessionSummary[]> {
    const res = await this.requestWithCookie(`${this.cfg.dashboardBaseUrl}/api/live-sessions`, {
      method: 'GET',
    })
    if (res.status !== 200) throw requestError('list_failed', res.status, res.body)
    return (JSON.parse(res.body) as { sessions: LiveSessionSummary[] }).sessions
  }

  /** Send a user message into a live session (the input channel). */
  async sendInput(
    processInstanceId: string,
    text: string,
    channel: LiveSessionInputChannel = 'chatapp',
  ): Promise<void> {
    const res = await this.requestWithCookie(
      `${this.cfg.dashboardBaseUrl}/api/live-sessions/${encodeURIComponent(processInstanceId)}/commands`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: { type: 'input', text, channel } }),
      },
    )
    if (res.status !== 200) throw requestError('command_failed', res.status, res.body)
  }

  /**
   * Run one structured live-session command (model switch, compact, reload, …).
   * These are the same commands the web UI sends; TUI built-ins such as
   * `/compact` do NOT work as plain `input` text.
   */
  async command(processInstanceId: string, command: unknown): Promise<unknown> {
    const res = await this.post(
      'command_failed',
      `/api/live-sessions/${encodeURIComponent(processInstanceId)}/commands`,
      { command },
    )
    return readResult(res.body)
  }

  /** Models this session can switch to. */
  async models(processInstanceId: string): Promise<LiveSessionModelOption[]> {
    const result = await this.command(processInstanceId, { type: 'get_models' })
    const models = (result as { models?: LiveSessionModelOption[] } | undefined)?.models
    return Array.isArray(models) ? models : []
  }

  /**
   * Take the exclusive write lease for a session. `compact`, `abort` and the
   * feature commands require it; only one client can hold it at a time.
   */
  async claim(processInstanceId: string, requestedLeaseMs = 30_000): Promise<{ leaseId: string; expiresAt?: number }> {
    const res = await this.post('claim_failed', `/api/live-sessions/${encodeURIComponent(processInstanceId)}/claim`, { requestedLeaseMs })
    const result = readResult(res.body) as { leaseId?: unknown; expiresAt?: unknown } | undefined
    const leaseId = typeof result?.leaseId === 'string' ? result.leaseId : ''
    if (!leaseId) throw new Error('claim_failed: the dashboard did not return a leaseId')
    return { leaseId, ...(typeof result?.expiresAt === 'number' ? { expiresAt: result.expiresAt } : {}) }
  }

  /** Give the lease back so the web UI can take over again. */
  async release(processInstanceId: string, leaseId: string): Promise<void> {
    await this.post('release_failed', `/api/live-sessions/${encodeURIComponent(processInstanceId)}/release`, { leaseId })
  }

  /** Start a new live session (pi in a fresh tmux session). Returns the raw start result. */
  async startSession(cwd: string, title?: string): Promise<{ sessionId?: string; tmuxSession?: string }> {
    const res = await this.requestWithCookie(`${this.cfg.dashboardBaseUrl}/api/live-sessions/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd, ...(title ? { title } : {}) }),
    })
    if (res.status !== 200) throw requestError('start_failed', res.status, res.body)
    const parsed = JSON.parse(res.body) as { result?: { sessionId?: string; tmuxSession?: string } }
    return parsed.result ?? {}
  }

  /** POST a JSON body and turn a non-200 into a `DashboardRequestError`. */
  private async post(label: string, path: string, payload: unknown): Promise<HttpResult> {
    const res = await this.requestWithCookie(`${this.cfg.dashboardBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    })
    if (res.status !== 200) throw requestError(label, res.status, res.body)
    return res
  }

  /**
   * Open the live event stream (the output port) and invoke `onEvent` per
   * frame. The connection is self-healing: on close it reconnects with
   * exponential backoff, refreshing the auth cookie when the dashboard has
   * restarted or the session has expired. Never throws — the dashboard may still be starting up.
   */
  async subscribe(onEvent: (frame: LiveSessionBrowserEvent) => void): Promise<void> {
    this.onFrame = onEvent
    this.stopped = false
    await this.openSocket()
  }

  private async openSocket(): Promise<void> {
    if (this.stopped) return
    try {
      await this.ensureCookie()
      const ticket = await this.fetchTicket()
      const cookie = await this.ensureCookie()
      const wsUrl = `${this.cfg.dashboardBaseUrl.replace(/^http/, 'ws')}/api/live-sessions/ws?ticket=${encodeURIComponent(ticket)}`
      const ws = new WebSocket(wsUrl, { headers: this.headers({ cookie }) })
      ws.on('message', raw => {
        try {
          this.onFrame?.(JSON.parse(String(raw)) as LiveSessionBrowserEvent)
        } catch {
          /* ignore malformed frame */
        }
      })
      ws.on('open', () => {
        this.reconnectAttempts = 0
        console.log('[dashboard] ws connected')
      })
      // A missing 'error' listener would throw; the following 'close' drives retry.
      ws.on('error', () => {})
      ws.on('close', () => {
        if (this.ws === ws) this.ws = undefined
        this.scheduleReconnect()
      })
      this.ws = ws
    } catch (error) {
      console.warn(`[dashboard] connect failed (${message(error)}); will retry`)
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000)
    this.reconnectAttempts += 1
    console.log(`[dashboard] reconnecting in ${Math.round(delay / 1000)}s`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.openSocket()
    }, delay)
  }

  private async fetchTicket(): Promise<string> {
    const res = await this.requestWithCookie(
      `${this.cfg.dashboardBaseUrl}/api/live-sessions/ws-ticket`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      [401, 403],
    )
    if (res.status !== 200) throw new Error(`ws_ticket_failed: ${res.status} ${res.body}`)
    return (JSON.parse(res.body) as { result: { ticket: string } }).result.ticket
  }

  close(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.ws?.close()
    this.ws = undefined
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
