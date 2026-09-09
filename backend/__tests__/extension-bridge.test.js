import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConnection } from 'net'
import { ExtensionBridgeRegistry, extensionBridgeRegistry } from '../extension-bridge/registry.js'
import { DASHBOARD_EXTENSION_BRIDGE_SYMBOL, installSdkExtensionBridge } from '../extension-bridge/sdk-host.js'
import { RpcExtensionBridgeServer } from '../extension-bridge/rpc-server.js'

function adapter(feature, initial = { revision: 0, value: 'initial' }) {
  let snapshot = initial
  const listeners = new Set()
  return {
    feature,
    apiVersion: 1,
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async dispatch(command) { return { command } },
    update(next) { snapshot = next; for (const listener of listeners) listener(next) },
  }
}

afterEach(() => {
  extensionBridgeRegistry.detachSlot('sdk-a')
  extensionBridgeRegistry.detachSlot('sdk-b')
})

describe('ExtensionBridgeRegistry', () => {
  it('isolates identical feature adapters by slot and ignores stale revisions', () => {
    const registry = new ExtensionBridgeRegistry()
    const left = adapter('btw', { revision: 2, value: 'left' })
    const right = adapter('btw', { revision: 5, value: 'right' })
    registry.register('slot-a', left)
    registry.register('slot-b', right)

    left.update({ revision: 3, value: 'left-next' })
    right.update({ revision: 4, value: 'stale-right' })

    expect(registry.get('slot-a', 'btw')?.state).toEqual({ revision: 3, value: 'left-next' })
    expect(registry.get('slot-b', 'btw')?.state).toEqual({ revision: 5, value: 'right' })
    expect(registry.list('slot-a')).toHaveLength(1)
    registry.detachSlot('slot-a')
    expect(registry.get('slot-a', 'btw')).toBeUndefined()
    expect(registry.get('slot-b', 'btw')).toBeDefined()
  })

  it('serializes commands for one slot feature', async () => {
    const registry = new ExtensionBridgeRegistry()
    const order = []
    let release
    const first = new Promise(resolve => { release = resolve })
    const value = adapter('subagent-workbench')
    value.dispatch = vi.fn(async command => {
      order.push(`start:${command.id}`)
      if (command.id === 1) await first
      order.push(`end:${command.id}`)
      return command.id
    })
    registry.register('slot-a', value)
    const one = registry.dispatch('slot-a', 'subagent-workbench', { id: 1 })
    const two = registry.dispatch('slot-a', 'subagent-workbench', { id: 2 })
    await Promise.resolve()
    expect(order).toEqual(['start:1'])
    release()
    await expect(Promise.all([one, two])).resolves.toEqual([1, 2])
    expect(order).toEqual(['start:1', 'end:1', 'start:2', 'end:2'])
  })
})

describe('SDK extension bridge capability', () => {
  it('binds registration to the owning SessionManager object', () => {
    const managerA = {}
    const managerB = {}
    const cleanupA = installSdkExtensionBridge(managerA, 'sdk-a')
    const cleanupB = installSdkExtensionBridge(managerB, 'sdk-b')
    const capabilityA = managerA[DASHBOARD_EXTENSION_BRIDGE_SYMBOL]
    const capabilityB = managerB[DASHBOARD_EXTENSION_BRIDGE_SYMBOL]
    capabilityA.register(adapter('background-commands', { revision: 1, owner: 'a' }))
    capabilityB.register(adapter('background-commands', { revision: 1, owner: 'b' }))

    expect(extensionBridgeRegistry.get('sdk-a', 'background-commands')?.state.owner).toBe('a')
    expect(extensionBridgeRegistry.get('sdk-b', 'background-commands')?.state.owner).toBe('b')
    cleanupA()
    expect(extensionBridgeRegistry.get('sdk-a', 'background-commands')).toBeUndefined()
    expect(extensionBridgeRegistry.get('sdk-b', 'background-commands')).toBeDefined()
    cleanupB()
  })
})

describe('RPC extension bridge', () => {
  it('authenticates a slot, receives snapshots, and round-trips commands', async () => {
    const bridge = new RpcExtensionBridgeServer()
    await bridge.start()
    const env = bridge.environmentForSlot('rpc-a')
    const socket = createConnection(env.PI_DASH_BRIDGE_SOCKET)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', chunk => {
      buffer += String(chunk)
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        const message = JSON.parse(line)
        if (message.type === 'command') {
          socket.write(JSON.stringify({ type: 'result', requestId: message.requestId, result: { echoed: message.command } }) + '\n')
        }
      }
    })
    await new Promise(resolve => socket.once('connect', resolve))
    socket.write(JSON.stringify({
      type: 'register',
      token: env.PI_DASH_BRIDGE_TOKEN,
      feature: 'btw',
      apiVersion: 1,
      snapshot: { revision: 1, status: 'ready' },
    }) + '\n')
    await vi.waitFor(() => expect(extensionBridgeRegistry.get('rpc-a', 'btw')).toBeDefined())
    socket.write(JSON.stringify({ type: 'snapshot', snapshot: { revision: 2, status: 'busy' } }) + '\n')
    await vi.waitFor(() => expect(extensionBridgeRegistry.get('rpc-a', 'btw')?.state.status).toBe('busy'))
    await expect(extensionBridgeRegistry.dispatch('rpc-a', 'btw', { type: 'abort' })).resolves.toEqual({ echoed: { type: 'abort' } })
    socket.destroy()
    bridge.revokeSlot('rpc-a')
    await bridge.stop()
  })
})
