import { useCallback, useEffect, useState } from 'react'
import { liveSessionApi } from './api'

/**
 * Manual sidebar order for Live Pi sessions.
 *
 * Server-backed (see `backend/live-sessions/order.ts`) so every browser and
 * device sees the same order, matching how tags and pin already work. The list
 * is written whole after a drag, so a failed write simply refetches instead of
 * leaving the UI on a position the server never accepted.
 */
export function useLiveSessionOrder(): {
  order: string[]
  save: (next: string[]) => Promise<void>
  reset: () => Promise<void>
  refresh: () => Promise<void>
  error: string | undefined
} {
  const [order, setOrder] = useState<string[]>([])
  const [error, setError] = useState<string | undefined>(undefined)

  const refresh = useCallback(async () => {
    try {
      setOrder(await liveSessionApi.listOrder())
      setError(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const save = useCallback(async (next: string[]) => {
    const previous = order
    setOrder(next)
    try {
      setOrder(await liveSessionApi.saveOrder(next))
      setError(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setOrder(previous)
      await refresh()
    }
  }, [order, refresh])

  const reset = useCallback(() => save([]), [save])

  return { order, save, reset, refresh, error }
}