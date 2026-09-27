import { createHmac, timingSafeEqual } from 'node:crypto'
import { LiveSessionRegistryError } from './live-sessions/registry.js'
import type { MachinePreview } from './machine-preview.js'
import WebSocket, { type RawData } from 'ws'

const PREAUTH_FRAME = 2048
const POSTAUTH_FRAME = 16384
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
export type SessionRow = { processInstanceId: string; sessionId: string; status: 'idle' | 'running' | 'reconnecting' }
export type PreviewLookup = (processInstanceId: string, sessionId: string) => MachinePreview | undefined

/** Only these three fields may cross the outbound connection. Invalid rows are omitted. */
export function projectSessions(list: () => readonly SessionRow[]): SessionRow[] {
  return list().slice(0, 50).flatMap(row =>
    row && SAFE_ID.test(row.processInstanceId) && SAFE_ID.test(row.sessionId)
      && (row.status === 'idle' || row.status === 'running' || row.status === 'reconnecting')
      ? [{ processInstanceId: row.processInstanceId, sessionId: row.sessionId, status: row.status }] : [])
}

/** Scan JSON object keys before JSON.parse (which silently overwrites duplicate keys). */
export function noDuplicateKeys(text: string): boolean {
  let i = 0
  const space = () => { while (/\s/.test(text[i] ?? '')) i++ }
  const string = (): string => {
    const start = i++
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i)) as string
    }
    throw Error('unterminated string')
  }
  const value = (): void => {
    space()
    if (text[i] === '{') {
      i++; space(); const keys = new Set<string>()
      while (text[i] !== '}') {
        space(); const key = string(); if (keys.has(key)) throw Error('duplicate key'); keys.add(key)
        space(); if (text[i++] !== ':') throw Error('invalid object')
        value(); space()
        if (text[i] !== ',') break
        i++
      }
      if (text[i++] !== '}') throw Error('invalid object')
    } else if (text[i] === '[') {
      i++; space()
      while (text[i] !== ']') { value(); space(); if (text[i] !== ',') break; i++ }
      if (text[i++] !== ']') throw Error('invalid array')
    } else if (text[i] === '"') { string() }
    else { while (i < text.length && !/[\s,}\]]/.test(text[i])) i++ }
  }
  try { value(); space(); return i === text.length } catch { return false }
}
const HANDSHAKE_MS = 10_000
const PING_MS = 30_000
const ID = /^[A-Za-z0-9_-]{1,64}$/
const KEY = /^[A-Za-z0-9_-]{43}$/
const CONTROL_TIMEOUT_MS = 12_000
const DEDUP_TTL_MS = 10 * 60_000
const DEDUP_MAX = 8192
// Process-lifetime input tombstones survive reconnects. Never evict an unresolved dispatch.
const inputTombstones = new Map<string, { at: number; pending: boolean }>()
const activeClientOwners = new Map<string, symbol>()

export interface MachineControl {
  get(processInstanceId: string): { summary: { sessionId: string } } | undefined
  claim(processInstanceId: string, clientId: string, leaseMs: number): Promise<unknown>
  release(processInstanceId: string, clientId: string, leaseId: string): Promise<unknown>
  hasRemoteLease(processInstanceId: string, sessionId: string, clientId: string, leaseId: string): boolean
  sendRemoteInput(processInstanceId: string, sessionId: string, clientId: string, leaseId: string, text: string): Promise<unknown>
  releaseByBrowser(clientId: string): Promise<void>
}

function controlError(error: unknown): 'stale_target' | 'lease_invalid' | 'conflict' | 'offline' | 'indeterminate' {
  if (!(error instanceof LiveSessionRegistryError)) return 'indeterminate'
  if (error.code === 'invalid_lease') return 'lease_invalid'
  if (error.code === 'session_already_claimed') return 'conflict'
  if (error.code === 'command_timeout') return 'indeterminate'
  if (error.code === 'live_session_not_found' || error.code === 'live_session_unavailable') return 'stale_target'
  return 'indeterminate'
}

function pruneTombstones(): void {
  const cutoff = Date.now() - DEDUP_TTL_MS
  for (const [key, value] of inputTombstones) {
    if (!value.pending && value.at < cutoff) inputTombstones.delete(key)
  }
}

export interface MachineConnectorConfig {
  endpoint: string
  machineId: string
  key: string // independent 32-byte base64url key; never logged
}

/** A closed connection must be explicitly reconnected by its owner. */
export interface MachineConnection {
  readonly closed: Promise<Error | undefined>
  close(): void
}

function decode32(value: unknown): Buffer {
  if (typeof value !== 'string' || !KEY.test(value)) throw new Error('Invalid protocol field')
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) throw new Error('Invalid protocol field')
  return bytes
}

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function endpointUrl(endpoint: string): void {
  let url: URL
  try { url = new URL(endpoint) } catch { throw new Error('Invalid connector endpoint') }
  if (url.protocol !== 'wss:' || url.pathname !== '/machine/v1' || url.search || url.hash
    || url.username || url.password || !url.hostname || !endpoint.startsWith('wss://')) {
    throw new Error('Connector requires a wss:// endpoint at /machine/v1')
  }
}

export type InputReservation = (clientId: string, requestId: string) => boolean

export type ConnectorTransport = (endpoint: string, options: WebSocket.ClientOptions) => WebSocket

/** Production entry point. TLS verification is left at ws/Node's secure default, never overridden. */
export function connectMachine(config: MachineConnectorConfig, listSessions?: () => readonly SessionRow[], signal?: AbortSignal, control?: MachineControl, reserve?: InputReservation, preview?: PreviewLookup): Promise<MachineConnection> {
  return connectWithTransport(config, (endpoint, options) => new WebSocket(endpoint, options), listSessions, signal, control, reserve, preview)
}

/** Transport injection is for offline loopback tests only; endpoint validation still applies. */
export function validateMachineConfig(config: MachineConnectorConfig): void {
  endpointUrl(config.endpoint)
  if (!ID.test(config.machineId)) throw new Error('Invalid machine ID')
  decode32(config.key)
}

export function connectWithTransport(config: MachineConnectorConfig, transport: ConnectorTransport, listSessions?: () => readonly SessionRow[], signal?: AbortSignal, control?: MachineControl, reserve?: InputReservation, preview?: PreviewLookup): Promise<MachineConnection> {
  validateMachineConfig(config)
  if (control && !reserve) throw Error('Machine control requires durable input reservation')
  const secret = decode32(config.key)

  return new Promise((resolve, reject) => {
    let socket: WebSocket
    let state: 'challenge' | 'ready-ack' | 'ready' | 'closed' = 'challenge'
    let challengeNonce = ''
    let challengeTs = 0
    let finished = false
    let healthy = true
    let pingTimer: NodeJS.Timeout | undefined
    let dispatchTail: Promise<unknown> = Promise.resolve()
    let inFlight = 0
    const clients = new Set<string>()
    const revoked = new Set<string>()
    const owner = Symbol('machine connection')
    const releaseClients = async () => {
      if (control) await Promise.allSettled([...clients].filter(id => activeClientOwners.get(id) === owner).map(id => control.releaseByBrowser(id)))
      for (const id of clients) if (activeClientOwners.get(id) === owner) activeClientOwners.delete(id)
    }
    const cleanup = () => {
      void dispatchTail.then(releaseClients).then(() => closeResult(undefined))
    }
    const send = (value: Record<string, unknown>) => {
      if (state !== 'ready') return
      const reply = JSON.stringify(value)
      if (Buffer.byteLength(reply) > POSTAUTH_FRAME) { fail(new Error('Connector reply too large')); return }
      socket.send(reply)
    }
    const abort = () => fail(new Error('Connector stopped'))
    let closeResult!: (error: Error | undefined) => void
    const closed = new Promise<Error | undefined>(done => { closeResult = done })
    const fail = (error: Error) => {
      if (state === 'closed') return
      const wasReady = state === 'ready'
      state = 'closed'
      signal?.removeEventListener('abort', abort)
      clearTimeout(handshakeTimer)
      if (pingTimer) clearInterval(pingTimer)
      if (!finished) { finished = true; reject(error) }
      if (wasReady) {
        void dispatchTail.then(releaseClients).then(() => closeResult(error))
      } else closeResult(undefined)
      socket?.terminate()
    }
    const handshakeTimer = setTimeout(() => fail(new Error('Connector handshake timeout')), HANDSHAKE_MS)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { fail(new Error('Connector stopped')); return }
    try {
      // maxPayload caps incoming WS messages even before the message handler runs.
      socket = transport(config.endpoint, { maxPayload: POSTAUTH_FRAME, rejectUnauthorized: true })
    } catch {
      clearTimeout(handshakeTimer)
      finished = true
      reject(new Error('Connector transport failed'))
      closeResult(undefined)
      return
    }
    socket.on('message', (raw: RawData, isBinary: boolean) => {
      if (state === 'closed') return
      try {
        const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(new Uint8Array(raw))
        if (isBinary || bytes.length > (state === 'ready' ? POSTAUTH_FRAME : PREAUTH_FRAME)) throw new Error('Invalid connector frame')
        const text = bytes.toString('utf8')
        if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Invalid connector encoding')
        if (!noDuplicateKeys(text)) throw new Error('Duplicate connector field')
        const data: unknown = JSON.parse(text)
        if (state === 'challenge') {
          if (!exact(data, ['v', 'type', 'nonce', 'ts']) || data.v !== 1 || data.type !== 'challenge') throw new Error('Invalid challenge')
          decode32(data.nonce)
          if (typeof data.ts !== 'number' || !Number.isSafeInteger(data.ts) || Math.abs(Date.now() - data.ts) > HANDSHAKE_MS) throw new Error('Stale challenge')
          challengeNonce = data.nonce as string
          challengeTs = data.ts
          const proof = createHmac('sha256', secret).update(`pi-bridge-v1\n${config.machineId}\n${challengeNonce}\n${challengeTs}`).digest('base64url')
          socket.send(JSON.stringify({ v: 1, type: 'hello', machineId: config.machineId, proof }))
          state = 'ready-ack'
        } else if (state === 'ready-ack') {
          if (!exact(data, ['v', 'type', 'machineId']) || data.v !== 1 || data.type !== 'ready'
            || typeof data.machineId !== 'string' || !ID.test(data.machineId)
            || !timingSafeEqual(Buffer.from(data.machineId), Buffer.from(config.machineId))) {
            throw new Error('Invalid ready response')
          }
          state = 'ready'
          clearTimeout(handshakeTimer)
          pingTimer = setInterval(() => {
            if (!healthy) { fail(new Error('Connector pong timeout')); return }
            healthy = false
            socket.ping()
          }, PING_MS)
          pingTimer.unref()
          finished = true
          resolve({ closed, close: () => {
            if (state === 'closed') return
            state = 'closed'
            signal?.removeEventListener('abort', abort)
            if (pingTimer) clearInterval(pingTimer)
            clearTimeout(handshakeTimer)
            cleanup()
            socket.close()
          } })
        } else if (listSessions && exact(data, ['v', 'type', 'requestId']) && data.v === 1
          && data.type === 'list_sessions' && typeof data.requestId === 'string' && UUID.test(data.requestId)) {
          const reply = JSON.stringify({ v: 1, type: 'sessions', requestId: data.requestId, sessions: projectSessions(listSessions) })
          if (Buffer.byteLength(reply) > POSTAUTH_FRAME) throw new Error('Connector reply too large')
          socket.send(reply)
        } else if (state === 'ready' && preview && data && typeof data === 'object' && !Array.isArray(data)
          && (data as Record<string, unknown>).type === 'get_preview') {
          if (!exact(data, ['v', 'type', 'requestId', 'processInstanceId', 'sessionId']) || data.v !== 1
            || typeof data.requestId !== 'string' || !UUID.test(data.requestId)
            || typeof data.processInstanceId !== 'string' || !SAFE_ID.test(data.processInstanceId)
            || typeof data.sessionId !== 'string' || !SAFE_ID.test(data.sessionId)) throw new Error('Invalid preview request')
          const projected = preview(data.processInstanceId, data.sessionId)
          // A missing or replaced attachment never exposes old text or metadata.
          send({ v: 1, type: 'preview', requestId: data.requestId, sessionId: data.sessionId,
            status: projected?.status ?? 'unavailable', observedAt: projected?.observedAt ?? Date.now(),
            messages: projected?.messages ?? [] })
        } else if (state === 'ready' && data && typeof data === 'object' && !Array.isArray(data)
          && (data as Record<string, unknown>).type === 'revoke_client') {
          if (!exact(data, ['v', 'type', 'requestId', 'clientId']) || data.v !== 1
            || typeof data.requestId !== 'string' || !UUID.test(data.requestId)
            || typeof data.clientId !== 'string' || !data.clientId.startsWith('remote-')) {
            throw new Error('Invalid revocation')
          }
          decode32(data.clientId.slice(7)) // canonical 43-character device ID
          const clientId = data.clientId
          revoked.add(clientId) // fence synchronously, before any queued control dispatch resumes
          send({ v: 1, type: 'result', requestId: data.requestId, ok: true })
          // A claim already in progress may establish a lease after this frame arrives.
          // Cleanup follows the dispatch queue, but never delays the acknowledgement.
          dispatchTail = dispatchTail.then(async () => {
            if (clients.has(clientId) && activeClientOwners.get(clientId) === owner) {
              await control?.releaseByBrowser(clientId)
              clients.delete(clientId)
              activeClientOwners.delete(clientId)
            }
          }).catch(() => {})
        } else if (state === 'ready' && control && data && typeof data === 'object' && !Array.isArray(data)
          && (data as Record<string, unknown>).v === 1
          && ['claim_session', 'release_session', 'send_input'].includes((data as Record<string, unknown>).type as string)) {
          const msg = data as Record<string, unknown>
          if (typeof msg.requestId !== 'string' || !UUID.test(msg.requestId)) throw new Error('Invalid control request ID')
          const result = (ok: boolean, fields: Record<string, unknown> = {}) => send({ v: 1, type: 'result', requestId: msg.requestId, ok, ...fields })
          const input = msg.type === 'send_input'
          const keys = ['v', 'type', 'requestId', 'clientId', 'processInstanceId', 'sessionId', ...
            (msg.type === 'claim_session' ? [] : ['leaseId']), ...(input ? ['text'] : [])]
          const valid = exact(msg, keys) && typeof msg.clientId === 'string' && msg.clientId.startsWith('remote-')
            && (() => { try { decode32(msg.clientId.slice(7)); return true } catch { return false } })()
            && typeof msg.processInstanceId === 'string' && SAFE_ID.test(msg.processInstanceId)
            && typeof msg.sessionId === 'string' && SAFE_ID.test(msg.sessionId)
            && (msg.type === 'claim_session' || (typeof msg.leaseId === 'string' && SAFE_ID.test(msg.leaseId)))
            && (!input || (typeof msg.text === 'string' && !!msg.text.trim() && Buffer.byteLength(msg.text, 'utf8') <= 4096
              && !msg.text.trimStart().startsWith('/')))
          if (!valid) { result(false, { error: 'invalid_request' }); return }
          const clientId = msg.clientId as string
          if (revoked.has(clientId)) { result(false, { error: input ? 'indeterminate' : 'lease_invalid' }); return }
          const existingOwner = activeClientOwners.get(clientId)
          if (inFlight >= 16) { result(false, { error: 'offline' }); return }
          if (existingOwner && existingOwner !== owner) { result(false, { error: 'conflict' }); return }
          if (msg.type !== 'claim_session' && existingOwner !== owner) { result(false, { error: 'lease_invalid' }); return }
          if (input) {
            // Invalid/expired leases must not consume the finite, durable replay journal.
            if (!control.hasRemoteLease(msg.processInstanceId as string, msg.sessionId as string,
              clientId, msg.leaseId as string)) { result(false, { error: 'lease_invalid' }); return }
            pruneTombstones()
            const key = `${clientId}:${msg.requestId}`
            if (inputTombstones.has(key)) { result(false, { error: 'indeterminate' }); return }
            if (inputTombstones.size >= DEDUP_MAX && ![...inputTombstones.values()].some(item => !item.pending)) {
              result(false, { error: 'indeterminate' }); return
            }
            // The durable reservation is fsync'd before this operation enters the dispatch queue.
            // A failure or duplicate is always indeterminate; never fall back to memory.
            try {
              if (!reserve!(clientId, msg.requestId as string)) { result(false, { error: 'indeterminate' }); return }
            } catch { result(false, { error: 'indeterminate' }); return }
            if (inputTombstones.size >= DEDUP_MAX) {
              const oldest = [...inputTombstones].find(([, item]) => !item.pending)
              if (oldest) inputTombstones.delete(oldest[0])
            }
            inputTombstones.set(key, { at: Date.now(), pending: true })
          }
          inFlight++
          const run = async () => {
            if (state !== 'ready') return
            if (revoked.has(clientId)) { result(false, { error: input ? 'indeterminate' : 'lease_invalid' }); return }
            if (msg.type !== 'send_input' && control.get(msg.processInstanceId as string)?.summary.sessionId !== msg.sessionId) {
              result(false, { error: 'stale_target' }); return
            }
            // Only a successfully claimed client belongs to this connection for cleanup.
            let pending: Promise<unknown>
            try {
              if (msg.type === 'claim_session') {
                clients.add(clientId) // includes claims whose response becomes uncertain
                activeClientOwners.set(clientId, owner)
                pending = control.claim(msg.processInstanceId as string, clientId, 30_000)
              }
              else if (msg.type === 'release_session') pending = control.release(msg.processInstanceId as string, clientId, msg.leaseId as string)
              else pending = control.sendRemoteInput(msg.processInstanceId as string, msg.sessionId as string, clientId, msg.leaseId as string, msg.text as string)
              const timeout = new Promise<never>((_, reject) => {
                const timer = setTimeout(() => reject(new Error('timeout')), CONTROL_TIMEOUT_MS)
                timer.unref()
                void pending.finally(() => clearTimeout(timer)).catch(() => {})
              })
              const response = await Promise.race([pending, timeout])
              if (msg.type === 'claim_session') {
                const value = response as Record<string, unknown>
                if (typeof value?.leaseId !== 'string' || typeof value?.expiresAt !== 'number') throw Error('Invalid claim response')
                result(true, { leaseId: value.leaseId, expiresAt: value.expiresAt })
              } else result(true)
            } catch (error) {
              const timedOut = error instanceof Error && error.message === 'timeout'
              result(false, { error: timedOut ? 'indeterminate' : controlError(error) })
              // Do not dispatch another operation or release leases until an uncertain
              // command settles. A stuck command deliberately blocks reconnect.
              if (timedOut) await pending!.catch(() => {})
            }
          }
          const queued = dispatchTail.then(run, run)
          dispatchTail = queued.catch(() => {}).finally(() => {
            inFlight--
            if (input) {
              const key = `${clientId}:${msg.requestId}`
              const item = inputTombstones.get(key)
              if (item) { item.pending = false; item.at = Date.now() }
            }
          })
        } else {
          throw new Error('Unexpected connector application message')
        }
      } catch { fail(new Error('Invalid connector protocol message')) }
    })
    socket.on('pong', () => { healthy = true })
    socket.on('error', () => fail(new Error('Connector transport error')))
    socket.on('close', () => fail(new Error('Connector transport closed')))
  })
}
