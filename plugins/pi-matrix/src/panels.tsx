// @ts-nocheck — Plugin files are bundled by Vite, not type-checked by the frontend tsc config.
/** Persistent surfaces: chat status bar, sidebar entry, extension settings. */
import { doctorUrl, goto, invalidatePimatrixCache, relativeTime, shortPath, statusUrl, useActiveSlot, useEndpoint } from './api'
import { Card, Chip, Dot, Empty, ErrorLine, KeyValue, Mono, Spinner, TONE_TEXT, statusLabel, statusTone } from './ui'

function isNotAProject(error: string | null): boolean {
  return !!error && /not_a_pimatrix_project|no pimatrix\.json|slot not found|slot_not_found|slot has no working directory|missing_project/i.test(error)
}

export function ProofStatusBar() {
  const { slot } = useActiveSlot(2000)
  const { data, error } = useEndpoint(slot ? statusUrl({ slot }) : null, 10_000)

  if (!slot) return null
  if (!data) {
    if (error && !isNotAProject(error)) return <div className="px-1 text-2xs text-muted">proof: {error}</div>
    return null
  }
  const status = data.status
  const warnings = status.warnings?.length ?? 0
  return (
    <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto px-1 py-0.5">
      <button
        type="button"
        onClick={() => goto('/plugin/proof')}
        className="shrink-0 rounded border border-border bg-bg px-1.5 py-0.5 text-2xs font-semibold text-muted hover:text-text"
        title="Open the proof board"
      >
        ∑ {status.project}
      </button>
      {status.targets?.map(target => (
        <span
          key={target.id}
          className="flex shrink-0 items-center gap-1 rounded border border-border bg-bg px-1.5 py-0.5 text-2xs"
          title={target.statement}
        >
          <Dot tone={statusTone(target.status)} />
          <span className="font-mono text-text">{target.id}</span>
          <span className={TONE_TEXT[statusTone(target.status)]}>{statusLabel(target.status)}</span>
          {!target.aligned && <span className="text-warn" title="alignment unconfirmed">*</span>}
        </span>
      ))}
      {status.ledger?.chain_ok === false && <Chip tone="danger">chain broken</Chip>}
      {status.low_yield?.flag && <Chip tone="warn">LOW_YIELD</Chip>}
      {warnings > 0 && <Chip tone="warn">{warnings} warning(s)</Chip>}
      {data.meta?.stale && <Chip tone="warn" title={data.meta.error}>{data.meta.busy ? 'kernel busy' : 'stale'}</Chip>}
    </div>
  )
}

export function ProofSidebarPanel() {
  const { slot, cwd } = useActiveSlot(3000)
  const { data } = useEndpoint(slot ? statusUrl({ slot }) : null, 20_000)
  const targets = data?.status.targets ?? []
  return (
    <button
      type="button"
      onClick={() => goto('/plugin/proof')}
      className="mt-2 flex w-full items-center gap-2 rounded-md p-2 text-body-s text-muted transition hover:bg-bg-hover hover:text-text"
      title={cwd ? `Proof projects · ${shortPath(cwd)}` : 'Proof board'}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-accent">∑</span>
      <span className="truncate">Proof</span>
      {targets.length > 0 && (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {targets.slice(0, 3).map(target => (
            <span key={target.id} className="flex items-center gap-0.5" title={`${target.id}: ${statusLabel(target.status)}`}>
              <Dot tone={statusTone(target.status)} />
              <span className="font-mono text-2xs">{target.id}</span>
            </span>
          ))}
          {targets.length > 3 && <span className="text-2xs">+{targets.length - 3}</span>}
        </span>
      )}
    </button>
  )
}

function doctorRows(doctor: Record<string, unknown>): [string, string][] {
  const rows: [string, string][] = []
  for (const [key, value] of Object.entries(doctor)) {
    if (key === 'capabilities') continue
    if (value === null || value === undefined) continue
    rows.push([key, typeof value === 'object' ? JSON.stringify(value) : String(value)])
  }
  return rows
}

interface CapabilityRow {
  key: string
  available: boolean | null
  detail: string
}

function capabilityRows(capabilities: unknown): CapabilityRow[] {
  if (!capabilities || typeof capabilities !== 'object') return []
  return Object.entries(capabilities as Record<string, unknown>).map(([key, value]) => {
    if (value && typeof value === 'object') {
      const entry = value as { available?: unknown; version?: unknown; reason?: unknown }
      const available = typeof entry.available === 'boolean' ? entry.available : null
      const detail = [entry.version, entry.reason]
        .filter(part => typeof part === 'string' && part && part !== 'ok')
        .join(' · ')
        || (available === true ? 'available' : available === false ? 'unavailable' : 'not tested')
      return { key, available, detail }
    }
    const text = String(value)
    const available = text === 'ok' || text === 'true' || text === 'available' || text === 'verified'
      ? true
      : text === 'unavailable' || text === 'false'
        ? false
        : null
    return { key, available, detail: text }
  })
}

export function ProofSettings() {
  const { data, error, loading, reload } = useEndpoint(doctorUrl(), 0)
  const doctor = (data?.doctor ?? {}) as Record<string, unknown>
  const kernel = data?.kernel
  const capabilities = capabilityRows(doctor.capabilities)
  const rows = doctorRows(doctor)

  return (
    <Card
      icon="∑"
      title="pi-matrix"
      subtitle="proof kernel and tool capabilities"
      badge={
        <>
          {doctor.ok === true && <Chip tone="ok">doctor ok</Chip>}
          {doctor.ok === false && <Chip tone="danger">doctor failed</Chip>}
        </>
      }
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="rounded border border-border bg-bg px-1.5 py-0.5 text-2xs text-muted hover:text-text"
          onClick={() => {
            invalidatePimatrixCache()
            reload(true)
          }}
        >
          refresh
        </button>
        {data && <span className="text-2xs text-muted">read {relativeTime(data.meta?.readAt)}</span>}
      </div>
      {loading && !data && <Spinner label="checking the pi-matrix kernel…" />}
      {error && <ErrorLine>{error}</ErrorLine>}
      {kernel && (
        <div className="space-y-1">
          <KeyValue label="package">
            <Mono>{kernel.packageRoot}</Mono>
          </KeyValue>
          <KeyValue label="python">
            <Mono>{kernel.python}</Mono>
          </KeyValue>
        </div>
      )}
      {rows.length > 0 && (
        <div className="space-y-1">
          {rows.map(([key, value]) => (
            <KeyValue key={key} label={key}>
              <span className="break-words text-[12px] text-muted">{value}</span>
            </KeyValue>
          ))}
        </div>
      )}
      {capabilities.length > 0 ? (
        <div>
          <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted">capabilities</div>
          <div className="grid gap-1 sm:grid-cols-2">
            {capabilities.map(row => (
              <div
                key={row.key}
                className="flex items-center gap-2 rounded border border-border bg-bg px-2 py-1"
                title={`${row.key}: ${row.detail}`}
              >
                <Dot tone={row.available === true ? 'ok' : row.available === false ? 'danger' : 'muted'} />
                <span className="min-w-0 flex-1 truncate text-[12px] text-text">{row.key}</span>
                <span className="shrink-0 font-mono text-2xs text-muted">
                  {row.available === true ? 'ok' : row.available === false ? 'unavailable' : 'n/a'}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        !loading && !error && <Empty>No capability report.</Empty>
      )}
      <p className="text-2xs text-muted">
        <Mono>doctor</Mono> checks the Python core only; Lean, mathlib and provider roles are reported separately under capabilities.
      </p>
    </Card>
  )
}
