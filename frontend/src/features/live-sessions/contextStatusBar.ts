import type { LiveSessionSummary } from '@shared/live-sessions'

/** Cells in the status-line context bar (matches the TUI bar's width). */
export const CONTEXT_BAR_CELLS = 12

export interface ContextBarCell {
  char: string
  /** This cell is the auto-compaction marker, not usage. */
  threshold: boolean
}

/**
 * Where this session will compact, as a 0-100 share of the context window.
 *
 * The trigger comes from the bridge (`summary.compact`), which resolves it from
 * the same policy that actually compacts. The bar must not invent a line of its
 * own: unknown (older bridge, compaction disabled) means "no marker" rather than
 * a decorative one, which is how the old hard-coded end cap misled the reader.
 */
export function contextTriggerPercent(summary: LiveSessionSummary): number | undefined {
  const compact = summary.compact
  const contextWindow = summary.contextUsage?.contextWindow
  if (!compact?.enabled || !(compact.triggerTokens > 0)) return undefined
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined
  return Math.max(0, Math.min(100, (compact.triggerTokens / contextWindow) * 100))
}

/** Clamp a raw percentage into the 0-100 the bar is drawn in. */
export function clampPercent(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(100, value))
}

/**
 * Build the bar cell by cell: usage cells, empty cells, and the compaction
 * marker.
 *
 * The threshold OWNS one cell and is clamped inside the bar, so 270K on a 1M
 * window shows at cell 3 instead of at the right edge. A marker at 100% shares
 * the last cell with usage rather than falling off the end.
 */
export function contextBarCells(
  usagePercent: number | undefined,
  triggerPercent: number | undefined,
  cells = CONTEXT_BAR_CELLS,
): ContextBarCell[] {
  const filled = usagePercent === undefined ? 0 : Math.round((usagePercent / 100) * cells)
  const thresholdCell = triggerPercent === undefined
    ? -1
    : Math.min(cells - 1, Math.round((triggerPercent / 100) * cells))
  return Array.from({ length: cells }, (_, index) => {
    if (index === thresholdCell) return { char: '│', threshold: true }
    return { char: index < filled ? '█' : '░', threshold: false }
  })
}