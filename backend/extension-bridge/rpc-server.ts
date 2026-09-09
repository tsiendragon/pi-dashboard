import { randomBytes } from 'crypto'
import { chmod, mkdir, rm } from 'fs/promises'
import { createServer, type Server, type Socket } from 'net'
import os from 'os'
import { join } from 'path'
import {
  DASHBOARD_EXTENSION_BRIDGE_API_VERSION,
  isDashboardFeatureName,
  type DashboardFeatureAdapter,
  type DashboardFeatureName,
} from '../../shared/src/extension-bridge.js'
import { extensionBridgeRegistry } from './registry.js'

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024
const RPC_COMMAND_TIMEOUT_MS = 30_000

type ConnectionState = {
  socket: Socket
  slot?: string
  feature?: DashboardFeatureName
  token?: string
  buffer: string
  snapshot: unknown
  listeners: Set<(snapshot: unknown) => void>
  pending: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>
  unregister?: () => void
}

function safeSend(socket: Socket, value: unknown): void {
  if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(value)}\n`)
}

export class RpcExtensionBridgeServer {
  readonly socketPath: string
  private server?: Server
  private startPromise?: Promise<void>
  private readonly tokens = new Map<string, string>()
  private readonly connections = new Set<ConnectionState>()

  constructor() {
    const dir = join(os.tmpdir(), `pi-dashboard-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`)
    this.socketPath = join(dir, `extension-bridge-${process.pid}.sock`)
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    this.startPromise = (async () => {
      const dir = join(this.socketPath, '..')
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await rm(this.socketPath, { force: true })
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
    })()
    return this.startPromise
  }

  environmentForSlot(slot: string): Record<string, string> {
    void this.start()
    this.revokeSlot(slot)
    const token = randomBytes(24).toString('hex')
    this.tokens.set(token, slot)
    return {
      PI_DASH_BRIDGE_SOCKET: this.socketPath,
      PI_DASH_BRIDGE_TOKEN: token,
    }
  }

  revokeSlot(slot: string): void {
    for (const [token, owner] of this.tokens) if (owner === slot) this.tokens.delete(token)
    for (const state of [...this.connections]) {
      if (state.slot === slot) state.socket.destroy()
    }
    extensionBridgeRegistry.detachSlot(slot)
  }

  async stop(): Promise<void> {
    for (const state of [...this.connections]) state.socket.destroy()
    this.connections.clear()
    this.tokens.clear()
    if (this.server) {
      await new Promise<void>(resolve => this.server!.close(() => resolve()))
      this.server = undefined
    }
    await rm(this.socketPath, { force: true })
  }

  private accept(socket: Socket): void {
    socket.setEncoding('utf8')
    const state: ConnectionState = {
      socket,
      buffer: '',
      snapshot: { revision: 0, status: 'connecting' },
      listeners: new Set(),
      pending: new Map(),
    }
    this.connections.add(state)
    socket.on('data', chunk => this.onData(state, String(chunk)))
    socket.on('error', () => {})
    socket.on('close', () => this.closeConnection(state))
  }

  private onData(state: ConnectionState, chunk: string): void {
    state.buffer += chunk
    if (Buffer.byteLength(state.buffer, 'utf8') > MAX_MESSAGE_BYTES) {
      state.socket.destroy(new Error('Extension bridge message exceeds limit'))
      return
    }
    let newline: number
    while ((newline = state.buffer.indexOf('\n')) !== -1) {
      const line = state.buffer.slice(0, newline)
      state.buffer = state.buffer.slice(newline + 1)
      if (!line.trim()) continue
      let message: any
      try { message = JSON.parse(line) } catch {
        state.socket.destroy(new Error('Invalid extension bridge JSON'))
        return
      }
      this.onMessage(state, message)
    }
  }

  private onMessage(state: ConnectionState, message: any): void {
    if (!state.slot) {
      if (message?.type !== 'register' || typeof message.token !== 'string' || !isDashboardFeatureName(message.feature)) {
        state.socket.destroy(new Error('Extension bridge registration required'))
        return
      }
      const slot = this.tokens.get(message.token)
      if (!slot || message.apiVersion !== DASHBOARD_EXTENSION_BRIDGE_API_VERSION) {
        state.socket.destroy(new Error('Invalid extension bridge registration'))
        return
      }
      const feature: DashboardFeatureName = message.feature
      state.slot = slot
      state.token = message.token
      state.feature = feature
      state.snapshot = message.snapshot ?? { revision: 0, status: 'ready' }
      const adapter: DashboardFeatureAdapter = {
        feature,
        apiVersion: DASHBOARD_EXTENSION_BRIDGE_API_VERSION,
        getSnapshot: () => state.snapshot,
        subscribe: listener => {
          state.listeners.add(listener)
          return () => state.listeners.delete(listener)
        },
        dispatch: command => this.dispatch(state, command),
      }
      state.unregister = extensionBridgeRegistry.register(slot, adapter)
      safeSend(state.socket, { type: 'registered', feature: state.feature, apiVersion: DASHBOARD_EXTENSION_BRIDGE_API_VERSION })
      return
    }

    if (message?.type === 'snapshot') {
      state.snapshot = message.snapshot
      for (const listener of state.listeners) listener(state.snapshot)
      return
    }
    if (message?.type === 'result' || message?.type === 'error') {
      const pending = state.pending.get(message.requestId)
      if (!pending) return
      state.pending.delete(message.requestId)
      clearTimeout(pending.timer)
      if (message.type === 'error') pending.reject(Object.assign(new Error(message.error?.message || 'Extension command failed'), { code: message.error?.code }))
      else pending.resolve(message.result)
      return
    }
    if (message?.type === 'unregister') state.socket.end()
  }

  private dispatch(state: ConnectionState, command: unknown): Promise<unknown> {
    if (state.socket.destroyed || !state.feature) return Promise.reject(Object.assign(new Error('Extension bridge disconnected'), { code: 'integration_unavailable' }))
    const requestId = randomBytes(12).toString('hex')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(requestId)
        reject(Object.assign(new Error('RPC extension command timed out'), { code: 'integration_timeout' }))
      }, RPC_COMMAND_TIMEOUT_MS)
      timer.unref?.()
      state.pending.set(requestId, { resolve, reject, timer })
      safeSend(state.socket, { type: 'command', requestId, feature: state.feature, command })
    })
  }

  private closeConnection(state: ConnectionState): void {
    this.connections.delete(state)
    state.unregister?.()
    state.unregister = undefined
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(Object.assign(new Error('Extension bridge disconnected'), { code: 'integration_unavailable' }))
    }
    state.pending.clear()
    state.listeners.clear()
  }
}

export const rpcExtensionBridgeServer = new RpcExtensionBridgeServer()
