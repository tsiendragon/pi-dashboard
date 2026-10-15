import { useCallback, useEffect, useState } from 'react'

/** Poll only while both the owning view and browser document are visible. */
export function useSupervisorResource<T>(load: (signal: AbortSignal) => Promise<T>, enabled = true, intervalMs = 10_000) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<unknown>()
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  useEffect(() => {
    if (!enabled) return
    let active = true
    let controller: AbortController | undefined
    const fetchResource = async () => {
      if (document.hidden || controller) return
      controller = new AbortController()
      const current = controller
      setLoading(true)
      try {
        const value = await load(current.signal)
        if (active && !current.signal.aborted) { setData(value); setError(undefined) }
      } catch (failure) {
        if (active && !current.signal.aborted) setError(failure)
      } finally {
        if (controller === current) {
          controller = undefined
          if (active) setLoading(false)
        }
      }
    }
    const visibility = () => {
      if (document.hidden) { controller?.abort(); controller = undefined; setLoading(false) }
      else void fetchResource()
    }
    void fetchResource()
    const timer = intervalMs > 0 ? setInterval(() => void fetchResource(), intervalMs) : undefined
    document.addEventListener('visibilitychange', visibility)
    return () => {
      active = false
      controller?.abort()
      if (timer) clearInterval(timer)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [load, enabled, intervalMs, revision])
  return { data, error, loading, refresh }
}
