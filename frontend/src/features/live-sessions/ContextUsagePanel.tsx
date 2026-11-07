import type { LiveSessionSummary } from '@shared/live-sessions'

/** Latest context estimate, deliberately separate from accumulated/billed input-output usage. */
export default function ContextUsagePanel({ usage, stale = false }: {
  usage?: LiveSessionSummary['contextUsage']
  stale?: boolean
}) {
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
  const rawTokens = usage?.tokens, rawWindow = usage?.contextWindow, rawPercent = usage?.percent
  const tokens = valid(rawTokens) ? rawTokens : undefined
  const window = valid(rawWindow) && rawWindow > 0 ? rawWindow : undefined
  const computed = tokens !== undefined && window !== undefined ? tokens / window * 100 : undefined
  const percent = valid(rawPercent) ? rawPercent : valid(computed) ? computed : undefined
  const number = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 0 })
  const counts = tokens !== undefined
    ? window !== undefined ? `${number(tokens)} / ${number(window)} tokens` : `${number(tokens)} tokens · 窗口未上报`
    : window !== undefined ? `tokens 未上报 / 窗口 ${number(window)}` : 'tokens 与窗口尚未上报'
  const high = percent !== undefined && percent >= 85
  return <section aria-label="上下文用量" className="mb-3 space-y-1.5 rounded-lg border border-border bg-bg p-3">
    <div className={`text-body-s font-semibold ${high ? 'text-warn' : 'text-text-strong'}`}>
      上下文 · {percent === undefined ? '占用待上报' : `${percent.toFixed(1)}%`}
    </div>
    <div className="break-words font-mono text-caption text-text">{counts}</div>
    {percent !== undefined && <div role="progressbar" aria-label="上下文占用" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={Math.min(100, percent)} aria-valuetext={`${percent.toFixed(1)}%`}
      className="h-1.5 overflow-hidden rounded-full bg-border">
      <div className={`h-full ${high ? 'bg-warn' : 'bg-accent'}`} style={{ width: `${Math.min(100, percent)}%` }} />
    </div>}
    <p className="text-caption text-muted">{stale ? '正在重连，最近上报可能过期' : '最近上报的估算值'} · 非累计账单用量</p>
  </section>
}
