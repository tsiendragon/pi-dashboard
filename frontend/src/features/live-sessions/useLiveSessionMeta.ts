import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LiveSessionMeta, LiveSessionMetaPatch } from '@shared/live-sessions'
import { liveSessionApi } from './api'

export type LiveSessionMetaMap = Record<string, LiveSessionMeta>

/**
 * Sidebar tags, pin and appearance for live Pi sessions.
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
  patch: (processInstanceId: string, sessionId: string, p: LiveSessionMetaPatch) => Promise<boolean>
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

  const patch = useCallback(async (processInstanceId: string, sessionId: string, p: LiveSessionMetaPatch) => {
    // Appearance has an explicit preview/save flow: keep the row unchanged until
    // the server confirms the write. Existing tags/pin remain optimistic.
    if (p.color === undefined && p.emoji === undefined) setMeta(current => {
      const prev = current[sessionId] || { tags: [], pinned: false, updatedAt: '' }
      const next: LiveSessionMeta = {
        ...prev,
        tags: p.tags ?? prev.tags,
        pinned: p.pinned ?? prev.pinned,
        updatedAt: new Date().toISOString(),
      }
      const map = { ...current }
      if (next.tags.length || next.pinned || next.tmux || next.color || next.emoji) map[sessionId] = next
      else delete map[sessionId]
      return map
    })
    try {
      setMeta(await liveSessionApi.patchMeta(processInstanceId, p))
      setError(undefined)
      return true
    } catch (reason) {
      await refresh()
      setError(reason instanceof Error ? reason.message : String(reason))
      return false
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
