import type { HistoryPoint } from '@shared/tasks.js'

/**
 * Compact sparkline of daily task counts (total vs in-progress).
 * Data accumulates from the first day the backend runs; needs ≥2 points.
 */
export default function TrendPanel({ points }: { points: HistoryPoint[] }) {
  if (points.length < 2) {
    return (
      <div className="bg-card border border-border rounded-lg p-3 text-2xs text-muted">
        趋势：需要至少 2 天数据（每天自动记录一次快照，当前 {points.length} 天）
      </div>
    )
  }
  const W = 320
  const H = 64
  const PAD = 6
  const max = Math.max(...points.map(p => p.total), 1)
  const xs = (i: number) => PAD + (i * (W - 2 * PAD)) / (points.length - 1)
  const ys = (v: number) => H - PAD - (v / max) * (H - 2 * PAD)
  const path = (pick: (p: HistoryPoint) => number) =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xs(i).toFixed(1)},${ys(pick(p)).toFixed(1)}`).join(' ')

  const first = points[0]
  const last = points[points.length - 1]
  const arrow = (n: number) => (n > 0 ? `↑${n}` : n < 0 ? `↓${Math.abs(n)}` : '→0')

  return (
    <div className="bg-card border border-border rounded-lg p-3">
      <div className="flex items-center gap-3 flex-wrap mb-1.5 text-2xs">
        <span className="text-meta font-medium text-muted">趋势（近 {points.length} 天）</span>
        <span className="text-accent">● 活跃 {last.total} <span className="text-muted">{arrow(last.total - first.total)}</span></span>
        <span className="text-info">● 进行中 {last.doing} <span className="text-muted">{arrow(last.doing - first.doing)}</span></span>
        <span className="ml-auto text-muted">{first.date} → {last.date}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-16" preserveAspectRatio="none" role="img" aria-label="任务趋势">
        <path d={path(p => p.total)} fill="none" stroke="currentColor" strokeWidth={1.5} className="text-accent" />
        <path d={path(p => p.doing)} fill="none" stroke="currentColor" strokeWidth={1.5} className="text-info" />
      </svg>
    </div>
  )
}
