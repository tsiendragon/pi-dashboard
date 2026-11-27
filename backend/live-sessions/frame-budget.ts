/**
 * Upper bound on the size of one WebSocket frame sent to a browser/Android client.
 *
 * Why this exists: the client parses a frame with okio `Buffer.readUtf8`, which
 * allocates the whole message string BEFORE `WebSocketListener.onMessage` runs.
 * Any size check inside `onMessage` is therefore too late -- a 105 MB frame
 * already failed with `OutOfMemoryError: Failed to allocate a 105571368 byte
 * allocation` on a 256 MB Android heap before the app could reject it.
 *
 * The snapshot is the dangerous frame: the registry can hold `maxTimelineEntries`
 * (1000) entries of a long session, and a single 52 MB session file can serialize
 * well past 100 MB. The frame must be bounded on the server, where we can shrink
 * it deterministically.
 *
 * The budget is measured in actual UTF-8 bytes, not JavaScript string length.
 * UTF-16 code units are only a lower bound: Chinese text commonly takes three
 * UTF-8 bytes per code unit, so an 8 MB character-based budget could produce a
 * 24 MB frame and exceed the client's 16 MB limit. `Buffer.byteLength` performs
 * an O(n) scan of the already-serialized JSON without making another copy.
 */

/**
 * Client-side hard rejection threshold (`LivePiRepository.onMessage`). Kept in
 * sync deliberately: the server must stay well under it.
 */
export const CLIENT_FRAME_LIMIT_BYTES = 16 * 1024 * 1024

/**
 * Server budget for one frame. Half the client limit leaves room for the
 * snapshot envelope, JSON escaping of non-ASCII text, and the client's own
 * copies while parsing.
 */
export const SERVER_FRAME_BUDGET_BYTES = 8 * 1024 * 1024

/** Minimum entries kept even when every entry is huge, so the tail is still usable. */
const MIN_KEPT_ENTRIES = 20

type JsonRecord = Record<string, unknown>

function object(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined
}

/** Actual serialized UTF-8 byte size of one entry. */
function entrySize(entry: unknown): number {
  try {
    const serialized = JSON.stringify(entry)
    return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8')
  } catch {
    return 0
  }
}

export interface TrimResult {
  /** The projection with `entries` reduced to fit the budget. */
  value: unknown
  /** Entries dropped from the front (older history). */
  droppedEntries: number
  /** `entries.length` after trimming. */
  keptEntries: number
  /** True when even one trailing entry exceeds the budget on its own. */
  overBudget: boolean
}

/**
 * Trim a `LiveSessionDetail`-shaped projection so it fits one frame.
 *
 * History is trimmed from the front (oldest first): the tail is what the client
 * renders by default and what compact sync is meant to show. When the projection
 * is not entry-shaped (or already fits) it is returned untouched.
 */
export function trimDetailToBudget(
  raw: unknown,
  budgetBytes: number = SERVER_FRAME_BUDGET_BYTES,
): TrimResult {
  const detail = object(raw)
  if (!detail || !Array.isArray(detail.entries)) {
    return { value: raw, droppedEntries: 0, keptEntries: 0, overBudget: false }
  }
  const entries = detail.entries
  if (entries.length === 0) return { value: raw, droppedEntries: 0, keptEntries: 0, overBudget: false }

  // Cost of everything that is not the entries array, so the budget covers the whole frame.
  const serializedShell = JSON.stringify({ ...detail, entries: [] })
  const shellSize = Math.max(0, (serializedShell === undefined ? 0 : Buffer.byteLength(serializedShell, 'utf8')) - 2)
  let remaining = budgetBytes - shellSize

  const kept: unknown[] = []
  let firstSize = -1
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const size = entrySize(entries[index])
    if (kept.length === 0) firstSize = size
    // Keep going past the floor only while entries still fit. Once the newest
    // entry alone exceeds the budget the floor cannot apply: keeping 20 huge
    // entries would recreate exactly the oversized frame this guards against.
    // Every entry after the first also adds one comma to the entries array.
    const separatorSize = kept.length > 0 ? 1 : 0
    const fits = remaining - size - separatorSize >= 0
    if (kept.length >= MIN_KEPT_ENTRIES && !fits) break
    if (kept.length > 0 && !fits) break
    remaining -= size + separatorSize
    kept.push(entries[index])
  }
  kept.reverse()

  const overBudget = kept.length === 1 && shellSize + firstSize > budgetBytes
  if (kept.length === entries.length) {
    return { value: raw, droppedEntries: 0, keptEntries: kept.length, overBudget }
  }
  return {
    value: { ...detail, entries: kept },
    droppedEntries: entries.length - kept.length,
    keptEntries: kept.length,
    overBudget,
  }
}
