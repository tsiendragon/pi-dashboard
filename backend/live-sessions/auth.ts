import { randomBytes, timingSafeEqual } from 'crypto'
import { chmod, lstat, mkdir, open, readFile, writeFile } from 'fs/promises'
import type { IncomingHttpHeaders } from 'http'
import os from 'os'
import path from 'path'

export const LIVE_SESSION_COOKIE_NAME = 'pi_live_session'
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000
const WEBSOCKET_TICKET_TTL_MS = 30_000

type HeaderSource = { headers: IncomingHttpHeaders }

export interface LiveSessionBrowserIdentity {
  browserClientId: string
  createdAt: number
  lastSeenAt: number
}

export interface BrowserAuthenticationResult extends LiveSessionBrowserIdentity {
  setCookie: string
}

export interface BrowserWebSocketTicket {
  ticket: string
  expiresAt: number
}

export interface LiveSessionBrowserAuthOptions {
  tokenPath?: string
  allowedOrigins?: readonly string[]
  now?: () => number
}

function parseCookies(header: string | string[] | undefined): Map<string, string> {
  const value = Array.isArray(header) ? header.join(';') : header || ''
  const cookies = new Map<string, string>()
  for (const part of value.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 1) continue
    const key = part.slice(0, separator).trim()
    const raw = part.slice(separator + 1).trim()
    try { cookies.set(key, decodeURIComponent(raw)) } catch {}
  }
  return cookies
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  return raw?.split(',')[0]?.trim() || undefined
}

function normalizedHost(value: string | string[] | undefined): string | undefined {
  return firstHeaderValue(value)?.toLowerCase()
}

function forwardedHost(value: string | string[] | undefined): string | undefined {
  const first = firstHeaderValue(value)
  if (!first) return undefined
  const match = first.match(/(?:^|;)\s*host=(?:"([^"]+)"|([^;\s]+))/i)
  return normalizedHost(match?.[1] || match?.[2])
}

function hostPort(value: string | string[] | undefined): string | undefined {
  const host = firstHeaderValue(value)
  if (!host) return undefined
  try { return new URL(`http://${host}`).port || undefined } catch { return undefined }
}

function isDswGatewayOrigin(origin: URL, request: HeaderSource): boolean {
  const forwardedProto = firstHeaderValue(request.headers['x-forwarded-proto'])?.toLowerCase()
  const expectedProtocol = forwardedProto === 'http' ? 'http:' : 'https:'
  if (origin.protocol !== expectedProtocol) return false
  const match = origin.hostname.match(/^\d+-proxy-(\d+)\.dsw-gateway-[a-z0-9-]+\.data\.aliyuncs\.com$/i)
  if (!match) return false
  const targetPort = match[1]
  const requestPort = hostPort(request.headers.host)
  const configuredPort = process.env.PI_DASH_PORT || '7777'
  return targetPort === requestPort || targetPort === configuredPort
}

function requestHosts(request: HeaderSource): string[] {
  return [
    normalizedHost(request.headers['x-forwarded-host']),
    normalizedHost(request.headers['x-original-host']),
    forwardedHost(request.headers.forwarded),
    normalizedHost(request.headers.host),
  ].filter((value): value is string => !!value)
}

function urlMatchesRequest(url: URL, request: HeaderSource): boolean {
  const urlHost = normalizedHost(url.host)
  if (urlHost && requestHosts(request).includes(urlHost)) return true
  return isDswGatewayOrigin(url, request)
}

export class LiveSessionBrowserAuth {
  readonly tokenPath: string
  private readonly sessionsPath: string
  private token?: Buffer
  private startPromise?: Promise<void>
  private readonly sessions = new Map<string, LiveSessionBrowserIdentity>()
  private readonly websocketTickets = new Map<string, { browserClientId: string; expiresAt: number }>()
  private readonly allowedOrigins: Set<string>
  private readonly now: () => number

  constructor(options: LiveSessionBrowserAuthOptions = {}) {
    this.tokenPath = options.tokenPath || path.join(os.homedir(), '.pi', 'agent', 'run', 'pi-dashboard', 'live-control-token')
    this.sessionsPath = `${this.tokenPath}.sessions.json`
    const configured = process.env.PI_DASH_ALLOWED_ORIGIN?.split(',').map(value => value.trim()).filter(Boolean) || []
    this.allowedOrigins = new Set([...(options.allowedOrigins || []), ...configured])
    this.now = options.now || Date.now
  }

  start(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.initialize()
    return this.startPromise
  }

  async stop(): Promise<void> {
    this.sessions.clear()
    this.websocketTickets.clear()
    this.token = undefined
    this.startPromise = undefined
  }

  cleanup(): Promise<void> {
    return this.stop()
  }

  async authenticate(controlToken: unknown, secure: boolean): Promise<BrowserAuthenticationResult | undefined> {
    await this.start()
    if (typeof controlToken !== 'string' || !this.token) return undefined
    const supplied = Buffer.from(controlToken.trim(), 'utf8')
    if (supplied.length !== this.token.length || !timingSafeEqual(supplied, this.token)) return undefined
    const cookieValue = randomBytes(32).toString('hex')
    const now = this.now()
    const identity: LiveSessionBrowserIdentity = {
      browserClientId: randomBytes(16).toString('hex'),
      createdAt: now,
      lastSeenAt: now,
    }
    this.sessions.set(cookieValue, identity)
    this.persistSessions()
    return {
      ...identity,
      setCookie: `${LIVE_SESSION_COOKIE_NAME}=${cookieValue}; Path=/api; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`,
    }
  }

  getIdentity(request: HeaderSource): LiveSessionBrowserIdentity | undefined {
    this.prune()
    const cookie = parseCookies(request.headers.cookie).get(LIVE_SESSION_COOKIE_NAME)
    if (!cookie) return undefined
    const identity = this.sessions.get(cookie)
    if (!identity) return undefined
    identity.lastSeenAt = this.now()
    return { ...identity }
  }

  forget(request: HeaderSource): void {
    const cookie = parseCookies(request.headers.cookie).get(LIVE_SESSION_COOKIE_NAME)
    if (cookie) { this.sessions.delete(cookie); this.persistSessions() }
  }

  issueWebSocketTicket(request: HeaderSource): BrowserWebSocketTicket | undefined {
    const identity = this.getIdentity(request)
    if (!identity) return undefined
    const ticket = randomBytes(32).toString('hex')
    const expiresAt = this.now() + WEBSOCKET_TICKET_TTL_MS
    this.websocketTickets.set(ticket, { browserClientId: identity.browserClientId, expiresAt })
    return { ticket, expiresAt }
  }

  consumeWebSocketTicket(value: unknown): LiveSessionBrowserIdentity | undefined {
    this.prune()
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return undefined
    const ticket = this.websocketTickets.get(value)
    this.websocketTickets.delete(value)
    if (!ticket || ticket.expiresAt < this.now()) return undefined
    for (const identity of this.sessions.values()) {
      if (identity.browserClientId === ticket.browserClientId) return { ...identity }
    }
    return undefined
  }

  isOriginAllowed(request: HeaderSource, requireOrigin = false, authenticatedIdentity?: LiveSessionBrowserIdentity): boolean {
    const origin = firstHeaderValue(request.headers.origin)
    if (origin) {
      if (origin === 'null') return false
      if (this.allowedOrigins.has(origin)) return true
      try { return urlMatchesRequest(new URL(origin), request) } catch { return false }
    }
    if (!requireOrigin) return true
    // Some DSW gateways strip Origin, Referer and Sec-Fetch-* from WebSocket
    // upgrades. The private HttpOnly control cookie proves authentication, and
    // the encoded gateway host pins the request to this Dashboard port.
    const requestHost = normalizedHost(request.headers.host)
    if (requestHost && (authenticatedIdentity || this.getIdentity(request))) {
      try {
        const forwardedProto = firstHeaderValue(request.headers['x-forwarded-proto'])?.toLowerCase()
        const gatewayProtocol = forwardedProto === 'http' ? 'http' : 'https'
        if (isDswGatewayOrigin(new URL(`${gatewayProtocol}://${requestHost}`), request)) return true
      } catch {}
    }
    if (firstHeaderValue(request.headers['sec-fetch-site'])?.toLowerCase() !== 'same-origin') return false
    const referer = firstHeaderValue(request.headers.referer)
    if (!referer) return false
    try { return urlMatchesRequest(new URL(referer), request) } catch { return false }
  }

  isSecure(request: HeaderSource): boolean {
    const forwarded = firstHeaderValue(request.headers['x-forwarded-proto'])?.toLowerCase()
    if (forwarded === 'https') return true
    for (const value of [firstHeaderValue(request.headers.origin), firstHeaderValue(request.headers.referer)]) {
      if (!value) continue
      try {
        const url = new URL(value)
        if (url.protocol === 'https:' && urlMatchesRequest(url, request)) return true
      } catch {}
    }
    return false
  }

  private async initialize(): Promise<void> {
    const directory = path.dirname(this.tokenPath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    try {
      const handle = await open(this.tokenPath, 'wx', 0o600)
      try { await handle.writeFile(`${randomBytes(32).toString('hex')}\n`, 'utf8') } finally { await handle.close() }
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
    }
    const stats = await lstat(this.tokenPath)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) throw new Error('live control token must be a regular single-link file')
    if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) throw new Error('live control token must be owned by the dashboard user')
    await chmod(this.tokenPath, 0o600)
    const token = (await readFile(this.tokenPath, 'utf8')).trim()
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('live control token file is invalid')
    this.token = Buffer.from(token, 'utf8')
    await this.loadSessions()
  }

  private async loadSessions(): Promise<void> {
    try {
      const raw = await readFile(this.sessionsPath, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, LiveSessionBrowserIdentity>
      const now = this.now()
      for (const [cookie, identity] of Object.entries(parsed)) {
        if (identity && typeof identity.browserClientId === 'string' && typeof identity.lastSeenAt === 'number' && now - identity.lastSeenAt < SESSION_MAX_AGE_MS) {
          this.sessions.set(cookie, { browserClientId: identity.browserClientId, createdAt: typeof identity.createdAt === 'number' ? identity.createdAt : now, lastSeenAt: identity.lastSeenAt })
        }
      }
    } catch { /* missing or corrupt sessions file -> start empty */ }
  }

  private persistSessions(): void {
    const data: Record<string, LiveSessionBrowserIdentity> = {}
    for (const [cookie, identity] of this.sessions) data[cookie] = identity
    void writeFile(this.sessionsPath, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 }).catch(() => {})
  }

  private prune(): void {
    const cutoff = this.now() - SESSION_MAX_AGE_MS
    for (const [cookie, identity] of this.sessions) {
      if (identity.lastSeenAt < cutoff) this.sessions.delete(cookie)
    }
    const now = this.now()
    for (const [ticket, value] of this.websocketTickets) {
      if (value.expiresAt < now) this.websocketTickets.delete(ticket)
    }
  }
}
