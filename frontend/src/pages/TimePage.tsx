import { useEffect, useMemo, useState } from 'react'
import type {
  TimingDailyPoint,
  TimingModelSummary,
  TimingRange,
  TimingReport,
  TimingSessionSummary,
  TimingToolSummary,
  TimingTotals,
} from '@shared/timing'
import { displayWorktreePath } from '../utils/displayPath'

function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '0s'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  const seconds = ms / 1_000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = seconds / 60
  if (minutes < 60) return `${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)}m`
  const hours = minutes / 60
  if (hours < 10) return `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m`
  return `${Math.round(hours)}h`
}

function formatMs(ms: number): string {
  if (!ms) return '—'
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(Math.round(value))
}

function formatRate(value: number): string {
  return value > 0 ? `${value.toFixed(1)} tok/s` : '—'
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—'
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

type SegmentSpec = {
  label: string
  color: string
  value: (point: TimingDailyPoint) => number
}

function CompositionChart({ points, segments }: { points: TimingDailyPoint[]; segments: SegmentSpec[] }) {
  const [hoveredIndex, setHoveredIndex] = useState<number>()
  const width = 900
  const height = 280
  const left = 58
  const right = 18
  const top = 18
  const bottom = 30
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const totals = points.map(point => segments.reduce((sum, spec) => sum + spec.value(point), 0))
  const maxTotal = Math.max(...totals, 0)
  const scale = maxTotal > 0 ? maxTotal : 1
  const slot = points.length > 0 ? plotWidth / points.length : plotWidth
  const barWidth = Math.max(2, Math.min(28, slot * 0.6))
  const labels = [0, Math.ceil(maxTotal / 2), maxTotal].map((value, index) => ({
    value,
    y: top + plotHeight - (index / 2) * plotHeight,
  }))
  const hovered = hoveredIndex === undefined ? undefined : { point: points[hoveredIndex], total: totals[hoveredIndex] }

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted">
        {segments.map(spec => (
          <span key={spec.label} className="inline-flex items-center gap-1.5"><b className="h-2 w-2 rounded-sm" style={{ background: spec.color }} />{spec.label}</span>
        ))}
      </div>
      <div className="relative overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} className="min-w-[680px] w-full h-[280px]" role="img" aria-label="每日 Agent 时间构成">
          {labels.map((label, index) => (
            <g key={index}>
              <line x1={left} x2={width - right} y1={label.y} y2={label.y} stroke="var(--border)" strokeDasharray="3 5" />
              <text x={left - 8} y={label.y + 4} textAnchor="end" fontSize="10" fill="var(--muted)">{formatDuration(label.value)}</text>
            </g>
          ))}
          {points.map((point, index) => {
            const x = left + index * slot + (slot - barWidth) / 2
            const total = totals[index]
            let cursor = top + plotHeight
            return (
              <g key={point.date}>
                <rect x={left + index * slot} y={top} width={slot} height={plotHeight} fill="transparent" onMouseEnter={() => setHoveredIndex(index)} className="cursor-pointer" />
                {total > 0 && segments.map(spec => {
                  const value = spec.value(point)
                  if (value <= 0) return null
                  const barHeight = (value / scale) * plotHeight
                  cursor -= barHeight
                  return <rect key={spec.label} x={x} y={cursor} width={barWidth} height={barHeight} fill={spec.color} opacity={hoveredIndex === undefined || hoveredIndex === index ? 1 : 0.45} />
                })}
                {(index === 0 || index === points.length - 1 || (index + 1) % 5 === 0) && (
                  <text x={left + index * slot + slot / 2} y={height - 10} textAnchor="middle" fontSize="10" fill="var(--muted)">{point.date.slice(8)}</text>
                )}
              </g>
            )
          })}
        </svg>
        {hovered && (
          <div className="pointer-events-none absolute right-3 top-3 z-10 min-w-[230px] rounded-md border border-border bg-card px-3 py-2 shadow-lg backdrop-blur-sm">
            <div className="text-xs font-medium text-text-strong">{hovered.point.date}</div>
            <div className="mt-1 text-2xs text-muted">合计 {formatDuration(hovered.total)}</div>
            <div className="mt-2 space-y-1 border-t border-border pt-1.5 text-2xs">
              {segments.map(spec => (
                <div key={spec.label} className="flex justify-between gap-4">
                  <span className="text-muted">{spec.label}</span>
                  <span style={{ color: spec.color }}>{formatDuration(spec.value(hovered.point))}</span>
                </div>
              ))}
              <div className="flex justify-between gap-4"><span className="text-muted">模型调用 / 工具调用</span><span className="text-text">{hovered.point.modelCalls} / {hovered.point.toolCalls}</span></div>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

function TtftChart({ points }: { points: TimingDailyPoint[] }) {
  const [hoveredIndex, setHoveredIndex] = useState<number>()
  const width = 900
  const height = 220
  const left = 58
  const right = 18
  const top = 18
  const bottom = 30
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const slot = points.length > 0 ? plotWidth / points.length : plotWidth
  const averages = points.map(point => (point.ttftCalls > 0 ? point.ttftMs / point.ttftCalls : undefined))
  const maxAverage = Math.max(...averages.map(value => value ?? 0), 0)
  const scale = maxAverage > 0 ? maxAverage : 1
  const chartPoints = points
    .map((point, index) => ({ point, index, average: averages[index] }))
    .filter(item => item.average !== undefined)
    .map(item => ({
      ...item,
      x: left + item.index * slot + slot / 2,
      y: top + plotHeight - ((item.average as number) / scale) * plotHeight,
    }))
  const line = chartPoints.map(item => `${item.x.toFixed(1)},${item.y.toFixed(1)}`).join(' ')
  const labels = [0, Math.ceil(maxAverage / 2), maxAverage].map((value, index) => ({
    value,
    y: top + plotHeight - (index / 2) * plotHeight,
  }))
  const hovered = hoveredIndex === undefined ? undefined : chartPoints.find(item => item.index === hoveredIndex)

  return (
    <div className="relative overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="min-w-[680px] w-full h-[220px]" role="img" aria-label="每日平均首 token 时间" onMouseLeave={() => setHoveredIndex(undefined)}>
        {labels.map((label, index) => (
          <g key={index}>
            <line x1={left} x2={width - right} y1={label.y} y2={label.y} stroke="var(--border)" strokeDasharray="3 5" />
            <text x={left - 8} y={label.y + 4} textAnchor="end" fontSize="10" fill="var(--info)">{formatMs(label.value)}</text>
          </g>
        ))}
        {hovered && <line x1={hovered.x} x2={hovered.x} y1={top} y2={top + plotHeight} stroke="var(--border-strong)" strokeOpacity=".8" strokeDasharray="3 3" />}
        {chartPoints.length > 1 && <polyline points={line} fill="none" stroke="var(--info)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
        {points.map((point, index) => (
          <g key={point.date}>
            <rect x={left + index * slot} y={top} width={slot} height={plotHeight} fill="transparent" onMouseEnter={() => setHoveredIndex(index)} className="cursor-pointer" />
            {(index === 0 || index === points.length - 1 || (index + 1) % 5 === 0) && (
              <text x={left + index * slot + slot / 2} y={height - 9} textAnchor="middle" fontSize="10" fill="var(--muted)">{point.date.slice(8)}</text>
            )}
          </g>
        ))}
        {chartPoints.map(item => (
          <circle key={item.point.date} cx={item.x} cy={item.y} r={hoveredIndex === item.index ? '4.5' : '3'} fill="var(--info)" />
        ))}
      </svg>
      {hovered && (
        <div className="pointer-events-none absolute right-3 top-3 z-10 min-w-[230px] rounded-md border border-border bg-card px-3 py-2 shadow-lg backdrop-blur-sm">
          <div className="text-xs font-medium text-text-strong">{hovered.point.date}</div>
          <div className="mt-1 text-2xs text-info">平均首 token：{formatMs(hovered.average as number)}</div>
          <div className="mt-2 space-y-1 border-t border-border pt-1.5 text-2xs text-muted">
            <div className="flex justify-between gap-4"><span>覆盖调用</span><span className="text-text">{hovered.point.ttftCalls} / {hovered.point.modelCalls}</span></div>
            <div className="flex justify-between gap-4"><span>平均 decode</span><span className="text-text">{formatRate(hovered.point.decodeMs > 0 ? hovered.point.outputTokens / (hovered.point.decodeMs / 1000) : 0)}</span></div>
          </div>
        </div>
      )}
    </div>
  )
}

function ModelTable({ items }: { items: TimingModelSummary[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-2xs text-muted uppercase"><tr>
          <th className="py-2 pr-3">模型</th>
          <th className="py-2 pr-3">调用</th>
          <th className="py-2 pr-3">首 token 平均 / P50 / P90</th>
          <th className="py-2 pr-3">Decode 速度</th>
          <th className="py-2 pr-3">Thinking 平均 / 占比</th>
          <th className="py-2 pr-3">请求总时长</th>
          <th className="py-2">输出 token</th>
        </tr></thead>
        <tbody>{items.length === 0 ? <tr><td colSpan={7} className="py-5 text-center text-muted">该时段暂无计时记录</td></tr> : items.map(item => (
          <tr key={item.key} className="border-t border-border">
            <td className="py-2 pr-3 font-mono whitespace-normal break-all text-text" title={item.key}>{item.key}{item.errors > 0 && <span className="ml-2 text-danger">{item.errors} 错误</span>}</td>
            <td className="py-2 pr-3 text-text">{formatCount(item.calls)}</td>
            <td className="py-2 pr-3 text-text">{item.ttftCalls > 0 ? `${formatMs(item.ttftAvgMs)} / ${formatMs(item.ttftP50Ms)} / ${formatMs(item.ttftP90Ms)}` : <span className="text-muted">未记录</span>}</td>
            <td className="py-2 pr-3 text-text">{formatRate(item.decodeTokensPerSec)}</td>
            <td className="py-2 pr-3 text-text">{item.thinkingCalls > 0 ? `${formatDuration(item.thinkingAvgMs)} / ${Math.round(item.thinkingShare * 100)}%` : <span className="text-muted">未记录</span>}</td>
            <td className="py-2 pr-3 text-text">{formatDuration(item.totalMs)}</td>
            <td className="py-2 text-muted">{formatCount(item.outputTokens)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

function ToolTable({ items }: { items: TimingToolSummary[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-2xs text-muted uppercase"><tr>
          <th className="py-2 pr-3">工具</th>
          <th className="py-2 pr-3">次数</th>
          <th className="py-2 pr-3">累计时长</th>
          <th className="py-2 pr-3">平均</th>
          <th className="py-2 pr-3">P50</th>
          <th className="py-2 pr-3">P90</th>
          <th className="py-2">最长</th>
        </tr></thead>
        <tbody>{items.length === 0 ? <tr><td colSpan={7} className="py-5 text-center text-muted">该时段暂无工具记录</td></tr> : items.map(item => (
          <tr key={item.name} className="border-t border-border">
            <td className="py-2 pr-3 font-mono text-text" title={item.name}>{item.name}{item.errors > 0 && <span className="ml-2 text-danger">{item.errors} 错误</span>}</td>
            <td className="py-2 pr-3 text-text">{formatCount(item.calls)}</td>
            <td className="py-2 pr-3 text-text-strong">{formatDuration(item.totalMs)}</td>
            <td className="py-2 pr-3 text-text">{formatMs(item.avgMs)}</td>
            <td className="py-2 pr-3 text-text">{formatMs(item.p50Ms)}</td>
            <td className="py-2 pr-3 text-text">{formatMs(item.p90Ms)}</td>
            <td className="py-2 text-muted">{formatMs(item.maxMs)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

function SessionTable({ items }: { items: TimingSessionSummary[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-2xs text-muted uppercase"><tr>
          <th className="py-2 pr-3">Session</th>
          <th className="py-2 pr-3">Runs</th>
          <th className="py-2 pr-3">活跃时长</th>
          <th className="py-2 pr-3">模型时间</th>
          <th className="py-2">工具时间</th>
        </tr></thead>
        <tbody>{items.length === 0 ? <tr><td colSpan={5} className="py-5 text-center text-muted">该时段暂无 run 记录</td></tr> : items.slice(0, 20).map(item => (
          <tr key={item.key} className="border-t border-border">
            <td className="py-2 pr-3"><div className="whitespace-normal break-words text-text" title={item.label}>{displayWorktreePath(item.label)}</div><div className="text-2xs text-muted font-mono whitespace-normal break-all" title={item.key}>{item.key}</div></td>
            <td className="py-2 pr-3 text-text">{item.runs}</td>
            <td className="py-2 pr-3 text-text-strong">{formatDuration(item.activeMs)}</td>
            <td className="py-2 pr-3 text-text">{formatDuration(item.modelMs)}</td>
            <td className="py-2 text-text">{formatDuration(item.toolMs)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

function topTool(tools: TimingToolSummary[]): TimingToolSummary | undefined {
  return tools.length > 0 ? tools[0] : undefined
}

export default function TimePage() {
  const [range, setRange] = useState<TimingRange>('month')
  const [month, setMonth] = useState(currentMonth)
  const [report, setReport] = useState<TimingReport>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(undefined)
    const query = range === 'month' ? `range=month&month=${encodeURIComponent(month)}` : `range=${range}`
    fetch(`/api/timing?${query}`, { credentials: 'same-origin' })
      .then(async response => {
        const body = await response.json().catch(() => ({})) as Record<string, unknown>
        if (!response.ok) throw new Error(typeof body.message === 'string' ? body.message : `HTTP ${response.status}`)
        return body as unknown as TimingReport
      })
      .then(value => { if (!cancelled) setReport(value) })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [range, month])

  const total: TimingTotals | undefined = report?.total
  const decodeRate = useMemo(() => {
    if (!total || total.decodeMs <= 0) return 0
    return total.outputTokens / (total.decodeMs / 1000)
  }, [total])

  const segments: SegmentSpec[] = [
    { label: '模型请求（含 thinking / 输出）', color: 'var(--accent)', value: point => point.modelMs },
    { label: '工具执行', color: 'var(--info)', value: point => point.toolMs },
    { label: '框架与调度开销', color: 'var(--warn)', value: point => point.overheadMs },
  ]

  const slowestTool = topTool(report?.tools ?? [])

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-6 bg-bg">
      <div className="max-w-6xl mx-auto space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-text-strong">Agent 时间分析</h1>
            <p className="text-xs text-muted mt-1">模型首 token / decode 速度、thinking、工具执行与 Agent 墙钟时间的统一计时统计</p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <div className="inline-flex overflow-hidden rounded-md border border-border">
              {(['month', '7d', '30d'] as TimingRange[]).map(value => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setRange(value)}
                  className={`px-3 py-1.5 ${range === value ? 'bg-accent text-accent-fg' : 'bg-card text-text hover:bg-card-hl'}`}
                >{value === 'month' ? '按月' : value === '7d' ? '近 7 天' : '近 30 天'}</button>
              ))}
            </div>
            {range === 'month' && (
              <label className="text-muted flex items-center gap-2">月份<input type="month" value={month} onChange={event => setMonth(event.target.value)} className="rounded-md border border-border bg-card px-2 py-1.5 text-text" /></label>
            )}
          </div>
        </header>

        {error && <div className="rounded-md border border-danger bg-danger-subtle px-3 py-2 text-xs text-danger">计时统计读取失败：{error}</div>}
        {loading && !report && <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted">读取计时统计中…</div>}

        {report && total && <>
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
            <SummaryCard label="Agent 活跃时长" value={formatDuration(total.activeMs)} hint={`根进程 ${formatCount(total.runs)} 次 run`} />
            <SummaryCard label="模型请求时间" value={formatDuration(total.modelMs)} hint={`占活跃 ${percent(total.modelMs, total.activeMs)} · ${formatCount(total.modelCalls)} 次调用`} />
            <SummaryCard label="工具执行时间" value={formatDuration(total.toolMs)} hint={`占活跃 ${percent(total.toolMs, total.activeMs)} · ${formatCount(total.toolCalls)} 次调用`} />
            <SummaryCard label="框架与调度开销" value={formatDuration(total.overheadMs)} hint={`占活跃 ${percent(total.overheadMs, total.activeMs)}`} />
            <SummaryCard label="平均首 token" value={total.ttftCalls > 0 ? formatMs(total.ttftMs / total.ttftCalls) : '—'} hint={`覆盖 ${formatCount(total.ttftCalls)} / ${formatCount(total.modelCalls)} 次调用`} />
            <SummaryCard label="平均 decode 速度" value={formatRate(decodeRate)} hint={`thinking 占模型时间 ${percent(total.thinkingMs, total.modelMs)}`} />
          </div>

          <section className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-2">
              <div><h2 className="text-sm font-medium text-text-strong">每日时间构成</h2><p className="text-2xs text-muted mt-1">根进程 run 墙钟，按模型 / 工具 / 框架开销拆分 · {report.timezone}</p></div>
              <span className="text-2xs text-muted">{report.from ? new Date(report.from).toISOString().slice(0, 10) : ''} ~ {report.to ? new Date(report.to).toISOString().slice(0, 10) : ''}</span>
            </div>
            <CompositionChart points={report.daily} segments={segments} />
          </section>

          <section className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-2">
              <div><h2 className="text-sm font-medium text-text-strong">每日平均首 token</h2><p className="text-2xs text-muted mt-1">按当天有计时的模型调用求平均；空缺表示该日没有记录</p></div>
              <span className="text-2xs text-info">TTFT</span>
            </div>
            <TtftChart points={report.daily} />
          </section>

          <section className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-2">
              <div><h2 className="text-sm font-medium text-text-strong">按模型</h2><p className="text-2xs text-muted mt-1">含子代理进程的模型调用；P90 偏高说明该模型偶发长尾</p></div>
              <span className="text-2xs text-muted">首 token / decode / thinking</span>
            </div>
            <ModelTable items={report.models} />
          </section>

          <div className="grid xl:grid-cols-2 gap-4">
            <section className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between mb-2">
                <div><h2 className="text-sm font-medium text-text-strong">按工具</h2><p className="text-2xs text-muted mt-1">含子代理进程的工具调用</p></div>
                {slowestTool && <span className="text-2xs text-muted">最耗时：{slowestTool.name}</span>}
              </div>
              <ToolTable items={report.tools} />
            </section>
            <section className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between mb-2"><div><h2 className="text-sm font-medium text-text-strong">按 Session</h2><p className="text-2xs text-muted mt-1">按根进程活跃时长排序，最多 20 行</p></div></div>
              <SessionTable items={report.sessions} />
            </section>
          </div>

          <p className="text-2xs text-muted leading-5">
            数据来自 Pi <code>trajectory-recorder</code> 扩展写入的紧凑计时账本（<code>/mnt/workspace/lilong/agent/pi/timing</code>），不包含提示词与工具输出。
            墙钟与「模型 / 工具」占比只统计根进程 run；模型与工具明细表包含子代理进程，因此明细总和可能大于根进程墙钟。
            嵌套子代理会让父进程的工具耗时与子进程记录重叠，占比用于横向比较而非精确守恒。
            区间内 {formatCount(report.recordCount)} 条计时记录，其中首 token 覆盖 {formatCount(report.coverage.withTtft)} 次、thinking 覆盖 {formatCount(report.coverage.withThinking)} 次模型调用。
          </p>
        </>}
      </div>
    </div>
  )
}