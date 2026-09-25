/**
 * Compaction completion watch.
 *
 * `/compact` is fire-and-forget on the agent side: the extension API documents
 * `ctx.compact()` as "trigger compaction without awaiting completion", so the
 * command ack arrives while the summarization still runs for tens of seconds.
 * Claiming "完成" at that point is simply wrong — the user has to guess whether
 * the session is free again.
 *
 * The honest signal is the `compaction` entry landing in the session file. This
 * module polls that marker list and reports completion only when a marker appears
 * that was not there when the command was sent.
 */

export interface CompactionMark {
  /** Entry timestamp pi wrote when the compaction landed (ISO 8601). */
  timestamp?: string
  /** Context tokens measured before that compaction ran. */
  tokensBefore?: number
}

/** Marker list plus the server clock it should be compared against. */
export interface CompactionSnapshot {
  now: number
  compactions: CompactionMark[]
}

/** State captured before `/compact` was sent: everything after it is new. */
export interface CompactionBaseline {
  now: number
  count: number
}

export interface CompactionWatchOptions {
  /** Absolute session file path; without it completion cannot be observed. */
  sessionFile?: string
  /** Baseline captured before the command (see `CompactionBaseline`). */
  baseline?: CompactionBaseline
  fetchSnapshot: (file: string) => Promise<CompactionSnapshot>
  intervalMs?: number
  timeoutMs?: number
  /** Test seams. */
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => number
  signal?: AbortSignal
}

export type CompactionWatchResult =
  | { status: 'completed'; mark: CompactionMark }
  | { status: 'timeout' }
  | { status: 'cancelled' }
  /** No way to observe completion: no session file or no baseline. */
  | { status: 'unavailable' }

export const COMPACTION_WATCH_INTERVAL_MS = 2_500
/** Generous: a large session's summary call has been seen to take minutes. */
export const COMPACTION_WATCH_TIMEOUT_MS = 300_000

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/**
 * Resolve when a compaction marker newer than `baseline` appears.
 *
 * Only markers at or after `baseline.count` — the file is append-only, so new
 * markers sit at the end — or markers whose timestamp is at/after the server
 * `baseline.now` count as fresh. Both are used because a session file longer than
 * the parse window only exposes its tail.
 */
export async function watchCompaction(options: CompactionWatchOptions): Promise<CompactionWatchResult> {
  const {
    sessionFile,
    baseline,
    fetchSnapshot,
    intervalMs = COMPACTION_WATCH_INTERVAL_MS,
    timeoutMs = COMPACTION_WATCH_TIMEOUT_MS,
    signal,
  } = options
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? (() => Date.now())
  if (!sessionFile || !baseline) return { status: 'unavailable' }
  const deadline = now() + timeoutMs

  for (;;) {
    if (signal?.aborted) return { status: 'cancelled' }
    let marks: CompactionMark[] = []
    try {
      marks = (await fetchSnapshot(sessionFile)).compactions
    } catch {
      // Transient read failure (session file mid-write, backend restart): keep
      // waiting rather than reporting a completion we cannot prove.
      marks = []
    }
    const fresh = marks.filter((mark, index) => {
      if (index >= baseline.count) return true
      return mark.timestamp ? Date.parse(mark.timestamp) >= baseline.now : false
    })
    if (fresh.length > 0) return { status: 'completed', mark: fresh[fresh.length - 1] }
    if (now() >= deadline) return { status: 'timeout' }
    await sleep(intervalMs)
  }
}