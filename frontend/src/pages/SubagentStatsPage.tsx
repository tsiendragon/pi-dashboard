import { useEffect, useMemo, useState } from 'react'
import type { SubagentStats, SubagentStatsDay, SubagentStatsGroup } from '@shared/subagent-stats'

const WINDOWS = [7, 30] as const

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function formatTime(at: number): string {
  if (!at) return '—'
  return new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(at))
}

function MetricCard({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-2xs text-muted">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${tone ?? 'text-text-strong'}`}>{value}</div>
      {hint && <div className="mt-1 text-2xs text-muted">{hint}</div>}
    </div>
  )
}

const SEGMENTS = [
  { key: 'completed', label: '成功', color: 'var(--ok)' },
  { key: 'failed', label: '失败', color: 'var(--danger)' },
  { key: 'cancelled', label: '取消', color: 'var(--muted)' },
  { key: 'interrupted', label: '中断', color: 'var(--warn)' },
  { key: 'running', label: '进行中', color: 'var(--info)' },
] as const

function DailyBars({ days }: { days: SubagentStatsDay[] }) {
  const [hoveredIndex, setHoveredIndex] = useState<number>()
  const width = 900
  const height = 240
  const left = 46
  const right = 18
  const top = 18
  const bottom = 30
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const maxValue = Math.max(...days.map(day => SEGMENTS.reduce((sum, segment) => sum + day[segment.key], 0)), 0)
  const scale = maxValue > 0 ? maxValue : 1
  const slotWidth = days.length > 0 ? plotWidth / days.length : plotWidth
  const barWidth = Math.max(4, Math.min(26, slotWidth * 0.6))
  const labels = [1, 0.5, 0].map(ratio => ({ value: Math.round(maxValue * ratio), y: top + plotHeight - ratio * plotHeight }))
  const hovered = hoveredIndex === undefined ? undefined : days[hoveredIndex]

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted">
        {SEGMENTS.map(segment => (
          <span key={segment.key} className="inline-flex items-center gap-1.5">
            <b className="h-2 w-2 rounded-sm" style={{ background: segment.color }} />{segment.label}
          </span>
        ))}
      </div>
      <div className="relative overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} className="min-w-[680px] w-full h-[240px]" role="img" aria-label="每日子 Agent 启动与结果" onMouseLeave={() => setHoveredIndex(undefined)}>
          {labels.map((label, index) => (
            <g key={index}>
              <line x1={left} x2={width - right} y1={label.y} y2={label.y} stroke="var(--border)" strokeDasharray="3 5" />
              <text x={left - 8} y={label.y + 4} textAnchor="end" fontSize="10" fill="var(--muted)">{label.value}</text>
            </g>
          ))}
          {days.map((day, index) => {
            const centerX = left + slotWidth * (index + 0.5)
            const active = hoveredIndex === index
            let cursor = top + plotHeight
            return (
              <g key={day.date}>
                <rect x={left + slotWidth * index} y={top} width={slotWidth} height={plotHeight} fill="transparent" className="cursor-pointer" onMouseEnter={() => setHoveredIndex(index)} />
                {SEGMENTS.map(segment => {
                  const value = day[segment.key]
                  if (value <= 0) return null
                  const barHeight = (value / scale) * plotHeight
                  cursor -= barHeight
                  return <rect key={segment.key} x={centerX - barWidth / 2} y={cursor} width={barWidth} height={Math.max(1, barHeight)} fill={segment.color} opacity={active ? 1 : 0.85} />
                })}
                {(index === 0 || index === days.length - 1 || (index + 1) % 5 === 0) && (
                  <text x={centerX} y={height - 9} textAnchor="middle" fontSize="10" fill="var(--muted)">{day.date.slice(5)}</text>
                )}
              </g>
            )
          })}
        </svg>
        {hovered && (
          <div className="pointer-events-none absolute right-3 top-3 z-10 min-w-[190px] rounded-md border border-border bg-card px-3 py-2 shadow-lg backdrop-blur-sm">
            <div className="text-xs font-medium text-text-strong">{hovered.date}</div>
            <div className="mt-1 space-y-1 text-2xs">
              <div className="flex justify-between gap-4"><span className="text-muted">启动</span><span className="text-text-strong">{SEGMENTS.reduce((sum, segment) => sum + hovered[segment.key], 0)}</span></div>
              {SEGMENTS.map(segment => (
                <div key={segment.key} className="flex justify-between gap-4"><span className="text-muted">{segment.label}</span><span style={{ color: segment.color }}>{hovered[segment.key]}</span></div>
              ))}
              {hovered.tasks > 0 && <div className="flex justify-between gap-4"><span className="text-muted">工作流子任务</span><span className="text-text">{hovered.tasks}（失败 {hovered.tasksFailed}）</span></div>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function GroupTable({ title, hint, rows }: { title: string; hint: string; rows: SubagentStatsGroup[] }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-medium text-text-strong">{title}</h2>
      <p className="mt-1 text-2xs text-muted">{hint}</p>
      {rows.length === 0
        ? <p className="mt-3 text-2xs text-muted">这段时间没有记录。</p>
        : (
          <table className="mt-3 w-full text-2xs">
            <thead className="text-muted">
              <tr className="border-b border-border text-left">
                <th className="py-1.5 font-medium">分组</th>
                <th className="py-1.5 text-right font-medium">启动</th>
                <th className="py-1.5 text-right font-medium">成功</th>
                <th className="py-1.5 text-right font-medium">失败</th>
                <th className="py-1.5 text-right font-medium">取消/中断</th>
                <th className="py-1.5 text-right font-medium">成功率</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.key} className="border-b border-border/60 last:border-0">
                  <td className="max-w-[280px] truncate py-1.5 pr-2 text-text" title={row.key}>{row.key}</td>
                  <td className="py-1.5 text-right text-text">{row.launched}</td>
                  <td className="py-1.5 text-right" style={{ color: 'var(--ok)' }}>{row.completed}</td>
                  <td className="py-1.5 text-right" style={{ color: row.failed > 0 ? 'var(--danger)' : 'var(--muted)' }}>{row.failed}</td>
                  <td className="py-1.5 text-right text-muted">{row.cancelled + row.interrupted}</td>
                  <td className="py-1.5 text-right text-text">{row.completed + row.failed > 0 ? formatPercent(row.successRate) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </section>
  )
}

export default function SubagentStatsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [windowDays, setWindowDays] = useState<number>(7)
  const [report, setReport] = useState<SubagentStats>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(undefined)
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    fetch(`/api/subagent-stats?days=${windowDays}&timezone=${encodeURIComponent(timezone)}`, { credentials: 'same-origin' })
      .then(async response => {
        const body = await response.json().catch(() => ({})) as Record<string, unknown>
        if (!response.ok) throw new Error(typeof body.message === 'string' ? body.message : `HTTP ${response.status}`)
        return body as unknown as SubagentStats
      })
      .then(value => { if (!cancelled) setReport(value) })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [windowDays])

  const totals = report?.totals
  const settledHint = useMemo(() => {
    if (!report) return undefined
    return `已结束 ${report.totals.settled} 次 · 进行中 ${report.totals.running} 次 · 台账 ${report.records} 行`
  }, [report])

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-6 bg-bg">
      <div className="max-w-6xl mx-auto space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          {embedded
            ? <h2 className="text-sm font-medium text-text-strong">子 Agent 触发与成功率</h2>
            : <div>
              <h1 className="text-lg font-semibold text-text-strong">子 Agent 触发与成功率</h1>
              <p className="mt-1 text-xs text-muted">来自扩展落盘的 subagent-jobs.jsonl：每次派发和它的最终结果</p>
            </div>}
          <div className="inline-flex overflow-hidden rounded-md border border-border">
            {WINDOWS.map(value => (
              <button
                key={value}
                type="button"
                onClick={() => setWindowDays(value)}
                aria-pressed={windowDays === value}
                className={`px-3 py-1.5 text-xs ${windowDays === value ? 'bg-accent text-accent-fg' : 'bg-card text-text hover:bg-bg-hover'}`}
              >最近 {value} 天</button>
            ))}
          </div>
        </header>

        {error && <div className="rounded-md border border-danger bg-danger-subtle px-3 py-2 text-xs text-danger">子 Agent 统计读取失败：{error}</div>}
        {loading && !report && <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted">读取统计中…</div>}

        {report && report.empty && (
          <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted">
            还没有台账文件。扩展在每次派发子 Agent 时会写到 <code className="text-text">~/.pi/agent/subagent-jobs.jsonl</code>；这里只能统计写入之后发生的派发，之前的历史不在文件里。
          </div>
        )}

        {report && !report.empty && totals && <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label="触发次数" value={String(totals.launched)} hint={settledHint} />
            <MetricCard label="成功" value={String(totals.completed)} hint="子任务正常返回" tone="text-ok" />
            <MetricCard label="失败" value={String(totals.failed)} hint={`另有取消 ${totals.cancelled} · 中断 ${totals.interrupted}`} tone={totals.failed > 0 ? 'text-danger' : undefined} />
            <MetricCard
              label="成功率"
              value={totals.completed + totals.failed > 0 ? formatPercent(totals.successRate) : '—'}
              hint="成功 ÷（成功 + 失败）；取消与中断不计入分母"
            />
          </div>

          <section className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-medium text-text-strong">每日启动与结果</h2>
                <p className="mt-1 text-2xs text-muted">堆叠柱：绿=成功，红=失败，灰=取消，橙=中断，蓝=进行中 · {report.timezone}</p>
              </div>
              {totals.tasks > 0 && <span className="text-2xs text-muted">工作流内子任务 {totals.tasks} 个，失败 {totals.tasksFailed} 个</span>}
            </div>
            <DailyBars days={report.days} />
          </section>

          <div className="grid gap-4 xl:grid-cols-2">
            <GroupTable title="按角色" hint="role 决定子 Agent 能用哪些工具；省略 role 时默认 code（可写）" rows={report.byRole} />
            <GroupTable title="按档位" hint="tier 决定模型候选；同一档位内会按配置自动换模型" rows={report.byTier} />
          </div>
          <GroupTable title="按实际运行模型" hint="结果里记录的最终模型，自动切换后算切换后的那个" rows={report.byModel} />

          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-medium text-text-strong">最近的失败</h2>
            <p className="mt-1 text-2xs text-muted">只列出失败和中断；取消不算失败。</p>
            {report.recentFailures.length === 0
              ? <p className="mt-3 text-2xs text-muted">这段时间没有失败记录。</p>
              : (
                <ul className="mt-3 space-y-2">
                  {report.recentFailures.map(failure => (
                    <li key={failure.workId} className="rounded-md border border-border bg-bg px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-2xs">
                        <span className="text-text-strong">{failure.label || failure.workId}</span>
                        <span className="text-muted">
                          {formatTime(failure.at)} · {failure.kind}
                          {failure.role ? ` · ${failure.role}` : ''}
                          {failure.tier ? ` · ${failure.tier}` : ''}
                          {failure.model ? ` · ${failure.model}` : ''}
                          {` · ${failure.status}`}
                        </span>
                      </div>
                      {failure.error && <p className="mt-1 break-words text-2xs text-danger">{failure.error}</p>}
                    </li>
                  ))}
                </ul>
              )}
          </section>

          <p className="text-2xs text-muted">
            统计口径：一行一次事件，同一个 workId 取最后一行作为最终状态。工作流按整次派发计时，子任务数量单独列出。台账只记本机 Pi 进程的派发；其他机器或没写台账的旧记录不在统计内。
          </p>
        </>}
      </div>
    </div>
  )
}