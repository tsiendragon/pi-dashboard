import { describe, expect, it, vi } from 'vitest'
import { watchCompaction, type CompactionMark, type CompactionSnapshot } from '../features/live-sessions/compactionWatch'

const FILE = '/tmp/sessions/abc.jsonl'
/** Realistic server clock: the markers are compared against it. */
const BASELINE_NOW = Date.parse('2026-01-01T00:00:00.000Z')

/** Deterministic clock + sleep so the loop runs without real timers. */
function harness({ marks }: { marks: CompactionSnapshot[] }) {
  let clock = 0
  const queue = [...marks]
  const fetchSnapshot = vi.fn(async (): Promise<CompactionSnapshot> => {
    const next = queue.shift()
    return next ?? marks[marks.length - 1] ?? { now: clock, compactions: [] }
  })
  return {
    fetchSnapshot,
    now: () => (clock += 2_000),
    sleep: async () => {},
    calls: () => fetchSnapshot.mock.calls.length,
  }
}

function snapshot(now: number, compactions: CompactionMark[]): CompactionSnapshot {
  return { now, compactions }
}

describe('watchCompaction', () => {
  it('reports completion as soon as a marker appears after the baseline', async () => {
    const marks: CompactionMark[] = [{ timestamp: '2026-01-01T00:00:00.000Z', tokensBefore: 165_196 }]
    const h = harness({ marks: [snapshot(1_000, []), snapshot(1_000, []), snapshot(1_000, marks)] })

    const result = await watchCompaction({
      sessionFile: FILE,
      baseline: { now: 1_000, count: 0 },
      fetchSnapshot: h.fetchSnapshot,
      sleep: h.sleep,
      now: h.now,
    })

    expect(result).toEqual({ status: 'completed', mark: marks[0] })
  })

  it('ignores markers that already existed when the command was sent', async () => {
    const before: CompactionMark[] = [{ timestamp: '2025-12-31T00:00:00.000Z', tokensBefore: 10 }]
    const after: CompactionMark = { timestamp: '2026-01-01T00:10:00.000Z', tokensBefore: 500 }
    // Baseline says one marker already existed (and its timestamp predates the command).
    const h = harness({ marks: [snapshot(BASELINE_NOW, before), snapshot(BASELINE_NOW, [...before, after])] })

    const result = await watchCompaction({
      sessionFile: FILE,
      baseline: { now: BASELINE_NOW, count: 1 },
      fetchSnapshot: h.fetchSnapshot,
      sleep: h.sleep,
      now: h.now,
    })

    expect(result).toEqual({ status: 'completed', mark: after })
    // First poll is "nothing new", the second proves completion.
    expect(h.calls()).toBe(2)
  })

  it('treats a marker timestamped after the server baseline as new even when counts shift', async () => {
    const fresh: CompactionMark = { timestamp: '2026-01-01T00:05:00.000Z', tokensBefore: 42 }
    const h = harness({ marks: [snapshot(BASELINE_NOW, [fresh])] })

    const result = await watchCompaction({
      sessionFile: FILE,
      // The parse window dropped the earlier marker, so the count went down to 1.
      baseline: { now: BASELINE_NOW - 60_000, count: 3 },
      fetchSnapshot: h.fetchSnapshot,
      sleep: h.sleep,
      now: h.now,
    })

    expect(result).toEqual({ status: 'completed', mark: fresh })
  })

  it('keeps polling through read failures instead of inventing a completion', async () => {
    let attempt = 0
    const mark: CompactionMark = { timestamp: '2026-01-01T01:00:00.000Z' }
    const fetchSnapshot = vi.fn(async (): Promise<CompactionSnapshot> => {
      attempt += 1
      if (attempt <= 2) throw new Error('session file is being written')
      return snapshot(1_000, [mark])
    })
    let clock = 0

    const result = await watchCompaction({
      sessionFile: FILE,
      baseline: { now: 1_000, count: 0 },
      fetchSnapshot,
      sleep: async () => {},
      now: () => (clock += 1_000),
    })

    expect(result).toEqual({ status: 'completed', mark })
    expect(attempt).toBe(3)
  })

  it('times out (never claims completion) when the marker never lands', async () => {
    const h = harness({ marks: [snapshot(1_000, [])] })

    const result = await watchCompaction({
      sessionFile: FILE,
      baseline: { now: 1_000, count: 0 },
      fetchSnapshot: h.fetchSnapshot,
      sleep: h.sleep,
      now: h.now,
      timeoutMs: 10_000,
    })

    expect(result).toEqual({ status: 'timeout' })
  })

  it('reports unavailable without a session file or a baseline', async () => {
    const h = harness({ marks: [snapshot(1_000, [])] })
    expect(await watchCompaction({ sessionFile: undefined, baseline: { now: 1, count: 0 }, fetchSnapshot: h.fetchSnapshot }))
      .toEqual({ status: 'unavailable' })
    expect(await watchCompaction({ sessionFile: FILE, baseline: undefined, fetchSnapshot: h.fetchSnapshot }))
      .toEqual({ status: 'unavailable' })
    expect(h.calls()).toBe(0)
  })

  it('stops when the caller aborts (session closed, newer request started)', async () => {
    const h = harness({ marks: [snapshot(1_000, [])] })
    const controller = new AbortController()
    controller.abort()

    const result = await watchCompaction({
      sessionFile: FILE,
      baseline: { now: 1_000, count: 0 },
      fetchSnapshot: h.fetchSnapshot,
      sleep: h.sleep,
      now: h.now,
      signal: controller.signal,
    })

    expect(result).toEqual({ status: 'cancelled' })
    expect(h.calls()).toBe(0)
  })
})