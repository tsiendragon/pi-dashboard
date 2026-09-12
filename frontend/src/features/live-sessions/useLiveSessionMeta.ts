import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LiveSessionMeta } from '@shared/live-sessions'
import { liveSessionApi } from './api'

export type LiveSessionMetaMap = Record<string, LiveSessionMeta>

/**
 * Sidebar tags + pin for live Pi sessions.
 *
 * Server-side store keyed by pi `sessionId` (see `backend/live-sessions/meta.ts`),
 * so the labels survive a Pi restart and reappear when the same session
 * reattaches. Updates are applied optimistically and reconciled with the full
 * map the server returns; a failed write refetches instead of diverging.
 */
export function useLiveSessionMeta(): {
  meta: LiveSessionMetaMap
  allTags: string[]
  tagCounts: { tag: string; count: number }[]
  refresh: () => Promise<void>
  patch: (processInstanceId: string, sessionId: string, p: { tags?: string[]; pinned?: boolean }) => Promise<void>
  error: string | undefined
} {
  const [meta, setMeta] = useState<LiveSessionMetaMap>({})
  const [error, setError] = useState<string | undefined>(undefined)

  const refresh = useCallback(async () => {
    try {
      setMeta(await liveSessionApi.listMeta())
      setError(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const patch = useCallback(async (processInstanceId: string, sessionId: string, p: { tags?: string[]; pinned?: boolean }) => {
    setMeta(current => {
      const prev = current[sessionId] || { tags: [], pinned: false, updatedAt: '' }
      const next: LiveSessionMeta = {
        tags: p.tags ?? prev.tags,
        pinned: p.pinned ?? prev.pinned,
        updatedAt: new Date().toISOString(),
      }
      const map = { ...current }
      if (next.tags.length || next.pinned) map[sessionId] = next
      else delete map[sessionId]
      return map
    })
    try {
      setMeta(await liveSessionApi.patchMeta(processInstanceId, p))
      setError(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      await refresh()
    }
  }, [refresh])

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of Object.values(meta)) {
      for (const tag of entry.tags) counts.set(tag, (counts.get(tag) || 0) + 1)
    }
    return Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }, [meta])

  const allTags = useMemo(() => tagCounts.map(t => t.tag), [tagCounts])

  return { meta, allTags, tagCounts, refresh, patch, error }
}
