import { readFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import WebSocket from 'ws'
import type { LiveSessionBrowserEvent, LiveSessionInputChannel, LiveSessionSummary } from '../../../shared/src/live-sessions.js'
import type { LarkGatewayConfig } from './config.js'

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

  async listSessions(): Promise<LiveSessionSummary[]> {
    const cookie = await this.ensureCookie()
    const res = await httpRequest(`${this.cfg.dashboardBaseUrl}/api/live-sessions`, {
      method: 'GET',
      headers: this.headers({ cookie }),
    })
    if (res.status !== 200) throw new Error(`list_failed: ${res.status} ${res.body}`)
    return (JSON.parse(res.body) as { sessions: LiveSessionSummary[] }).sessions
  }

  /** Send a user message into a live session (the input channel). */
  async sendInput(
    processInstanceId: string,
    text: string,
    channel: LiveSessionInputChannel = 'chatapp',
  ): Promise<void> {
    const cookie = await this.ensureCookie()
    const res = await httpRequest(
      `${this.cfg.dashboardBaseUrl}/api/live-sessions/${encodeURIComponent(processInstanceId)}/commands`,
      {
        method: 'POST',
        headers: this.headers({ cookie, 'content-type': 'application/json' }),
        body: JSON.stringify({ command: { type: 'input', text, channel } }),
      },
    )
    if (res.status !== 200) throw new Error(`command_failed: ${res.status} ${res.body}`)
  }

  /** Start a new live session (pi in a fresh tmux session). Returns the raw start result. */
  async startSession(cwd: string, title?: string): Promise<{ sessionId?: string; tmuxSession?: string }> {
    const cookie = await this.ensureCookie()
    const res = await httpRequest(`${this.cfg.dashboardBaseUrl}/api/live-sessions/start`, {
      method: 'POST',
      headers: this.headers({ cookie, 'content-type': 'application/json' }),
      body: JSON.stringify({ cwd, ...(title ? { title } : {}) }),
    })
    if (res.status !== 200) throw new Error(`start_failed: ${res.status} ${res.body}`)
    const parsed = JSON.parse(res.body) as { result?: { sessionId?: string; tmuxSession?: string } }
    return parsed.result ?? {}
  }

  /** Open the live event stream (the output port) and invoke `onEvent` per frame. */
  async subscribe(onEvent: (frame: LiveSessionBrowserEvent) => void): Promise<WebSocket> {
    const cookie = await this.ensureCookie()
    const ticketRes = await httpRequest(`${this.cfg.dashboardBaseUrl}/api/live-sessions/ws-ticket`, {
      method: 'POST',
      headers: this.headers({ cookie, 'content-type': 'application/json' }),
      body: '{}',
    })
    if (ticketRes.status !== 200) throw new Error(`ws_ticket_failed: ${ticketRes.status} ${ticketRes.body}`)
    const ticket = (JSON.parse(ticketRes.body) as { result: { ticket: string } }).result.ticket

    const wsUrl = `${this.cfg.dashboardBaseUrl.replace(/^http/, 'ws')}/api/live-sessions/ws?ticket=${encodeURIComponent(ticket)}`
    const ws = new WebSocket(wsUrl, { headers: this.headers({ cookie }) })
    ws.on('message', raw => {
      try {
        onEvent(JSON.parse(String(raw)) as LiveSessionBrowserEvent)
      } catch {
        /* ignore malformed frame */
      }
    })
    this.ws = ws
    return ws
  }

  close(): void {
    this.ws?.close()
    this.ws = undefined
  }
}
