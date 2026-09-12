import { randomBytes, timingSafeEqual } from 'crypto'
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'net'
import os from 'os'
import path from 'path'
import {
  LIVE_SESSION_MAX_BUFFER_BYTES,
  LIVE_SESSION_MAX_COMMAND_BYTES,
  LIVE_SESSION_MAX_EVENT_BYTES,
  LIVE_SESSION_MAX_SNAPSHOT_BYTES,
  LIVE_SESSION_PROTOCOL_VERSION,
  type LiveSessionServerMessage,
} from '../../shared/src/live-sessions.js'
import {
  LiveSessionProtocolError,
  jsonBytes,
  parseCommandResult,
  parseEvent,
  parseGoodbye,
  parseHeartbeat,
  parseHello,
  parseJsonLine,
  parseSnapshot,
} from './protocol.js'
import { LiveSessionPathPolicy } from './path-policy.js'
import { LiveSessionRegistry, type LiveSessionTransport } from './registry.js'
import { LiveSessionGitInfoResolver } from './git-info.js'

type FileIdentity = { dev: number; ino: number }

type ConnectionState = {
  socket: Socket
  transport: LiveSessionTransport
  buffer: string
  processInstanceId?: string
  closedIntentionally: boolean
  lastSeenAt: number
  messageTail: Promise<void>
}

export interface LiveSessionBrokerOptions {
  registry: LiveSessionRegistry
  roots: readonly string[]
  runDirectory?: string
  heartbeatMs?: number
}

export class LiveSessionBrokerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'LiveSessionBrokerError'
  }
}

function identityOf(stats: { dev: number | bigint; ino: number | bigint }): FileIdentity {
  return { dev: Number(stats.dev), ino: Number(stats.ino) }
}

function sameIdentity(left: FileIdentity | undefined, right: FileIdentity): boolean {
  return !!left && left.dev === right.dev && left.ino === right.ino
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: any) {
    return error?.code === 'EPERM'
  }
}

export class LiveSessionBroker {
  readonly runDirectory: string
  readonly socketPath: string
  readonly brokerTokenPath: string
  readonly controlTokenPath: string
  readonly lockPath: string
  readonly pathPolicy: LiveSessionPathPolicy
  private readonly registry: LiveSessionRegistry
  private readonly heartbeatMs: number
  private server?: Server
  private startPromise?: Promise<void>
  private brokerToken?: Buffer
  private lockIdentity?: FileIdentity
  private socketIdentity?: FileIdentity
  private readonly connections = new Set<ConnectionState>()
  private readonly gitInfo = new LiveSessionGitInfoResolver()
  private watchdogTimer?: ReturnType<typeof setInterval>

  constructor(options: LiveSessionBrokerOptions) {
    this.registry = options.registry
    this.runDirectory = options.runDirectory || path.join(os.homedir(), '.pi', 'agent', 'run', 'pi-dashboard')
    this.socketPath = path.join(this.runDirectory, 'live-sessions.sock')
    this.brokerTokenPath = path.join(this.runDirectory, 'live-broker-token')
    this.controlTokenPath = path.join(this.runDirectory, 'live-control-token')
    this.lockPath = path.join(this.runDirectory, 'live-sessions.lock')
    this.heartbeatMs = options.heartbeatMs ?? 10_000
    this.pathPolicy = new LiveSessionPathPolicy(options.roots)
  }

  start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.initialize().catch(async error => {
        await this.cleanupRuntimeFiles()
        this.startPromise = undefined
        throw error
      })
    }
    return this.startPromise
  }

  async stop(): Promise<void> {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer)
    this.watchdogTimer = undefined
    for (const state of [...this.connections]) {
      state.closedIntentionally = true
      if (state.processInstanceId) this.registry.detach(state.processInstanceId, 'broker_shutdown', state.transport)
      state.socket.destroy()
    }
    this.connections.clear()
    const server = this.server
    this.server = undefined
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    await this.cleanupRuntimeFiles()
    await this.pathPolicy.stop()
    this.gitInfo.clear()
    this.brokerToken = undefined
    this.startPromise = undefined
  }

  cleanup(): Promise<void> {
    return this.stop()
  }

  private async initialize(): Promise<void> {
    await this.pathPolicy.start()
    await mkdir(this.runDirectory, { recursive: true, mode: 0o700 })
    await chmod(this.runDirectory, 0o700)
    await this.acquireLock()
    const socketState = await this.probeSocket()
    if (socketState === 'active') throw new LiveSessionBrokerError('broker_already_running', 'another live session broker is already running')
    if (socketState === 'stale') await unlink(this.socketPath)
    await this.writeBrokerToken()
    await this.ensureControlToken()

    this.server = createServer(socket => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      this.server!.once('error', onError)
      this.server!.listen(this.socketPath, () => {
        this.server!.off('error', onError)
        resolve()
      })
    })
    await chmod(this.socketPath, 0o600)
    this.socketIdentity = identityOf(await lstat(this.socketPath))
    this.watchdogTimer = setInterval(() => this.checkHeartbeats(), this.heartbeatMs)
    this.watchdogTimer.unref?.()
  }

  private async acquireLock(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(this.lockPath, 'wx', 0o600)
        try {
          await handle.writeFile(`${process.pid}\n`, 'utf8')
          this.lockIdentity = identityOf(await handle.stat())
        } finally {
          await handle.close()
        }
        await chmod(this.lockPath, 0o600)
        return
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error
        let ownerPid = 0
        try { ownerPid = Number.parseInt((await readFile(this.lockPath, 'utf8')).trim(), 10) } catch {}
        if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && isProcessAlive(ownerPid)) {
          throw new LiveSessionBrokerError('broker_already_running', `live session broker lock is owned by pid ${ownerPid}`)
        }
        await unlink(this.lockPath).catch((unlinkError: any) => {
          if (unlinkError?.code !== 'ENOENT') throw unlinkError
        })
      }
    }
    throw new LiveSessionBrokerError('lock_unavailable', 'could not acquire live session broker lock')
  }

  private async probeSocket(): Promise<'missing' | 'active' | 'stale'> {
    try {
      const stats = await lstat(this.socketPath)
      if (!stats.isSocket()) throw new LiveSessionBrokerError('unsafe_socket_path', 'live session socket path is not a socket')
    } catch (error: any) {
      if (error?.code === 'ENOENT') return 'missing'
      throw error
    }
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath)
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new LiveSessionBrokerError('socket_probe_timeout', 'timed out probing existing live session socket'))
      }, 500)
      timer.unref?.()
      socket.once('connect', () => {
        clearTimeout(timer)
        socket.destroy()
        resolve('active')
      })
      socket.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        socket.destroy()
        if (error.code === 'ECONNREFUSED') resolve('stale')
        else if (error.code === 'ENOENT') resolve('missing')
        else reject(error)
      })
    })
  }

  private async writeBrokerToken(): Promise<void> {
    const value = randomBytes(32).toString('hex')
    const temporaryPath = `${this.brokerTokenPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${value}\n`, 'utf8')
    } finally {
      await handle.close()
    }
    try {
      await rename(temporaryPath, this.brokerTokenPath)
    } catch (error) {
      await unlink(temporaryPath).catch(() => {})
      throw error
    }
    await chmod(this.brokerTokenPath, 0o600)
    this.brokerToken = Buffer.from(value, 'utf8')
  }

  private async ensureControlToken(): Promise<void> {
    try {
      const handle = await open(this.controlTokenPath, 'wx', 0o600)
      try { await handle.writeFile(`${randomBytes(32).toString('hex')}\n`, 'utf8') } finally { await handle.close() }
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
    }
    const stats = await lstat(this.controlTokenPath)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw new LiveSessionBrokerError('unsafe_control_token', 'live control token must be a regular single-link file')
    }
    if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
      throw new LiveSessionBrokerError('unsafe_control_token', 'live control token must be owned by the dashboard user')
    }
    await chmod(this.controlTokenPath, 0o600)
  }

  private accept(socket: Socket): void {
    socket.setEncoding('utf8')
    const state = {} as ConnectionState
    state.socket = socket
    state.buffer = ''
    state.closedIntentionally = false
    state.lastSeenAt = Date.now()
    state.messageTail = Promise.resolve()
    state.transport = {
      send: message => this.send(socket, message),
      close: () => socket.destroy(),
    }
    this.connections.add(state)
    socket.on('data', chunk => this.onData(state, String(chunk)))
    socket.on('error', () => {})
    socket.on('close', () => {
      this.connections.delete(state)
      if (!state.closedIntentionally && state.processInstanceId) this.registry.disconnect(state.processInstanceId, state.transport)
    })
  }

  private onData(state: ConnectionState, chunk: string): void {
    state.buffer += chunk
    if (Buffer.byteLength(state.buffer, 'utf8') > LIVE_SESSION_MAX_BUFFER_BYTES) {
      this.reject(state, 'buffer_too_large', 'connection buffer exceeds 16 MiB')
      return
    }
    let newline: number
    while ((newline = state.buffer.indexOf('\n')) !== -1) {
      const line = state.buffer.slice(0, newline)
      state.buffer = state.buffer.slice(newline + 1)
      if (!line.trim()) continue
      state.messageTail = state.messageTail.then(() => this.handleLine(state, line)).catch(error => {
        const code = error instanceof LiveSessionProtocolError ? error.code : error instanceof LiveSessionBrokerError ? error.code : 'invalid_message'
        this.reject(state, code, error instanceof Error ? error.message : String(error))
      })
    }
  }

  private async handleLine(state: ConnectionState, line: string): Promise<void> {
    if (Buffer.byteLength(line, 'utf8') > LIVE_SESSION_MAX_BUFFER_BYTES) throw new LiveSessionProtocolError('message_too_large', 'message exceeds 16 MiB')
    state.lastSeenAt = Date.now()
    const message = parseJsonLine(line)
    if (!state.processInstanceId) {
      if (jsonBytes(message) > LIVE_SESSION_MAX_EVENT_BYTES) throw new LiveSessionProtocolError('hello_too_large', 'hello exceeds 8 MiB')
      const hello = parseHello(message)
      if (!this.tokenMatches(hello.brokerToken)) throw new LiveSessionProtocolError('authentication_failed', 'invalid broker token')
      const decision = await this.pathPolicy.authorize(hello.cwd)
      if (!decision.allowed || !decision.canonicalCwd) throw new LiveSessionProtocolError(decision.code || 'out_of_scope', decision.message || 'cwd is not allowed')
      state.processInstanceId = hello.processInstanceId
      this.registry.connect(hello, decision.canonicalCwd, state.transport)
      this.send(state.socket, { type: 'welcome', protocolVersion: LIVE_SESSION_PROTOCOL_VERSION, heartbeatMs: this.heartbeatMs })
      return
    }

    switch (message.type) {
      case 'snapshot': {
        if (jsonBytes(message) > LIVE_SESSION_MAX_SNAPSHOT_BYTES) throw new LiveSessionProtocolError('snapshot_too_large', 'snapshot exceeds 8 MiB')
        const snapshot = parseSnapshot(message)
        this.assertProcess(state, snapshot.processInstanceId)
        const decision = await this.pathPolicy.authorize(snapshot.summary.cwd)
        if (!decision.allowed || !decision.canonicalCwd) throw new LiveSessionProtocolError(decision.code || 'out_of_scope', decision.message || 'snapshot cwd is not allowed')
        const git = await this.gitInfo.resolve(decision.canonicalCwd)
        if (git) snapshot.summary.git = git
        this.registry.applySnapshot(snapshot, state.transport, decision.canonicalCwd)
        return
      }
      case 'event':
        if (jsonBytes(message) > LIVE_SESSION_MAX_EVENT_BYTES) throw new LiveSessionProtocolError('event_too_large', 'event exceeds 8 MiB')
        this.assertProcess(state, String(message.processInstanceId))
        this.registry.applyEvent(parseEvent(message), state.transport)
        return
      case 'command_result':
        if (jsonBytes(message) > LIVE_SESSION_MAX_EVENT_BYTES) throw new LiveSessionProtocolError('result_too_large', 'command result exceeds 8 MiB')
        this.registry.handleCommandResult(parseCommandResult(message), state.transport)
        return
      case 'heartbeat': {
        const heartbeat = parseHeartbeat(message)
        this.assertProcess(state, heartbeat.processInstanceId)
        this.registry.heartbeat(heartbeat.processInstanceId, state.transport, heartbeat.at)
        return
      }
      case 'goodbye': {
        const goodbye = parseGoodbye(message)
        this.assertProcess(state, goodbye.processInstanceId)
        state.closedIntentionally = true
        this.registry.detach(goodbye.processInstanceId, goodbye.reason, state.transport)
        state.socket.end()
        return
      }
      default:
        throw new LiveSessionProtocolError('unknown_message', 'unknown live session message type')
    }
  }

  private checkHeartbeats(): void {
    const cutoff = Date.now() - this.heartbeatMs * 3
    for (const state of this.connections) {
      if (state.lastSeenAt >= cutoff || state.closedIntentionally) continue
      state.socket.destroy(new LiveSessionBrokerError('heartbeat_timeout', 'live session heartbeat timed out'))
    }
  }

  private assertProcess(state: ConnectionState, processInstanceId: string): void {
    if (processInstanceId !== state.processInstanceId) throw new LiveSessionProtocolError('identity_mismatch', 'processInstanceId changed on one connection')
  }

  private tokenMatches(value: string): boolean {
    const supplied = Buffer.from(value, 'utf8')
    return !!this.brokerToken && supplied.length === this.brokerToken.length && timingSafeEqual(supplied, this.brokerToken)
  }

  private send(socket: Socket, message: LiveSessionServerMessage): void {
    if (socket.destroyed || !socket.writable) throw new LiveSessionBrokerError('connection_closed', 'live session connection is closed')
    const payload = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(payload, 'utf8') > LIVE_SESSION_MAX_COMMAND_BYTES) throw new LiveSessionBrokerError('command_too_large', 'outbound command exceeds 8 MiB')
    socket.write(payload)
  }

  private reject(state: ConnectionState, code: string, message: string): void {
    if (state.socket.destroyed) return
    state.closedIntentionally = true
    try { state.socket.end(`${JSON.stringify({ type: 'reject', code, message })}\n`) } catch { state.socket.destroy() }
    if (state.processInstanceId) this.registry.detach(state.processInstanceId, code, state.transport)
  }

  private async cleanupRuntimeFiles(): Promise<void> {
    await this.unlinkOwned(this.socketPath, this.socketIdentity)
    await this.unlinkOwned(this.lockPath, this.lockIdentity)
    this.socketIdentity = undefined
    this.lockIdentity = undefined
  }

  private async unlinkOwned(filePath: string, identity: FileIdentity | undefined): Promise<void> {
    if (!identity) return
    try {
      const current = identityOf(await lstat(filePath))
      if (sameIdentity(identity, current)) await unlink(filePath)
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}
