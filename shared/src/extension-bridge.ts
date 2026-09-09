export const DASHBOARD_EXTENSION_BRIDGE_API_VERSION = 1 as const
export const DASHBOARD_EXTENSION_BRIDGE_SYMBOL_KEY = 'pi.dashboard.extension-bridge.v1'

export type DashboardFeatureName =
  | 'subagent-workbench'
  | 'btw'
  | 'background-commands'

export interface ExtensionFeatureSnapshot {
  slot: string
  feature: DashboardFeatureName
  apiVersion: typeof DASHBOARD_EXTENSION_BRIDGE_API_VERSION
  revision: number
  generatedAt: number
  state: unknown
  stale?: boolean
}

export interface ExtensionFeatureCommandResult {
  requestId?: string
  ok: boolean
  result?: unknown
  error?: {
    code: string
    message: string
  }
}

export interface DashboardFeatureAdapter {
  readonly feature: DashboardFeatureName
  readonly apiVersion: typeof DASHBOARD_EXTENSION_BRIDGE_API_VERSION
  getSnapshot(): unknown
  subscribe(listener: (snapshot: unknown) => void): () => void
  dispatch(command: unknown): Promise<unknown>
  dispose?(): void | Promise<void>
}

export interface DashboardExtensionBridgeCapability {
  readonly apiVersion: typeof DASHBOARD_EXTENSION_BRIDGE_API_VERSION
  register(adapter: DashboardFeatureAdapter): () => void
}

export function isDashboardFeatureName(value: unknown): value is DashboardFeatureName {
  return value === 'subagent-workbench' || value === 'btw' || value === 'background-commands'
}
