import { EventEmitter } from 'events'
import {
  DASHBOARD_EXTENSION_BRIDGE_API_VERSION,
  type DashboardFeatureAdapter,
  type DashboardFeatureName,
  type ExtensionFeatureSnapshot,
} from '../../shared/src/extension-bridge.js'

const COMMAND_TIMEOUT_MS = 30_000

type Entry = {
  adapter: DashboardFeatureAdapter
  unsubscribe: () => void
  snapshot: ExtensionFeatureSnapshot
  dispatchTail: Promise<unknown>
}

function key(slot: string, feature: DashboardFeatureName): string {
  return `${slot}\u0000${feature}`
}

function revisionOf(snapshot: unknown, fallback: number): number {
  if (snapshot && typeof snapshot === 'object') {
    const value = (snapshot as { revision?: unknown }).revision
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  }
  return fallback
}

export class ExtensionBridgeRegistry extends EventEmitter {
  private readonly entries = new Map<string, Entry>()

  register(slot: string, adapter: DashboardFeatureAdapter): () => void {
    if (adapter.apiVersion !== DASHBOARD_EXTENSION_BRIDGE_API_VERSION) {
      throw new Error(`Unsupported ${adapter.feature} bridge API version: ${adapter.apiVersion}`)
    }
    const entryKey = key(slot, adapter.feature)
    this.detach(slot, adapter.feature)

    const initialState = adapter.getSnapshot()
    const entry: Entry = {
      adapter,
      unsubscribe: () => {},
      snapshot: {
        slot,
        feature: adapter.feature,
        apiVersion: DASHBOARD_EXTENSION_BRIDGE_API_VERSION,
        revision: revisionOf(initialState, 0),
        generatedAt: Date.now(),
        state: initialState,
      },
      dispatchTail: Promise.resolve(),
    }
    entry.unsubscribe = adapter.subscribe((state) => {
      const current = this.entries.get(entryKey)
      if (current !== entry) return
      const nextRevision = revisionOf(state, current.snapshot.revision + 1)
      if (nextRevision < current.snapshot.revision) return
      current.snapshot = {
        slot,
        feature: adapter.feature,
        apiVersion: DASHBOARD_EXTENSION_BRIDGE_API_VERSION,
        revision: nextRevision,
        generatedAt: Date.now(),
        state,
      }
      this.emit('snapshot', current.snapshot)
    })
    this.entries.set(entryKey, entry)
    this.emit('attached', entry.snapshot)
    this.emit('snapshot', entry.snapshot)

    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.entries.get(entryKey) === entry) this.detach(slot, adapter.feature)
    }
  }

  list(slot: string): ExtensionFeatureSnapshot[] {
    return [...this.entries.values()]
      .map(entry => entry.snapshot)
      .filter(snapshot => snapshot.slot === slot)
      .sort((a, b) => a.feature.localeCompare(b.feature))
  }

  get(slot: string, feature: DashboardFeatureName): ExtensionFeatureSnapshot | undefined {
    return this.entries.get(key(slot, feature))?.snapshot
  }

  async dispatch(slot: string, feature: DashboardFeatureName, command: unknown): Promise<unknown> {
    const entry = this.entries.get(key(slot, feature))
    if (!entry) throw Object.assign(new Error(`${feature} is not available for slot ${slot}`), { code: 'integration_unavailable' })

    const run = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          entry.adapter.dispatch(command),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('Integration command timed out'), { code: 'integration_timeout' })), COMMAND_TIMEOUT_MS)
            timer.unref?.()
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    const result = entry.dispatchTail.then(run, run)
    entry.dispatchTail = result.catch(() => undefined)
    return result
  }

  detach(slot: string, feature: DashboardFeatureName, stale = false): void {
    const entryKey = key(slot, feature)
    const entry = this.entries.get(entryKey)
    if (!entry) return
    this.entries.delete(entryKey)
    try { entry.unsubscribe() } catch {}
    Promise.resolve(entry.adapter.dispose?.()).catch(() => {})
    this.emit('detached', { ...entry.snapshot, stale })
  }

  detachSlot(slot: string): void {
    for (const snapshot of this.list(slot)) this.detach(slot, snapshot.feature)
  }

  async dispose(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.allSettled(entries.map(async entry => {
      try { entry.unsubscribe() } catch {}
      await entry.adapter.dispose?.()
    }))
    this.removeAllListeners()
  }
}

export const extensionBridgeRegistry = new ExtensionBridgeRegistry()
