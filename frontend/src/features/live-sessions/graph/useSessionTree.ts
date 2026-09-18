import { useCallback, useEffect, useState } from 'react'
import type { SessionTreeGraph } from '@shared/session-tree'
import { useAppSelector } from '../../../store'
import { liveSessionApi } from '../api'

export interface SessionTreeState {
  graph: SessionTreeGraph | null
  loading: boolean
  error: string | null
  refresh: () => void
}

/**
 * Load the session-family graph for a session file.
 *
 * Refetch trigger: the matching live session's `summary.revision`. The bridge
 * bumps it on every `session_tree` event (terminal `/tree` or the web
 * `/ls-navigate`) and pushes a fresh snapshot, so a branch switch anywhere is
 * reflected here without polling.
 */
export function useSessionTree(file: string | null): SessionTreeState {
  const [graph, setGraph] = useState<SessionTreeGraph | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const revision = useAppSelector(state => {
    if (!file) return -1
    for (const detail of Object.values(state.liveSessions.details)) {
      if (detail.summary.sessionFile === file) return detail.summary.revision
    }
    return -1
  })

  useEffect(() => {
    if (!file) {
      setGraph(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    liveSessionApi.sessionTree(file)
      .then(result => { if (!cancelled) setGraph(result) })
      .catch((cause: unknown) => {
        if (cancelled) return
        setGraph(null)
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [file, revision, nonce])

  const refresh = useCallback(() => setNonce(value => value + 1), [])
  return { graph, loading, error, refresh }
}