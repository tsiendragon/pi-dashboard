import type { LiveSessionSummary } from '@shared/live-sessions'

/**
 * How long a detached live session keeps its row in the sidebar.
 *
 * The registry deletes an entry once its transport has been gone for
 * `disconnectGraceMs` (15 s by default), and the browser used to mirror that
 * deletion instantly. A Pi that reconnects later than 15 s therefore made its
 * row blink: gone on `detached`, back on the next `attached`. Holding the row
 * for a full minute turns that cycle into a steady 「重连中」 row, while a session
 * that really ended still disappears once the window closes.
 */
export const DETACH_GRACE_MS = 60_000

/** How often expired detaches are flushed. Rows may lag the window by this much. */
export const DETACH_FLUSH_MS = 5_000

export interface PendingDetach {
  summary: LiveSessionSummary
  reason?: string
  expiresAt: number
}

/** Remember a detached session so its row survives the next list refresh. */
export function scheduleDetach(
  pending: Map<string, PendingDetach>,
  summary: LiveSessionSummary,
  now: number,
  reason?: string,
  graceMs: number = DETACH_GRACE_MS,
): void {
  pending.set(summary.processInstanceId, {
    summary,
    ...(reason ? { reason } : {}),
    expiresAt: now + graceMs,
  })
}

/** Forget a pending detach: the session announced itself again. */
export function cancelDetach(pending: Map<string, PendingDetach>, processInstanceId: string): void {
  pending.delete(processInstanceId)
}

/** Drop the detaches whose grace window has closed, returning them for dispatch. */
export function expireDetaches(pending: Map<string, PendingDetach>, now: number): PendingDetach[] {
  const expired: PendingDetach[] = []
  for (const [id, entry] of pending) {
    if (entry.expiresAt > now) continue
    pending.delete(id)
    expired.push(entry)
  }
  return expired
}

/**
 * Summaries that must survive a list payload: sessions detached inside their
 * grace window and absent from the payload.
 *
 * A session the server still reports is left out — that copy is fresher than
 * ours, and keeping two would only risk reviving a stale status.
 */
export function pendingSummaries(
  pending: Map<string, PendingDetach>,
  now: number,
  reported: readonly string[] = [],
): LiveSessionSummary[] {
  const reportedIds = new Set(reported)
  const out: LiveSessionSummary[] = []
  for (const entry of pending.values()) {
    if (entry.expiresAt <= now) continue
    if (reportedIds.has(entry.summary.processInstanceId)) continue
    out.push(entry.summary)
  }
  return out
}