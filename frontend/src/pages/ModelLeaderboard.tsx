import { Fragment, useEffect, useMemo, useState } from 'react'
import type { UsageModelSummary, UsageReport } from '@shared/usage'
import type { TimingModelSummary, TimingReport } from '@shared/timing'
import { MODEL_SCORES, SCORE_SNAPSHOT_DATE, SCORE_SOURCE_URL, type ModelScore } from '../data/modelScores'

function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function formatCost(value: number): string {
  if (value === 0) return '$0'
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(Math.round(value))
}

function formatMs(ms: number | undefined): string {
  if (!ms) return '—'
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

type SortKey = 'terminalBench40' | 'intelligenceIndex' | 'frontierCode' | 'terminalBench21' | 'costUsd' | 'effectiveUsdPerM' | 'outputSpeed' | 'valuePerDollar'

interface ProviderMatch {
  key: string
  usage?: UsageModelSummary
  timing?: TimingModelSummary
}

interface LeaderRow {
  score: ModelScore
  matches: ProviderMatch[]
  costUsd: number
  totalTokens: number
  effectiveUsdPerM: number
  outputSpeed: number
  valuePerDollar: number
}

const SORT_COLUMNS: { key: SortKey; label: string; hint: string; numeric: true }[] = [
  { key: 'terminalBench40', label: 'TB 4.0', hint: 'Terminal-Bench 4.0 智能体终端任务胜率（%）', numeric: true },
  { key: 'intelligenceIndex', label: '智能指数', hint: 'AA 智能指数（0-100 综合）', numeric: true },
  { key: 'frontierCode', label: 'FrontierCode', hint: '开源仓库工单「维护者会合并」比例（%）', numeric: true },
  { key: 'terminalBench21', label: 'TB 2.1', hint: 'Terminal-Bench 2.1 胜率（%）', numeric: true },
]

/** llm-gateway does not report cache tokens, so its inputs are all billed at full price and its unit price reads high. */
function gatewayWithoutCache(match: ProviderMatch): boolean {
  const usage = match.usage
  return !!usage && match.key.startsWith('llm-gateway/') && usage.inputTokens > 0 && usage.cacheReadTokens + usage.cacheWriteTokens === 0
}

function scoreValue(row: LeaderRow, key: SortKey): number | undefined {
  switch (key) {
    case 'terminalBench40': return row.score.terminalBench40
    case 'intelligenceIndex': return row.score.intelligenceIndex
    case 'frontierCode': return row.score.frontierCode
    case 'terminalBench21': return row.score.terminalBench21
    case 'costUsd': return row.costUsd
    case 'effectiveUsdPerM': return row.effectiveUsdPerM
    case 'outputSpeed': return row.outputSpeed
    case 'valuePerDollar': return row.valuePerDollar
  }
}

function ScoreBar({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-1.5 w-10 rounded-sm bg-border overflow-hidden" aria-hidden="true">
        <span className="block h-full bg-accent" style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
      </span>
      <span>{value.toFixed(1)}</span>
    </span>
  )
}

function SummaryCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-2xs text-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold text-text-strong truncate" title={value}>{value}</div>
      {hint && <div className="mt-1 text-2xs text-muted truncate" title={hint}>{hint}</div>}
    </div>
  )
}

export default function ModelLeaderboard() {
  const [month, setMonth] = useState(currentMonth)
  const [onlyOurs, setOnlyOurs] = useState(true)
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('intelligenceIndex')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [expanded, setExpanded] = useState<string>()
  const [usage, setUsage] = useState<UsageReport>()
  const [usageError, setUsageError] = useState<string>()
  const [timing, setTiming] = useState<TimingReport>()
  const [timingError, setTimingError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    setUsage(undefined); setUsageError(undefined)
    fetch(`/api/usage?month=${encodeURIComponent(month)}`, { credentials: 'same-origin' })
      .then(async response => {
        const body = await response.json().catch(() => ({})) as Record<string, unknown>
        if (!response.ok) throw new Error(typeof body.message === 'string' ? body.message : `HTTP ${response.status}`)
        return body as unknown as UsageReport
      })
      .then(value => { if (!cancelled) setUsage(value) })
      .catch(reason => { if (!cancelled) setUsageError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [month])

  useEffect(() => {
    let cancelled = false
    setTiming(undefined); setTimingError(undefined)
    fetch(`/api/timing?range=month&month=${encodeURIComponent(month)}`, { credentials: 'same-origin' })
      .then(async response => {
        const body = await response.json().catch(() => ({})) as Record<string, unknown>
        if (!response.ok) throw new Error(typeof body.message === 'string' ? body.message : `HTTP ${response.status}`)
        return body as unknown as TimingReport
      })
      .then(value => { if (!cancelled) setTiming(value) })
      .catch(reason => { if (!cancelled) setTimingError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [month])

  const rows = useMemo<LeaderRow[]>(() => {
    const usageByKey = new Map((usage?.models ?? []).map(m => [m.key, m]))
    const timingByKey = new Map((timing?.models ?? []).map(m => [m.key, m]))
    return MODEL_SCORES.map(score => {
      const matches: ProviderMatch[] = score.ourModels.map(key => ({
        key,
        usage: usageByKey.get(key),
        timing: timingByKey.get(key),
      }))
      const costUsd = matches.reduce((sum, m) => sum + (m.usage?.costUsd ?? 0), 0)
      const totalTokens = matches.reduce((sum, m) => sum + (m.usage?.totalTokens ?? 0), 0)
      const effectiveUsdPerM = totalTokens > 0 ? (costUsd / totalTokens) * 1_000_000 : 0
      const outputTokens = matches.reduce((sum, m) => sum + (m.usage?.outputTokens ?? 0), 0)
      const speedSum = matches.reduce((sum, m) => sum + (m.timing?.decodeTokensPerSec ?? 0) * (m.usage?.outputTokens ?? 0), 0)
      const outputSpeed = outputTokens > 0 ? speedSum / outputTokens : 0
      const valuePerDollar = effectiveUsdPerM > 0 && score.intelligenceIndex ? score.intelligenceIndex / effectiveUsdPerM : 0
      return { score, matches, costUsd, totalTokens, effectiveUsdPerM, outputSpeed, valuePerDollar }
    })
  }, [usage, timing])

  const visibleRows = useMemo(() => {
    let list = rows
    if (onlyOurs) list = list.filter(row => row.score.ourModels.length > 0)
    const q = query.trim().toLowerCase()
    if (q) list = list.filter(row => row.score.name.toLowerCase().includes(q) || row.score.creator.toLowerCase().includes(q))
    const dir = sortDir === 'desc' ? -1 : 1
    return [...list].sort((a, b) => {
      const va = scoreValue(a, sortKey)
      const vb = scoreValue(b, sortKey)
      if (va === undefined && vb === undefined) return a.score.name.localeCompare(b.score.name)
      if (va === undefined) return 1
      if (vb === undefined) return -1
      if (va === vb) return a.score.name.localeCompare(b.score.name)
      return (va - vb) * dir
    })
  }, [rows, onlyOurs, query, sortKey, sortDir])

  const summary = useMemo(() => {
    const withScore = rows.filter(r => r.score.terminalBench40 !== undefined)
    const top = [...withScore].sort((a, b) => (b.score.terminalBench40 ?? 0) - (a.score.terminalBench40 ?? 0))[0]
    const oursTop = [...withScore.filter(r => r.score.ourModels.length > 0)].sort((a, b) => (b.score.terminalBench40 ?? 0) - (a.score.terminalBench40 ?? 0))[0]
    const bestValue = [...rows.filter(r => r.valuePerDollar > 0)].sort((a, b) => b.valuePerDollar - a.valuePerDollar)[0]
    return { top, oursTop, bestValue }
  }, [rows])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => (d === 'desc' ? 'asc' : 'desc'))
    else { setSortKey(key); setSortDir('desc') }
  }

  const sortIndicator = (key: SortKey) => (sortKey === key ? (sortDir === 'desc' ? ' ↓' : ' ↑') : '')

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-6 bg-bg">
      <div className="max-w-6xl mx-auto space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-text-strong">模型能力排行榜</h2>
            <p className="text-2xs text-muted mt-1">
              AI 能力分数（{SCORE_SNAPSHOT_DATE} 快照）× 本机真实成本与速度 · 重点看 agentic coding（TB 4.0 / FrontierCode）
            </p>
          </div>
          <label className="text-xs text-muted flex items-center gap-2">月份
            <input type="month" value={month} onChange={e => setMonth(e.target.value)} className="rounded-md border border-border bg-card px-2 py-1.5 text-text" />
          </label>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <SummaryCard label="Agentic 榜首（TB 4.0）" value={summary.top ? summary.top.score.name : '—'} hint={summary.top ? `TB 4.0 ${summary.top.score.terminalBench40}% · 智能指数 ${summary.top.score.intelligenceIndex}` : undefined} />
          <SummaryCard label="我们在用的最强" value={summary.oursTop ? summary.oursTop.score.name : '—'} hint={summary.oursTop ? `TB 4.0 ${summary.oursTop.score.terminalBench40}% · ${summary.oursTop.matches.map(m => m.key).join(' / ')}` : undefined} />
          <SummaryCard label="性价比最高（智能指数 ÷ 实际单价）" value={summary.bestValue ? summary.bestValue.score.name : '—'} hint={summary.bestValue ? `${summary.bestValue.valuePerDollar.toFixed(1)} 分/（$/MTok） · ${formatCost(summary.bestValue.effectiveUsdPerM)}/MTok` : undefined} />
        </div>

        <section className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-2xs text-muted flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={onlyOurs} onChange={e => setOnlyOurs(e.target.checked)} className="accent-[var(--accent)]" />
                只看已启用的模型
              </label>
              <input
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="筛选模型 / 厂商"
                className="rounded-md border border-border bg-bg px-2 py-1 text-2xs text-text w-44"
                aria-label="筛选模型"
              />
            </div>
            <div className="text-2xs text-muted">{visibleRows.length} 个模型 · 点击行查看本机用量明细</div>
          </div>

          {(usageError || timingError) && (
            <div className="mb-3 rounded-md border border-warn bg-warn-subtle px-3 py-2 text-2xs text-warn">
              {usageError ? `成本账本读取失败：${usageError}。` : ''}
              {timingError ? `耗时账本读取失败：${timingError}。` : ''}
              分数列不受影响，成本 / 速度列暂不可用。
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-2xs">
              <thead className="text-2xs uppercase text-muted">
                <tr>
                  <th className="py-1.5 pr-2">#</th>
                  <th className="py-1.5 pr-3">模型</th>
                  <th className="py-1.5 pr-3">发布</th>
                  {SORT_COLUMNS.map(col => (
                    <th key={col.key} className="py-1.5 pr-3" title={col.hint}>
                      <button type="button" onClick={() => toggleSort(col.key)} className="hover:text-text" aria-sort={sortKey === col.key ? (sortDir === 'desc' ? 'descending' : 'ascending') : 'none'}>
                        {col.label}{sortIndicator(col.key)}
                      </button>
                    </th>
                  ))}
                  <th className="py-1.5 pr-3">
                    <button type="button" onClick={() => toggleSort('costUsd')} className="hover:text-text" aria-sort={sortKey === 'costUsd' ? (sortDir === 'desc' ? 'descending' : 'ascending') : 'none'}>
                      本月花费{sortIndicator('costUsd')}
                    </button>
                  </th>
                  <th className="py-1.5 pr-3">
                    <button type="button" onClick={() => toggleSort('effectiveUsdPerM')} className="hover:text-text" title="本月实际加权单价" aria-sort={sortKey === 'effectiveUsdPerM' ? (sortDir === 'desc' ? 'descending' : 'ascending') : 'none'}>
                      实际单价{sortIndicator('effectiveUsdPerM')}
                    </button>
                  </th>
                  <th className="py-1.5 pr-3">
                    <button type="button" onClick={() => toggleSort('outputSpeed')} className="hover:text-text" title="本机实测输出速度（按输出 token 加权）" aria-sort={sortKey === 'outputSpeed' ? (sortDir === 'desc' ? 'descending' : 'ascending') : 'none'}>
                      输出速度{sortIndicator('outputSpeed')}
                    </button>
                  </th>
                  <th className="py-1.5">
                    <button type="button" onClick={() => toggleSort('valuePerDollar')} className="hover:text-text" title="智能指数 ÷ 实际单价（越高越划算）" aria-sort={sortKey === 'valuePerDollar' ? (sortDir === 'desc' ? 'descending' : 'ascending') : 'none'}>
                      性价比{sortIndicator('valuePerDollar')}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row, index) => {
                  const isExpanded = expanded === row.score.slug
                  const hasDetail = row.matches.length > 0
                  return (
                    <Fragment key={row.score.slug || row.score.name}>
                      <tr
                        className={`border-t border-border ${hasDetail ? 'cursor-pointer hover:bg-bg-hover' : ''}`}
                        onClick={() => hasDetail && setExpanded(current => (current === row.score.slug ? undefined : row.score.slug))}
                        aria-expanded={hasDetail ? isExpanded : undefined}
                      >
                        <td className="py-2 pr-2 text-muted">{index + 1}</td>
                        <td className="py-2 pr-3">
                          <div className="font-medium text-text">{row.score.name}</div>
                          <div className="text-muted">{row.score.creator}{row.score.ourModels.length > 0 && <span className="ml-1.5 text-accent">· 已启用</span>}</div>
                        </td>
                        <td className="py-2 pr-3 text-muted">{row.score.releaseDate ?? '—'}</td>
                        <td className="py-2 pr-3 text-text-strong font-medium">{row.score.terminalBench40 !== undefined ? <ScoreBar value={row.score.terminalBench40} /> : '—'}</td>
                        <td className="py-2 pr-3 text-text-strong font-medium">{row.score.intelligenceIndex !== undefined ? row.score.intelligenceIndex.toFixed(1) : '—'}</td>
                        <td className="py-2 pr-3 text-text">{row.score.frontierCode !== undefined ? <ScoreBar value={row.score.frontierCode} /> : '—'}</td>
                        <td className="py-2 pr-3 text-muted">{row.score.terminalBench21 !== undefined ? row.score.terminalBench21.toFixed(1) : '—'}</td>
                        <td className="py-2 pr-3 text-text">{row.costUsd > 0 ? formatCost(row.costUsd) : '—'}</td>
                        <td className="py-2 pr-3 text-text">
                          {row.effectiveUsdPerM > 0 ? `$${row.effectiveUsdPerM.toFixed(2)}/M` : '—'}
                          {row.matches.some(gatewayWithoutCache) && <span className="ml-0.5 text-muted" title="llm-gateway 未上报缓存用量，输入全按原价计算，单价偏高">†</span>}
                        </td>
                        <td className="py-2 pr-3 text-text">{row.outputSpeed > 0 ? `${row.outputSpeed.toFixed(1)} tok/s` : '—'}</td>
                        <td className="py-2 text-text">{row.valuePerDollar > 0 ? row.valuePerDollar.toFixed(1) : '—'}</td>
                      </tr>
                      {isExpanded && (
                        <tr className="border-t border-border bg-bg">
                          <td colSpan={11} className="py-2">
                            {row.matches.every(m => !m.usage && !m.timing) ? (
                              <div className="text-2xs text-muted py-1">{month} 本机没有该模型的用量记录（列显示为 —）。</div>
                            ) : (
                              <div className="space-y-2">
                                {row.matches.map(match => (
                                  <div key={match.key} className="rounded-md border border-border bg-card px-3 py-2">
                                    <div className="font-medium text-text">{match.key}</div>
                                    {match.usage ? (
                                      <div className="mt-1 grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-2xs text-muted">
                                        <span>花费 <b className="text-text">{formatCost(match.usage.costUsd)}</b></span>
                                        <span>Token <b className="text-text">{formatTokens(match.usage.totalTokens)}</b>（输入 {formatTokens(match.usage.inputTokens)} / 输出 {formatTokens(match.usage.outputTokens)}）</span>
                                        <span>Cache read <b className="text-text">{formatTokens(match.usage.cacheReadTokens)}</b></span>
                                        <span>实际单价 <b className="text-text">${match.usage.effectiveUsdPerMillionTokens.toFixed(2)}/MTok</b></span>
                                      </div>
                                    ) : (
                                      <div className="mt-1 text-2xs text-muted">{month} 无成本记录</div>
                                    )}
                                    {match.timing && (
                                      <div className="mt-1 grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-2xs text-muted">
                                        <span>调用 {match.timing.calls} 次{match.timing.errors > 0 ? ` · 失败 ${match.timing.errors}` : ''}</span>
                                        <span>平均耗时 <b className="text-text">{formatMs(match.timing.avgTotalMs)}</b></span>
                                        <span>TTFT p50/p90 <b className="text-text">{formatMs(match.timing.ttftP50Ms)} / {formatMs(match.timing.ttftP90Ms)}</b></span>
                                        <span>输出 <b className="text-text">{match.timing.decodeTokensPerSec > 0 ? `${match.timing.decodeTokensPerSec.toFixed(1)} tok/s` : '—'}</b></span>
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
            {visibleRows.length === 0 && <div className="py-6 text-center text-xs text-muted">没有匹配的模型</div>}
          </div>

          <p className="mt-3 text-2xs text-muted">
            分数来源 <a href={SCORE_SOURCE_URL} target="_blank" rel="noreferrer" className="text-accent hover:underline">Artificial Analysis</a>（{SCORE_SNAPSHOT_DATE} 快照，静态数据，随本仓库更新）；
            Terminal-Bench 4.0 与 FrontierCode 为 agentic coding 方向评测；「—」表示无数据。
            成本 / 单价 / 速度列来自本机 usage 与 timing 账本（{month}），同一模型可能合并多个 provider 通道。
            † 表示 llm-gateway 通道未上报缓存用量，输入全按原价计算，单价偏高，与 Azure 通道不能直接比较。
          </p>
        </section>
      </div>
    </div>
  )
}
