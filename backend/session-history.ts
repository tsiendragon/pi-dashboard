/**
 * On-demand history paging for pi session transcripts.
 *
 * Session JSONL files grow with every tool result and can reach hundreds of
 * MB, so a history page must never read the whole file. Pages are read
 * BACKWARDS from a byte offset in bounded chunks: we snap to line boundaries,
 * grow the window until it covers the requested number of rows, and finally
 * feed just those lines through the shared session line parser.
 *
 * Cursors are opaque to the client and encode the byte offset of the next
 * window start (a line boundary) plus the file size when they were minted.
 * Append-only growth keeps offsets stable; when the file shrinks (rewritten
 * transcript) the cursor is treated as exhausted instead of returning
 * misaligned bytes.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'fs'
import { createSessionLineParser, type ChatMessage } from './session-store.js'

/** Default page size in JSONL rows (one row is roughly one message). */
export const HISTORY_PAGE_ROWS = 200
const MAX_PAGE_ROWS = 1000
const INITIAL_WINDOW_BYTES = 4 * 1024 * 1024
const TAIL_PROBE_BYTES = 64 * 1024
/** Hard ceiling so a pathological file cannot exhaust memory while paging. */
const MAX_WINDOW_BYTES = 256 * 1024 * 1024

export interface SessionHistoryPage {
  messages: ChatMessage[]
  /** Cursor for the next (older) page; null when the start of the file was reached. */
  nextCursor: string | null
  hasMore: boolean
}

export function encodeHistoryCursor(offset: number, size: number): string {
  return `b:${offset}:${size}`
}

export function decodeHistoryCursor(cursor: string): { offset: number; size: number } | null {
  const m = /^b:(\d+):(\d+)$/.exec(cursor)
  if (!m) return null
  return { offset: Number(m[1]), size: Number(m[2]) }
}

function readRange(fd: number, start: number, length: number): Buffer {
  const buf = Buffer.allocUnsafe(length)
  let done = 0
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, start + done)
    if (n <= 0) break
    done += n
  }
  return done === length ? buf : buf.subarray(0, done)
}

/**
 * Find the position just after the last newline at or before `size`.
 * Returns 0 when the file has no newline at all.
 */
function findLastLineBoundary(fd: number, size: number): number {
  let pos = size
  while (pos > 0) {
    const chunk = Math.min(TAIL_PROBE_BYTES, pos)
    const buf = readRange(fd, pos - chunk, chunk)
    const idx = buf.lastIndexOf(10)
    if (idx >= 0) return pos - chunk + idx + 1
    pos -= chunk
  }
  return 0
}

/** Extra rows scanned beyond the page size to align tool-call boundaries. */
const TOOL_ALIGN_EXTRA_ROWS = 10

interface RawRow {
  /** Absolute byte offset of the row start. */
  offset: number
  text: string
}

/** Matches a JSONL row carrying a toolResult (compact SDK serialization). */
function isToolResultRow(text: string): boolean {
  return /"role"\s*:\s*"toolResult"/.test(text)
}

/**
 * Collect up to `maxRows` complete rows from `buf` (a file range starting at
 * `fileStart` and ending at a line boundary). Complete rows are delimited by
 * newlines; rows are returned newest-first. Bytes before the oldest newline
 * form a partial segment and are ignored — the caller either extends the
 * window or accepts that those bytes belong to an older row.
 */
function rowsInRange(buf: Buffer, fileStart: number, maxRows: number): { rows: RawRow[]; hole: RawRow | null } {
  const nls: number[] = []
  let p = buf.length
  while (p > 0 && nls.length <= maxRows + 1) {
    const idx = buf.lastIndexOf(10, p - 1)
    if (idx < 0) break
    nls.push(idx)
    p = idx
  }
  const rows: RawRow[] = []
  for (let k = 0; k + 1 < nls.length && rows.length < maxRows; k++) {
    rows.push({ offset: fileStart + nls[k + 1] + 1, text: buf.subarray(nls[k + 1] + 1, nls[k]).toString('utf8') })
  }
  const holeEnd = nls.length > 0 ? nls[nls.length - 1] : buf.length
  const hole: RawRow | null = holeEnd > 0 ? { offset: fileStart, text: buf.subarray(0, holeEnd).toString('utf8') } : null
  return { rows, hole }
}

/**
 * Read up to `maxRows` complete rows ending at `endOffset` (a line boundary).
 * `endOffset === null` means the current end of the file, in which case a
 * partial trailing write is skipped. Returns rows oldest-first plus the byte
 * offset of the oldest returned row (0 when the file head was reached).
 */
function readCompleteRowsEndingAt(
  fd: number,
  size: number,
  endOffset: number | null,
  maxRows: number,
): { rows: string[]; startOffset: number; reachedStart: boolean } {
  let end = endOffset == null ? size : Math.min(endOffset, size)
  if (end === size) {
    end = findLastLineBoundary(fd, end)
  }
  if (end <= 0) return { rows: [], startOffset: 0, reachedStart: true }

  let cap = Math.min(INITIAL_WINDOW_BYTES, end)
  for (;;) {
    const start = Math.max(0, end - cap)
    const hitHead = start === 0
    const { rows, hole } = rowsInRange(readRange(fd, start, end - start), start, maxRows + TOOL_ALIGN_EXTRA_ROWS)
    // At the file head the hole is a real first row; collect it as the oldest.
    const collected = hitHead && hole ? [...rows, hole] : rows
    if (collected.length >= maxRows || hitHead) {
      let count = Math.min(maxRows, collected.length)
      // Align page boundaries to tool calls: a window must not start on a
      // toolResult row whose toolCall is outside it, or the result surfaces
      // as a confusing standalone tool message. Extend backwards (a few
      // rows) until the oldest included row is not a toolResult.
      while (
        count < collected.length &&
        count > 0 &&
        isToolResultRow(collected[count - 1].text)
      ) {
        count += 1
      }
      const chosen = collected.slice(0, count)
      const oldest = chosen.length > 0 ? chosen[chosen.length - 1] : null
      return {
        rows: chosen.slice().reverse().map(r => r.text),
        startOffset: oldest ? oldest.offset : 0,
        reachedStart: hitHead,
      }
    }
    if (cap >= MAX_WINDOW_BYTES) {
      // A single row exceeds the window ceiling — give up rather than OOM.
      return { rows: [], startOffset: 0, reachedStart: true }
    }
    cap *= 4
  }
}

/**
 * Read the newest page (when `cursor` is null) or the page just before the
 * cursor. Returns null when the session file does not exist.
 */
export function readSessionHistoryPage(
  sessionPath: string,
  opts: { cursor?: string | null; rows?: number } = {},
): SessionHistoryPage | null {
  if (!existsSync(sessionPath)) return null
  const rows = Math.max(1, Math.min(opts.rows ?? HISTORY_PAGE_ROWS, MAX_PAGE_ROWS))

  let size = 0
  try { size = statSync(sessionPath).size } catch { return null }

  let endOffset: number | null = null
  if (opts.cursor) {
    const decoded = decodeHistoryCursor(opts.cursor)
    if (!decoded || decoded.offset <= 0) return { messages: [], nextCursor: null, hasMore: false }
    if (size < decoded.size) {
      // File rewritten/truncated — the stored offset no longer maps to content.
      return { messages: [], nextCursor: null, hasMore: false }
    }
    endOffset = decoded.offset
  }

  let fd: number
  try { fd = openSync(sessionPath, 'r') } catch { return null }
  try {
    const win = readCompleteRowsEndingAt(fd, size, endOffset, rows)
    const parser = createSessionLineParser()
    for (const line of win.rows) parser.feed(line)
    const nextCursor = win.startOffset > 0 ? encodeHistoryCursor(win.startOffset, size) : null
    return { messages: parser.messages, nextCursor, hasMore: nextCursor !== null }
  } finally {
    closeSync(fd)
  }
}