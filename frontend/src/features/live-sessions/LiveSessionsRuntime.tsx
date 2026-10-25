import { createContext, useContext, type ReactNode } from 'react'
import { useLiveSessionsRuntime } from './useLiveSessions'

/**
 * One live-session runtime for the whole app.
 *
 * The runtime owns a single WebSocket plus the pending-UI state (`pendingUi`). It used to be mounted
 * per page and while the main-agent dialog was open, so an approval raised while the user sat on
 * another page reached nobody — and two mounted copies opened two sockets. Mounting it once at the
 * app root keeps approvals reachable from every page; pages only ask for `refresh()`.
 */
const RuntimeContext = createContext<{ refresh: () => Promise<void> } | null>(null)

export function LiveSessionsRuntimeProvider({ children }: { children: ReactNode }) {
  const runtime = useLiveSessionsRuntime()
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>
}

/** Refresh handle for pages that show live sessions. Requires the root provider. */
export function useLiveSessionsRefresh(): { refresh: () => Promise<void> } {
  const runtime = useContext(RuntimeContext)
  if (!runtime) throw new Error('LiveSessionsRuntimeProvider is required')
  return runtime
}