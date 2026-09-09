import {
  DASHBOARD_EXTENSION_BRIDGE_API_VERSION,
  DASHBOARD_EXTENSION_BRIDGE_SYMBOL_KEY,
  type DashboardExtensionBridgeCapability,
  type DashboardFeatureAdapter,
} from '../../shared/src/extension-bridge.js'
import { extensionBridgeRegistry } from './registry.js'

export const DASHBOARD_EXTENSION_BRIDGE_SYMBOL = Symbol.for(DASHBOARD_EXTENSION_BRIDGE_SYMBOL_KEY)

export function installSdkExtensionBridge(sessionManager: object, slotKey: string): () => void {
  const disposers = new Set<() => void>()
  const capability: DashboardExtensionBridgeCapability = Object.freeze({
    apiVersion: DASHBOARD_EXTENSION_BRIDGE_API_VERSION,
    register(adapter: DashboardFeatureAdapter): () => void {
      const unregister = extensionBridgeRegistry.register(slotKey, adapter)
      disposers.add(unregister)
      let active = true
      return () => {
        if (!active) return
        active = false
        disposers.delete(unregister)
        unregister()
      }
    },
  })

  Object.defineProperty(sessionManager, DASHBOARD_EXTENSION_BRIDGE_SYMBOL, {
    configurable: true,
    enumerable: false,
    value: capability,
    writable: false,
  })

  return () => {
    for (const dispose of [...disposers]) dispose()
    disposers.clear()
    try { delete (sessionManager as Record<PropertyKey, unknown>)[DASHBOARD_EXTENSION_BRIDGE_SYMBOL] } catch {}
  }
}
