import { useEffect, useMemo, useState } from 'react'
import type { UsageDailyPoint, UsageModelSummary, UsageReport, UsageSessionSummary, UsageTotals } from '@shared/usage'
import { displayWorktreePath } from '../utils/displayPath'

function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function currentDay(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function formatCost(value: number): string {
  if (value === 0) return '$0.00'
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(Math.round(value))
}

function formatUnitCost(value: number): string {
  if (!value) return '—'
  return `${value < 0.01 ? value.toFixed(4) : value.toFixed(2)} USD/MTok`
}

function SummaryCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-2xs text-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold text-text-strong">{value}</div>
      {hint && <div className="mt-1 text-2xs text-muted">{hint}</div>}
    </div>
  )
}

function CostChart({ points }: { points: UsageDailyPoint[] }) {
  const [hoveredIndex, setHoveredIndex] = useState<number>()
  const width = 900
  const height = 290
  const left = 58
  const right = 58
  const top = 18
  const bottom = 34
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const maxCost = Math.max(...points.map(point => point.costUsd), 0)
  const maxTokens = Math.max(...points.flatMap(point => [point.inputTokens, point.outputTokens]), 0)
  const costScale = maxCost > 0 ? maxCost : 1
  const tokenScale = maxTokens > 0 ? maxTokens : 1
  const chartPoints = points.map((point, index) => {
    const x = left + (points.length <= 1 ? 0 : (index / (points.length - 1)) * plotWidth)
    return {
      ...point,
      x,
      costY: top + plotHeight - (point.costUsd / costScale) * plotHeight,
      inputY: top + plotHeight - (point.inputTokens / tokenScale) * plotHeight,
      outputY: top + plotHeight - (point.outputTokens / tokenScale) * plotHeight,
    }
  })
  const costLine = chartPoints.map(point => `${point.x.toFixed(1)},${point.costY.toFixed(1)}`).join(' ')
  const inputLine = chartPoints.map(point => `${point.x.toFixed(1)},${point.inputY.toFixed(1)}`).join(' ')
  const outputLine = chartPoints.map(point => `${point.x.toFixed(1)},${point.outputY.toFixed(1)}`).join(' ')
  const costLabels = [0, Math.ceil(maxCost / 2), maxCost].map((value, index) => ({
    value,
    y: top + plotHeight - (index / 2) * plotHeight,
  }))
  const tokenLabels = [0, Math.ceil(maxTokens / 2), maxTokens].map((value, index) => ({
    value,
    y: top + plotHeight - (index / 2) * plotHeight,
  }))
  const hoveredPoint = hoveredIndex === undefined ? undefined : chartPoints[hoveredIndex]
  const hitWidth = points.length > 0 ? plotWidth / points.length : plotWidth

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted">
        <span className="inline-flex items-center gap-1.5"><i className="h-0.5 w-4 bg-accent" /><b className="h-2 w-2 rounded-full bg-accent" />费用（左轴 USD，实线圆点）</span>
        <span className="inline-flex items-center gap-1.5"><i className="w-4 border-t-2 border-dashed border-info" /><b className="h-2 w-2 bg-info" />输入 token（右轴，虚线方点）</span>
        <span className="inline-flex items-center gap-1.5"><i className="w-4 border-t-2 border-dotted border-ok" /><b className="h-0 w-0 border-x-[4px] border-b-[6px] border-x-transparent border-b-ok" />输出 token（右轴，点线三角）</span>
      </div>
      <div className="relative overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="min-w-[680px] w-full h-[290px]"
          role="img"
          aria-label="每日费用、输入 token 和输出 token 曲线"
          onMouseLeave={() => setHoveredIndex(undefined)}
        >
          {costLabels.map((label, index) => (
            <g key={`cost-${index}`}>
              <line x1={left} x2={width - right} y1={label.y} y2={label.y} stroke="var(--border)" strokeDasharray="3 5" />
              <text x={left - 8} y={label.y + 4} textAnchor="end" fontSize="10" fill="var(--accent)">{formatCost(label.value)}</text>
            </g>
          ))}
          {tokenLabels.map((label, index) => (
            <text key={`token-${index}`} x={width - right + 8} y={label.y + 4} textAnchor="start" fontSize="10" fill="var(--info)">{formatTokens(label.value)}</text>
          ))}
          {hoveredPoint && <line x1={hoveredPoint.x} x2={hoveredPoint.x} y1={top} y2={top + plotHeight} stroke="var(--border-strong)" strokeOpacity=".8" strokeDasharray="3 3" />}
          {chartPoints.length > 1 && <>
            <polyline points={costLine} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
            <polyline points={inputLine} fill="none" stroke="var(--info)" strokeWidth="2" strokeDasharray="7 4" strokeLinejoin="round" strokeLinecap="round" />
            <polyline points={outputLine} fill="none" stroke="var(--ok)" strokeWidth="2" strokeDasharray="2 4" strokeLinejoin="round" strokeLinecap="round" />
          </>}
          {chartPoints.map((point, index) => (
            <g key={point.date}>
              <rect x={Math.max(left, point.x - hitWidth / 2)} y={top} width={hitWidth} height={plotHeight} fill="transparent" onMouseEnter={() => setHoveredIndex(index)} className="cursor-pointer" />
              <circle cx={point.x} cy={point.costY} r={hoveredIndex === index ? "4.5" : "3"} fill="var(--accent)" />
              <rect x={point.x - (hoveredIndex === index ? 4 : 2.5)} y={point.inputY - (hoveredIndex === index ? 4 : 2.5)} width={hoveredIndex === index ? "8" : "5"} height={hoveredIndex === index ? "8" : "5"} fill="var(--info)" />
              <polygon points={`${point.x},${point.outputY - (hoveredIndex === index ? 5 : 3)} ${point.x - (hoveredIndex === index ? 5 : 3)},${point.outputY + (hoveredIndex === index ? 4 : 2)} ${point.x + (hoveredIndex === index ? 5 : 3)},${point.outputY + (hoveredIndex === index ? 4 : 2)}`} fill="var(--ok)" />
              {(index === 0 || index === chartPoints.length - 1 || (index + 1) % 5 === 0) && (
                <text x={point.x} y={height - 10} textAnchor="middle" fontSize="10" fill="var(--muted)">{point.date.slice(8)}</text>
              )}
            </g>
          ))}
        </svg>
        {hoveredPoint && (
          <div className="pointer-events-none absolute right-3 top-3 z-10 min-w-[250px] max-w-[340px] rounded-md border border-border bg-card/95 px-3 py-2 shadow-lg backdrop-blur-sm">
            <div className="text-xs font-medium text-text-strong">{hoveredPoint.date}</div>
            <div className="mt-1 grid grid-cols-3 gap-2 text-2xs">
              <div><div className="text-muted">费用</div><div className="text-accent">{formatCost(hoveredPoint.costUsd)}</div></div>
              <div><div className="text-muted">输入</div><div className="text-info">{formatTokens(hoveredPoint.inputTokens)}</div></div>
              <div><div className="text-muted">输出</div><div className="text-ok">{formatTokens(hoveredPoint.outputTokens)}</div></div>
            </div>
            <div className="mt-2 space-y-1 border-t border-border/60 pt-1.5">
              {hoveredPoint.models.length === 0 ? <div className="text-2xs text-muted">当天没有模型费用</div> : hoveredPoint.models.map(model => (
                <div key={model.key} className="flex items-start justify-between gap-3 text-2xs">
                  <span className="min-w-0 flex-1 whitespace-normal break-all text-muted" title={model.key}>{model.key}</span>
                  <span className="shrink-0 text-right text-text">{formatCost(model.costUsd)} · {formatTokens(model.totalTokens)}<br />{formatUnitCost(model.effectiveUsdPerMillionTokens)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  )
}

function cacheHitPercent(point: UsageTotals): number {
  const totalInput = point.inputTokens + point.cacheReadTokens + point.cacheWriteTokens
  return totalInput > 0 ? (point.cacheReadTokens / totalInput) * 100 : 0
}

type CostSeriesSpec = {
  label: string
  color: string
  dash?: string
  marker: 'circle' | 'square' | 'triangle'
  value: (point: UsageDailyPoint) => number
}

function DualCostChart({ points, series }: { points: UsageDailyPoint[]; series: [CostSeriesSpec, CostSeriesSpec] }) {
  const [hoveredIndex, setHoveredIndex] = useState<number>()
  const width = 900
  const height = 240
  const left = 58
  const right = 18
  const top = 18
  const bottom = 30
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const maxSeries = Math.max(...points.flatMap(point => series.map(spec => spec.value(point))), 0)
  const scale = maxSeries > 0 ? maxSeries : 1
  const chartPoints = points.map((point, index) => {
    const x = left + (points.length <= 1 ? 0 : (index / (points.length - 1)) * plotWidth)
    return {
      ...point,
      x,
      ys: series.map(spec => top + plotHeight - (spec.value(point) / scale) * plotHeight),
    }
  })
  const labels = [0, Math.ceil(maxSeries / 2), maxSeries].map((value, index) => ({ value, y: top + plotHeight - (index / 2) * plotHeight }))
  const hoveredPoint = hoveredIndex === undefined ? undefined : chartPoints[hoveredIndex]
  const hitWidth = points.length > 0 ? plotWidth / points.length : plotWidth

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted">
        {series.map(spec => (
          <span key={spec.label} className="inline-flex items-center gap-1.5">
            {spec.marker === 'circle' && <b className="h-2 w-2 rounded-full" style={{ background: spec.color }} />}
            {spec.marker === 'square' && <b className="h-2 w-2" style={{ background: spec.color }} />}
            {spec.marker === 'triangle' && <b className="h-0 w-0 border-x-[4px] border-b-[6px] border-x-transparent" style={{ borderBottomColor: spec.color }} />}
            {spec.label}
          </span>
        ))}
      </div>
      <div className="relative overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} className="min-w-[680px] w-full h-[240px]" role="img" onMouseLeave={() => setHoveredIndex(undefined)}>
          {labels.map((label, index) => (
            <g key={index}>
              <line x1={left} x2={width - right} y1={label.y} y2={label.y} stroke="var(--border)" strokeDasharray="3 5" />
              <text x={left - 8} y={label.y + 4} textAnchor="end" fontSize="10" fill="var(--muted)">{formatCost(label.value)}</text>
            </g>
          ))}
          {hoveredPoint && <line x1={hoveredPoint.x} x2={hoveredPoint.x} y1={top} y2={top + plotHeight} stroke="var(--border-strong)" strokeOpacity=".8" strokeDasharray="3 3" />}
          {series.map((spec, seriesIndex) => {
            const line = chartPoints.map(point => `${point.x.toFixed(1)},${point.ys[seriesIndex].toFixed(1)}`).join(' ')
            return chartPoints.length > 1 ? <polyline key={spec.label} points={line} fill="none" stroke={spec.color} strokeWidth="2" strokeDasharray={spec.dash} strokeLinejoin="round" strokeLinecap="round" /> : null
          })}
          {chartPoints.map((point, index) => (
            <g key={point.date}>
              <rect x={Math.max(left, point.x - hitWidth / 2)} y={top} width={hitWidth} height={plotHeight} fill="transparent" onMouseEnter={() => setHoveredIndex(index)} className="cursor-pointer" />
              {series.map((spec, seriesIndex) => {
                const y = point.ys[seriesIndex]
                const big = hoveredIndex === index
                if (spec.marker === 'circle') return <circle key={spec.label} cx={point.x} cy={y} r={big ? "4.5" : "3"} fill={spec.color} />
                if (spec.marker === 'square') return <rect key={spec.label} x={point.x - (big ? 4 : 2.5)} y={y - (big ? 4 : 2.5)} width={big ? "8" : "5"} height={big ? "8" : "5"} fill={spec.color} />
                return <polygon key={spec.label} points={`${point.x},${y - (big ? 5 : 3)} ${point.x - (big ? 5 : 3)},${y + (big ? 4 : 2)} ${point.x + (big ? 5 : 3)},${y + (big ? 4 : 2)}`} fill={spec.color} />
              })}
              {(index === 0 || index === chartPoints.length - 1 || (index + 1) % 5 === 0) && (
                <text x={point.x} y={height - 9} textAnchor="middle" fontSize="10" fill="var(--muted)">{point.date.slice(8)}</text>
              )}
            </g>
          ))}
        </svg>
        {hoveredPoint && (
          <div className="pointer-events-none absolute right-3 top-3 z-10 min-w-[210px] rounded-md border border-border bg-card/95 px-3 py-2 shadow-lg backdrop-blur-sm">
            <div className="text-xs font-medium text-text-strong">{hoveredPoint.date}</div>
            <div className="mt-1 space-y-1 text-2xs">
              {series.map(spec => (
                <div key={spec.label} className="flex justify-between gap-4"><span className="text-muted">{spec.label}</span><span className="text-text" style={{ color: spec.color }}>{formatCost(spec.value(hoveredPoint))}</span></div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function CacheRatioChart({ points }: { points: UsageDailyPoint[] }) {
  const [hoveredIndex, setHoveredIndex] = useState<number>()
  const [selectedDate, setSelectedDate] = useState<string>()
  const width = 900
  const height = 230
  const left = 52
  const right = 18
  const top = 18
  const bottom = 30
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const chartPoints = points.map((point, index) => {
    const ratio = cacheHitPercent(point)
    const x = left + (points.length <= 1 ? 0 : (index / (points.length - 1)) * plotWidth)
    const y = top + plotHeight - (ratio / 100) * plotHeight
    return { ...point, ratio, x, y }
  })
  const line = chartPoints.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')
  const hoveredPoint = hoveredIndex === undefined ? undefined : chartPoints[hoveredIndex]
  const selectedPoint = selectedDate === undefined ? undefined : chartPoints.find(point => point.date === selectedDate)
  // Hover drives the marker/guide line; a click pins the per-model panel below.
  const markerPoint = hoveredPoint ?? selectedPoint
  const hitWidth = points.length > 0 ? plotWidth / points.length : plotWidth
  const modelRows = selectedPoint
    ? selectedPoint.models
        .map(model => ({
          model,
          ratio: cacheHitPercent(model),
          inputTotal: model.inputTokens + model.cacheReadTokens + model.cacheWriteTokens,
        }))
        .sort((left, right) => right.inputTotal - left.inputTotal)
    : []

  return (
    <div>
      <div className="relative overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="min-w-[680px] w-full h-[230px]"
          role="img"
          aria-label="每日 Cache 命中率曲线，点击数据点查看当天各模型命中率"
          onMouseLeave={() => setHoveredIndex(undefined)}
        >
          {[0, 25, 50, 75, 100].map(value => {
            const y = top + plotHeight - (value / 100) * plotHeight
            return (
              <g key={value}>
                <line x1={left} x2={width - right} y1={y} y2={y} stroke="var(--border)" strokeDasharray="3 5" />
                <text x={left - 8} y={y + 4} textAnchor="end" fontSize="10" fill="var(--muted)">{value}%</text>
              </g>
            )
          })}
          {markerPoint && <line x1={markerPoint.x} x2={markerPoint.x} y1={top} y2={top + plotHeight} stroke="var(--border-strong)" strokeOpacity=".8" strokeDasharray="3 3" />}
          {chartPoints.length > 1 && <polyline points={line} fill="none" stroke="var(--info)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
          {chartPoints.map((point, index) => {
            const active = markerPoint?.date === point.date
            return (
              <g key={point.date}>
                <rect
                  x={Math.max(left, point.x - hitWidth / 2)}
                  y={top}
                  width={hitWidth}
                  height={plotHeight}
                  fill="transparent"
                  onMouseEnter={() => setHoveredIndex(index)}
                  onClick={() => setSelectedDate(current => (current === point.date ? undefined : point.date))}
                  className="cursor-pointer"
                />
                <circle cx={point.x} cy={point.y} r={active ? "5" : "3.5"} fill="var(--info)" pointerEvents="none" />
                {(index === 0 || index === chartPoints.length - 1 || (index + 1) % 5 === 0) && (
                  <text x={point.x} y={height - 9} textAnchor="middle" fontSize="10" fill="var(--muted)">{point.date.slice(8)}</text>
                )}
              </g>
            )
          })}
        </svg>
        {hoveredPoint && (
          <div className="pointer-events-none absolute right-3 top-3 z-10 min-w-[230px] rounded-md border border-border bg-card/95 px-3 py-2 shadow-lg backdrop-blur-sm">
            <div className="text-xs font-medium text-text-strong">{hoveredPoint.date}</div>
            <div className="mt-1 text-2xs text-info">Cache 命中率：{hoveredPoint.ratio.toFixed(1)}%</div>
            <div className="mt-2 space-y-1 border-t border-border/60 pt-1.5 text-2xs text-muted">
              <div className="flex justify-between gap-4"><span>Cache read</span><span className="text-text">{formatTokens(hoveredPoint.cacheReadTokens)}</span></div>
              <div className="flex justify-between gap-4"><span>普通输入</span><span className="text-text">{formatTokens(hoveredPoint.inputTokens)}</span></div>
              <div className="flex justify-between gap-4"><span>Cache write</span><span className="text-text">{formatTokens(hoveredPoint.cacheWriteTokens)}</span></div>
            </div>
            <div className="mt-1 text-2xs text-muted">点击固定该日各模型明细</div>
          </div>
        )}
      </div>
      {selectedPoint && (
        <div className="mt-3 rounded-md border border-border bg-bg/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-medium text-text-strong">
              {selectedPoint.date} · 各模型 Cache 命中率
              <span className="ml-2 text-2xs font-normal text-info">当天整体 {selectedPoint.ratio.toFixed(1)}%</span>
            </div>
            <button type="button" onClick={() => setSelectedDate(undefined)} className="rounded border border-border px-2 py-0.5 text-2xs text-muted hover:text-text">关闭</button>
          </div>
          {modelRows.length === 0 ? (
            <div className="mt-2 text-2xs text-muted">当天没有模型记录</div>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-2xs">
                <thead className="text-2xs uppercase text-muted">
                  <tr>
                    <th className="py-1.5 pr-3">模型</th>
                    <th className="py-1.5 pr-3">命中率</th>
                    <th className="py-1.5 pr-3">Cache read</th>
                    <th className="py-1.5 pr-3">普通输入</th>
                    <th className="py-1.5">Cache write</th>
                  </tr>
                </thead>
                <tbody>
                  {modelRows.map(row => (
                    <tr key={row.model.key} className="border-t border-border/60">
                      <td className="py-1.5 pr-3 font-mono whitespace-normal break-all text-text" title={row.model.key}>{row.model.key}</td>
                      <td className="py-1.5 pr-3 text-info">{row.inputTotal > 0 ? `${row.ratio.toFixed(1)}%` : '—'}</td>
                      <td className="py-1.5 pr-3 text-text">{formatTokens(row.model.cacheReadTokens)}</td>
                      <td className="py-1.5 pr-3 text-muted">{formatTokens(row.model.inputTokens)}</td>
                      <td className="py-1.5 text-muted">{formatTokens(row.model.cacheWriteTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-2 text-2xs text-muted">命中率 = Cache read ÷（普通输入 + Cache read + Cache write）</div>
        </div>
      )}
    </div>
  )
}

function Totals({ item }: { item: UsageTotals }) {
  return (
    <span className="text-2xs text-muted">
      {formatCost(item.costUsd)} · {formatTokens(item.totalTokens)} tokens
    </span>
  )
}

function ModelTable({ items }: { items: UsageModelSummary[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-2xs text-muted uppercase"><tr><th className="py-2 pr-3">模型</th><th className="py-2 pr-3">加权单价</th><th className="py-2 pr-3">费用</th><th className="py-2 pr-3">Token</th><th className="py-2">输入 / 输出</th></tr></thead>
        <tbody>{items.length === 0 ? <tr><td colSpan={5} className="py-5 text-center text-muted">本月暂无记录</td></tr> : items.map(item => (
          <tr key={item.key} className="border-t border-border/60"><td className="py-2 pr-3 font-mono whitespace-normal break-all text-text" title={item.key}>{item.key}</td><td className="py-2 pr-3 text-text">{formatUnitCost(item.effectiveUsdPerMillionTokens)}</td><td className="py-2 pr-3 text-text-strong">{formatCost(item.costUsd)}</td><td className="py-2 pr-3"><Totals item={item} /></td><td className="py-2 text-muted">{formatTokens(item.inputTokens)} / {formatTokens(item.outputTokens)}</td></tr>
        ))}</tbody>
      </table>
    </div>
  )
}

function SessionTable({ items }: { items: UsageSessionSummary[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-2xs text-muted uppercase"><tr><th className="py-2 pr-3">Session</th><th className="py-2 pr-3">费用</th><th className="py-2 pr-3">Token</th><th className="py-2">缓存读取</th></tr></thead>
        <tbody>{items.length === 0 ? <tr><td colSpan={4} className="py-5 text-center text-muted">本月暂无记录</td></tr> : items.map(item => (
          <tr key={item.key} className="border-t border-border/60"><td className="py-2 pr-3"><div className="whitespace-normal break-words text-text" title={item.label}>{displayWorktreePath(item.label)}</div><div className="text-2xs text-muted font-mono whitespace-normal break-all" title={item.cwd || item.sessionFile || item.key}>{displayWorktreePath(item.cwd || item.sessionFile || item.key)}</div></td><td className="py-2 pr-3 text-text-strong">{formatCost(item.costUsd)}</td><td className="py-2 pr-3"><Totals item={item} /></td><td className="py-2 text-muted">{formatTokens(item.cacheReadTokens)}</td></tr>
        ))}</tbody>
      </table>
    </div>
  )
}

export default function UsagePage() {
  const [month, setMonth] = useState(currentMonth)
  const [report, setReport] = useState<UsageReport>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(undefined)
    fetch(`/api/usage?month=${encodeURIComponent(month)}`, { credentials: 'same-origin' })
      .then(async response => {
        const body = await response.json().catch(() => ({})) as Record<string, unknown>
        if (!response.ok) throw new Error(typeof body.message === 'string' ? body.message : `HTTP ${response.status}`)
        return body as unknown as UsageReport
      })
      .then(value => { if (!cancelled) setReport(value) })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [month])

  const cacheHit = useMemo(() => {
    if (!report) return 0
    const input = report.total.inputTokens + report.total.cacheReadTokens + report.total.cacheWriteTokens
    return input > 0 ? Math.round((report.total.cacheReadTokens / input) * 100) : 0
  }, [report])

  const visibleDaily = useMemo(() => {
    if (!report) return []
    const today = currentDay()
    return report.daily.filter(point => point.date <= today)
  }, [report])

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-6 bg-bg">
      <div className="max-w-6xl mx-auto space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div><h1 className="text-lg font-semibold text-text-strong">Token Cost</h1><p className="text-xs text-muted mt-1">Terminal、Web 和 Dashboard session 的统一用量统计</p></div>
          <label className="text-xs text-muted flex items-center gap-2">月份<input type="month" value={month} onChange={event => setMonth(event.target.value)} className="rounded-md border border-border bg-card px-2 py-1.5 text-text" /></label>
        </header>
        {error && <div className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-xs text-danger">统计读取失败：{error}</div>}
        {loading && !report && <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted">读取统计中…</div>}
        {report && <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <SummaryCard label="本月费用" value={formatCost(report.total.costUsd)} hint="本地价格配置估算" />
            <SummaryCard label="本月 Token" value={formatTokens(report.total.totalTokens)} hint={`输入 ${formatTokens(report.total.inputTokens)} · 输出 ${formatTokens(report.total.outputTokens)}`} />
            <SummaryCard label="缓存命中率" value={`${cacheHit}%`} hint={`${formatTokens(report.total.cacheReadTokens)} cache read`} />
            <SummaryCard label="活跃 Session" value={String(report.sessions.length)} hint={`${report.recordCount} 条 usage 记录`} />
          </div>
          <section className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-2"><div><h2 className="text-sm font-medium text-text-strong">每日费用与 Token</h2><p className="text-2xs text-muted mt-1">{report.month} · 左轴费用 USD，右轴输入 / 输出 token · {report.timezone}</p></div><span className="text-2xs text-muted">USD 估算</span></div>
            <CostChart points={visibleDaily} />
          </section>
          <section className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-2"><div><h2 className="text-sm font-medium text-text-strong">每日 Cache 命中率</h2><p className="text-2xs text-muted mt-1">Cache read ÷（普通输入 + Cache read + Cache write）· 点击数据点查看当天各模型命中率</p></div><span className="text-2xs text-info">比例</span></div>
            <CacheRatioChart points={visibleDaily} />
          </section>
          <div className="grid xl:grid-cols-2 gap-4">
            <section className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between mb-2"><h2 className="text-sm font-medium text-text-strong">费用去向：Cache vs 非 Cache</h2></div>
              <DualCostChart
                points={visibleDaily}
                series={[
                  { label: '非 Cache 费用', color: 'var(--accent)', marker: 'circle', value: point => point.inputCostUsd + point.outputCostUsd },
                  { label: 'Cache 费用', color: 'var(--info)', marker: 'square', dash: '7 4', value: point => point.cacheReadCostUsd + point.cacheWriteCostUsd },
                ]}
              />
            </section>
            <section className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between mb-2"><h2 className="text-sm font-medium text-text-strong">费用去向：Input vs Output</h2></div>
              <DualCostChart
                points={visibleDaily}
                series={[
                  { label: 'Input 费用', color: 'var(--warn)', marker: 'triangle', value: point => point.inputCostUsd },
                  { label: 'Output 费用', color: 'var(--ok)', marker: 'square', dash: '2 4', value: point => point.outputCostUsd },
                ]}
              />
            </section>
          </div>
          <div className="grid xl:grid-cols-2 gap-4">
            <section className="rounded-lg border border-border bg-card p-4"><h2 className="text-sm font-medium text-text-strong mb-2">按模型</h2><ModelTable items={report.models} /></section>
            <section className="rounded-lg border border-border bg-card p-4"><h2 className="text-sm font-medium text-text-strong mb-2">按 Session</h2><SessionTable items={report.sessions} /></section>
          </div>
          <p className="text-2xs text-muted">费用来自 Pi session 中记录的 provider usage 和本地模型价格配置；没有 usage 或价格的调用不会被虚构为 0 元。</p>
        </>}
      </div>
    </div>
  )
}
