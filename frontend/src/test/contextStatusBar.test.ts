import { describe, expect, it } from 'vitest'
import type { LiveSessionSummary } from '@shared/live-sessions'
import {
  CONTEXT_BAR_CELLS,
  clampPercent,
  contextBarCells,
  contextTriggerPercent,
} from '../features/live-sessions/contextStatusBar'

function summary(compact?: LiveSessionSummary['compact'], contextWindow = 1_048_576): LiveSessionSummary {
  return {
    processInstanceId: 'a', sessionId: 'session-a', pid: 1,
    cwd: '/tmp', canonicalCwd: '/tmp',
    mode: 'tui', status: 'idle', claim: { state: 'unclaimed' },
    startedAt: 1, lastActivityAt: 1, revision: 1, eventSequence: 0,
    ...(compact ? { contextUsage: { tokens: 0, contextWindow, percent: 0 }, compact } : {}),
  }
}

function bar(cells: ReturnType<typeof contextBarCells>): string {
  return cells.map(cell => cell.char).join('')
}

describe('context status bar', () => {
  it('marks the real auto-compaction trigger, not the right edge', () => {
    // The setup this repo actually runs: auto-compact-target 270K on a 1M window.
    const trigger = contextTriggerPercent(summary({
      enabled: true,
      triggerTokens: 270_000,
      candidates: [{ source: 'auto-compact-target', tokens: 270_000 }],
    }))
    expect(trigger).toBeCloseTo(25.75, 2)
    const cells = contextBarCells(0, trigger)
    expect(bar(cells)).toBe('░░░│░░░░░░░░')
    expect(cells.filter(cell => cell.threshold)).toHaveLength(1)
    expect(cells[3].threshold).toBe(true)
  })

  it('lets usage fill up to and past the marker', () => {
    const cells = contextBarCells(50, 25.75)
    // 50% of 12 cells = 6 usage cells; the marker replaces the char in cell 3.
    expect(bar(cells)).toBe('███│██░░░░░░')
    // The marker never disappears behind usage: it owns its cell.
    expect(cells[3]).toEqual({ char: '│', threshold: true })
  })

  it('draws no marker when the trigger is unknown or compaction is off', () => {
    expect(bar(contextBarCells(50, undefined))).toBe('██████░░░░░░')
    expect(contextTriggerPercent(summary())).toBeUndefined()
    expect(contextTriggerPercent(summary({ enabled: false, triggerTokens: 270_000, candidates: [] }))).toBeUndefined()
    // A trigger without a window cannot be placed on the bar.
    expect(contextTriggerPercent({
      ...summary({ enabled: true, triggerTokens: 270_000, candidates: [] }),
      contextUsage: { tokens: 0, contextWindow: 0, percent: 0 },
    })).toBeUndefined()
  })

  it('keeps a 100% marker inside the last cell', () => {
    const cells = contextBarCells(100, 100)
    expect(cells).toHaveLength(CONTEXT_BAR_CELLS)
    expect(cells[CONTEXT_BAR_CELLS - 1]).toEqual({ char: '│', threshold: true })
  })

  it('treats an unknown usage percentage as an empty bar', () => {
    // pi reports `null` right after a compaction; that must not render as 0%.
    expect(bar(contextBarCells(undefined, 25.75))).toBe('░░░│░░░░░░░░')
    expect(clampPercent(null)).toBeUndefined()
    expect(clampPercent(Number.NaN)).toBeUndefined()
    expect(clampPercent(140)).toBe(100)
  })
})