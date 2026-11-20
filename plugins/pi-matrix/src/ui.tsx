// @ts-nocheck — Plugin files are bundled by Vite, not type-checked by the frontend tsc config.
/** Presentational primitives shared by every pi-matrix surface. */
import { useState, type ReactNode } from 'react'
import MarkdownRenderer from '../../../frontend/src/components/MarkdownRenderer'

export type Tone = 'ok' | 'warn' | 'danger' | 'accent' | 'muted'

export const TONE_CLASS: Record<Tone, string> = {
  ok: 'bg-ok-subtle text-ok border-ok/30',
  warn: 'bg-warn-subtle text-warn border-warn/30',
  danger: 'bg-danger-subtle text-danger border-danger/30',
  accent: 'bg-accent-subtle text-accent border-accent/30',
  muted: 'bg-bg-hover text-muted border-border',
}

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
  accent: 'text-accent',
  muted: 'text-muted',
}

export const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  accent: 'bg-accent',
  muted: 'bg-muted',
}

const STATUS_TONE: Record<string, Tone> = {
  open: 'muted',
  reviewed: 'warn',
  cited: 'warn',
  certified: 'accent',
  refuted: 'danger',
  proved: 'ok',
  disproved: 'danger',
}

const STATUS_LABEL: Record<string, string> = {
  open: 'OPEN',
  reviewed: 'REVIEWED',
  cited: 'CITED',
  certified: 'CERTIFIED',
  refuted: 'REFUTED',
  proved: 'PROVED',
  disproved: 'DISPROVED',
}

const TIER_TONE: Record<string, Tone> = {
  conjecture: 'muted',
  draft: 'muted',
  reviewed: 'warn',
  cited: 'warn',
  certified: 'accent',
  refuted: 'danger',
}

export function statusTone(status: string): Tone {
  return STATUS_TONE[status] ?? 'muted'
}

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? String(status || '?').toUpperCase()
}

export function tierTone(tier: string): Tone {
  return TIER_TONE[tier] ?? 'muted'
}

export function Chip({ tone = 'muted', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-2xs font-medium leading-[14px] ${TONE_CLASS[tone]}`}>
      {children}
    </span>
  )
}

export function Dot({ tone = 'muted', pulse = false }: { tone?: Tone; pulse?: boolean }) {
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${TONE_DOT[tone]} ${pulse ? 'animate-pulse' : ''}`} />
}

export function StatusChip({ status, aligned }: { status: string; aligned?: boolean }) {
  return (
    <>
      <Chip tone={statusTone(status)}>{statusLabel(status)}</Chip>
      {aligned === false && <Chip tone="warn" title="A human must run /proof-align before this target can become proved">alignment unconfirmed</Chip>}
      {aligned === true && <Chip tone="ok">aligned</Chip>}
    </>
  )
}

export function TierChip({ tier }: { tier: string }) {
  return <Chip tone={tierTone(tier)}>{tier || '?'}</Chip>
}

export function Card({
  icon,
  title,
  subtitle,
  badge,
  defaultOpen = true,
  children,
}: {
  icon?: string
  title: ReactNode
  subtitle?: ReactNode
  badge?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card animate-scale-in">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        className="flex w-full items-center gap-2 border-b border-border bg-bg-hover px-3 py-2 text-left"
        aria-expanded={open}
      >
        <span className="w-3 shrink-0 text-2xs text-muted">{open ? '▾' : '▸'}</span>
        {icon && <span className="text-[14px]">{icon}</span>}
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text">{title}</span>
        {subtitle && <span className="hidden min-w-0 truncate text-2xs text-muted sm:inline">{subtitle}</span>}
        {badge && <span className="ml-auto flex shrink-0 items-center gap-1">{badge}</span>}
      </button>
      {open && <div className="space-y-2 p-3">{children}</div>}
    </div>
  )
}

export function Pre({ children, tone = 'muted', maxHeight = '18rem' }: { children: ReactNode; tone?: Tone; maxHeight?: string }) {
  return (
    <pre
      className={`overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-bg px-2 py-1.5 font-mono text-[11px] leading-relaxed ${TONE_TEXT[tone]}`}
      style={{ maxHeight }}
    >
      {children}
    </pre>
  )
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="break-all font-mono text-[11px] text-muted">{children}</span>
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-[12px]">
      <span className="w-24 shrink-0 text-muted">{label}</span>
      <span className="min-w-0 flex-1 break-words text-text">{children}</span>
    </div>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted">
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" />
      {label && <span className="truncate">{label}</span>}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-[12px] italic text-muted">{children}</p>
}

export function ErrorLine({ children }: { children: ReactNode }) {
  return <p className="rounded border border-danger/30 bg-danger-subtle px-2 py-1 text-[12px] text-danger">{children}</p>
}

export function Warnings({ warnings }: { warnings?: string[] }) {
  if (!warnings?.length) return null
  return (
    <ul className="space-y-1">
      {warnings.map((warning, index) => (
        <li key={index} className="flex gap-1.5 rounded border border-warn/20 bg-warn-subtle px-2 py-1 text-[12px] text-warn">
          <span className="shrink-0">⚠</span>
          <span className="min-w-0 break-words">{warning}</span>
        </li>
      ))}
    </ul>
  )
}

export function Progress({ value, max, tone = 'accent', label }: { value: number; max: number; tone?: Tone; label?: string }) {
  const safeMax = Math.max(max, 1)
  const pct = Math.min(100, Math.round((value / safeMax) * 100))
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 min-w-[4rem] flex-1 overflow-hidden rounded bg-bg-hover">
        <div className={`h-full ${TONE_DOT[tone]}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="shrink-0 text-2xs text-muted">{label ?? `${value}/${max}`}</span>
    </div>
  )
}

export function Statement({ text }: { text?: string }) {
  if (!text) return <Empty>No statement recorded.</Empty>
  return (
    <div className="rounded border border-border bg-bg px-2 py-1.5 text-[12px] text-text">
      <MarkdownRenderer content={text} showRaw={false} />
    </div>
  )
}

export function CopyButton({ value, label = 'copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="shrink-0 rounded border border-border bg-bg px-1.5 py-0.5 text-2xs text-muted hover:text-text"
      onClick={async event => {
        event.stopPropagation()
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        } catch {
          setCopied(false)
        }
      }}
      title={value}
    >
      {copied ? 'copied' : label}
    </button>
  )
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <span className="text-2xs font-semibold uppercase tracking-wide text-muted">{children}</span>
      {right && <span className="ml-auto">{right}</span>}
    </div>
  )
}
