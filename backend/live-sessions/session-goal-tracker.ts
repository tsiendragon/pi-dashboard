import { open } from 'node:fs/promises'
import { goalAnchorFromEntries, type GoalAnchor } from '../../shared/src/goal-anchor.js'

/**
 * Incrementally reads `goal-state` entries out of live session files.
 *
 * The registry's snapshot stream only carries goals when the session process
 * projects goal entries, so sessions running older bridge code would keep
 * advertising "no goal" even though their file has one — and a goal created
 * mid-session only appears after a reconnect or reload. The session file is
 * append-only and is the same source of truth the bridge reads, so the registry
 * tails it directly: one `stat` per tick per session plus a read of whatever was
 * appended since the last pass.
 */

/** Sessions are append-only, so the newest goal state near the end wins; the cap mirrors `readSessionGoalAnchor`. */
const DEFAULT_TAIL_BYTES = 16 * 1024 * 1024

export interface GoalFileScan {
  /** Latest anchor; `null` when the newest `goal-state` entry cleared the goal. */
  goal: GoalAnchor | null
  /** Timestamp of the newest `goal-state` entry, when the file recorded one. */
  updatedAt?: number
}

interface FileState {
  /** Byte offset up to which the file has been consumed. */
  offset: number
  /** Trailing bytes of an entry that was still being appended. */
  pending: string
  /** `message` entries recorded after the newest `goal-state` entry (staleness hint). */
  messagesSince: number
  goal: GoalAnchor | null
  hasGoalEntries: boolean
  updatedAt?: number
}

export class SessionGoalFileTracker {
  private readonly files = new Map<string, FileState>()
  private readonly tailBytes: number

  constructor(options: { tailBytes?: number } = {}) {
    this.tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES
  }

  /**
   * Scan appended bytes for `goal-state` entries.
   *
   * Returns `undefined` when the file is unreadable or carries no goal-state
   * entry at all, so callers can keep whatever a snapshot already provided.
   */
  async refresh(sessionFile: string): Promise<GoalFileScan | undefined> {
    const existing = this.files.get(sessionFile)
    let handle
    try {
      handle = await open(sessionFile, 'r')
    } catch {
      // Deleted files (closed sessions, moved workspaces) just stop tracking.
      this.files.delete(sessionFile)
      return undefined
    }
    try {
      const info = await handle.stat()
      let state: FileState
      if (existing && existing.offset <= info.size) {
        state = existing
      } else {
        // First sight, or the file was truncated/replaced (rotation, `/clear`):
        // seed from a tail window and drop the leading partial line.
        const start = Math.max(0, info.size - this.tailBytes)
        const length = info.size - start
        const buffer = Buffer.alloc(length)
        if (length > 0) await handle.read(buffer, 0, length, start)
        const raw = buffer.toString('utf8')
        let seed = raw
        if (start > 0) {
          // Only a fragment is lost when the window starts mid-line; a window that
          // starts exactly on a line boundary keeps every line.
          const onBoundary = await this.readsLineBoundary(handle, start)
          const firstBreak = raw.indexOf('\n')
          seed = onBoundary || firstBreak < 0 ? raw : raw.slice(firstBreak + 1)
        }
        state = { offset: info.size, pending: '', messagesSince: 0, goal: null, hasGoalEntries: false }
        this.consumeChunk(state, seed)
      }
      if (info.size > state.offset) {
        const length = info.size - state.offset
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, state.offset)
        state.offset = info.size
        this.consumeChunk(state, state.pending + buffer.toString('utf8'))
      }
      this.files.set(sessionFile, state)
      if (!state.hasGoalEntries) return undefined
      // `messagesSinceUpdate` is derived per read: the anchor object is reused
      // across refreshes, so patch the running count just before handing it out.
      if (state.goal) state.goal.messagesSinceUpdate = state.messagesSince
      return {
        goal: state.goal,
        ...(state.updatedAt !== undefined ? { updatedAt: state.updatedAt } : {}),
      }
    } finally {
      await handle.close()
    }
  }

  /** Drop tracking for one file (e.g. after its session detached). */
  forget(sessionFile: string): void {
    this.files.delete(sessionFile)
  }

  /** Drop tracking for every file no live session references anymore. */
  retain(sessionFiles: ReadonlySet<string>): void {
    for (const file of this.files.keys()) {
      if (!sessionFiles.has(file)) this.files.delete(file)
    }
  }

  /** True when the byte right before `start` is a newline (the window starts on a line boundary). */
  private async readsLineBoundary(handle: Awaited<ReturnType<typeof open>>, start: number): Promise<boolean> {
    const probe = Buffer.alloc(1)
    await handle.read(probe, 0, 1, start - 1)
    return probe[0] === 0x0a
  }

  /** Consume a chunk of text, keeping the last (possibly partial) line pending. */
  private consumeChunk(state: FileState, text: string): void {
    let index = text.indexOf('\n')
    while (index >= 0) {
      this.consumeLine(state, text.slice(0, index))
      text = text.slice(index + 1)
      index = text.indexOf('\n')
    }
    state.pending = text
  }

  private consumeLine(state: FileState, line: string): void {
    if (!line.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    const entry = parsed as Record<string, unknown> | null
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return
    if (entry.type === 'message') {
      state.messagesSince += 1
      return
    }
    if (entry.type !== 'custom' || entry.customType !== 'goal-state') return
    const data = entry.data as Record<string, unknown> | undefined
    if (!data || typeof data !== 'object' || !('state' in data)) return
    state.hasGoalEntries = true
    state.messagesSince = 0
    const updatedAt = entryTimestamp(entry)
    if (updatedAt !== undefined) state.updatedAt = updatedAt
    if (data.state == null) {
      // A clear/replace tombstone: the session has no goal from here on.
      state.goal = null
      return
    }
    const anchor = goalAnchorFromEntries([
      {
        type: 'custom',
        customType: 'goal-state',
        data,
        ...(updatedAt !== undefined ? { timestamp: updatedAt } : {}),
      },
    ])
    // A malformed state keeps the previous anchor instead of blanking the row.
    if (anchor) state.goal = anchor
  }
}

function entryTimestamp(entry: Record<string, unknown>): number | undefined {
  const raw = entry.timestamp ?? entry.time
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}