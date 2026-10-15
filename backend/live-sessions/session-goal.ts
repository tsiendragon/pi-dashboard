import { open, realpath } from 'node:fs/promises'
import { sep } from 'node:path'
import { goalAnchorFromEntries, type GoalAnchor } from '../../shared/src/goal-anchor.js'
import { SessionTreeError, sessionsDir } from './session-tree.js'

/**
 * Read a goal anchor straight from a session file.
 *
 * The live-session registry can only serve sessions pi is still running. A
 * finished session keeps its `goal-state` entries on disk, so the graph page can
 * show the same anchor for work that already ended — which is exactly when "what
 * was left undone?" is hardest to answer from memory.
 */

/**
 * Sessions are append-only, so the newest goal state is near the end. The cap
 * mirrors the graph reader: past it we read a tail window and say so instead of
 * pretending the result is complete.
 */
const MAX_PARSE_BYTES = 16 * 1024 * 1024

export interface SessionGoalResult {
  goal: GoalAnchor | null
  /** True when only the tail of an oversized file was read. */
  partial: boolean
}

async function assertInsideSessionsDir(file: string): Promise<void> {
  const root = await realpath(sessionsDir()).catch(() => null)
  const target = await realpath(file).catch(() => null)
  if (!root || !target) throw new SessionTreeError('session_file_unavailable', 'session file is not readable')
  if (target !== root && !target.startsWith(root + sep)) {
    throw new SessionTreeError('session_file_out_of_scope', 'session file is outside the sessions directory')
  }
}

export async function readSessionGoalAnchor(sessionFile: string): Promise<SessionGoalResult> {
  await assertInsideSessionsDir(sessionFile)

  const handle = await open(sessionFile, 'r')
  let text: string
  let partial = false
  try {
    const info = await handle.stat()
    const start = Math.max(0, info.size - MAX_PARSE_BYTES)
    const length = info.size - start
    const buffer = Buffer.alloc(length)
    if (length > 0) await handle.read(buffer, 0, length, start)
    const raw = buffer.toString('utf8')
    // A tail window almost always starts mid-line; drop that fragment.
    const firstBreak = start > 0 ? raw.indexOf('\n') : -1
    text = firstBreak >= 0 ? raw.slice(firstBreak + 1) : raw
    partial = start > 0
  } finally {
    await handle.close()
  }

  /**
   * The shared parser expects the same entry shape the live protocol ships, so
   * build a reduced timeline: messages (for the "checklist went stale" count) and
   * goal-state snapshots. Every other record is irrelevant here.
   */
  const entries: unknown[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let record: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      record = parsed as Record<string, unknown>
    } catch {
      continue
    }
    if (record.type === 'message') {
      entries.push({ type: 'message' })
      continue
    }
    if (record.type === 'custom' && record.customType === 'goal-state') {
      entries.push({
        type: 'custom',
        customType: 'goal-state',
        data: record.data,
        ...(record.timestamp !== undefined ? { timestamp: record.timestamp } : {}),
      })
    }
  }

  return { goal: goalAnchorFromEntries(entries), partial }
}