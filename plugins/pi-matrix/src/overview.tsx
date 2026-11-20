// @ts-nocheck — Plugin files are bundled by Vite, not type-checked by the frontend tsc config.
/**
 * `/plugin/proof` — read-only cross-project proof board.
 *
 * Discovery comes from the backend (configured roots, the Repos registry and
 * live chat-slot cwds). Every expanded row re-reads `pimatrix status` and the
 * ledger tail through the Python kernel.
 */
import { useMemo, useState } from 'react'
import type { PimatrixProjectSummary } from '@shared/pimatrix'
import { goto, invalidatePimatrixCache, logUrl, projectsUrl, relativeTime, shortPath, statusUrl, useEndpoint } from './api'
import { StatusBoard } from './status'
import {
  Card,
  Chip,
  Dot,
  Empty,
  ErrorLine,
  Mono,
  Pre,
  SectionTitle,
  Spinner,
  StatusChip,
  TierChip,
} from './ui'

function statusCounts(projects: PimatrixProjectSummary[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const project of projects) {
    for (const target of project.targets) counts[target.status] = (counts[target.status] ?? 0) + 1
  }
  return counts
}

function ProjectRow({ project, expanded, onToggle }: { project: PimatrixProjectSummary; expanded: boolean; onToggle: () => void }) {
  const hasWarnings = project.warnings.length > 0 || project.error
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onToggle()
        }
      }}
      className={`flex w-full cursor-pointer flex-col gap-1.5 rounded-lg border px-3 py-2 text-left transition ${
        expanded ? 'border-accent/40 bg-accent-subtle' : 'border-border bg-card hover:bg-bg-hover'
      }`}
    >
      <div className="flex w-full flex-wrap items-center gap-1.5">
        <span className="w-3 shrink-0 text-2xs text-muted">{expanded ? '▾' : '▸'}</span>
        <span className="min-w-0 truncate text-[13px] font-semibold text-text">{project.title || project.id}</span>
        <span className="min-w-0 truncate font-mono text-2xs text-muted">{shortPath(project.root, 2)}</span>
        {project.meta?.stale && <Chip tone="warn">{project.meta.busy ? 'kernel busy' : 'stale'}</Chip>}
        {hasWarnings && <Chip tone="warn">{project.error ? 'error' : `${project.warnings.length} warning(s)`}</Chip>}
        <span className="ml-auto flex items-center gap-1 text-2xs text-muted">
          {project.error ? <Dot tone="muted" /> : project.ledger.chain_ok ? <Dot tone="ok" /> : <Dot tone="danger" />}
          {project.error ? 'unavailable' : `${project.ledger.events} events`}
          <span className="opacity-60">{relativeTime(project.updatedAt)}</span>
        </span>
      </div>
      <div className="flex w-full flex-wrap items-center gap-1 pl-[18px]">
        {project.targets.length === 0 && <span className="text-2xs text-muted">no targets</span>}
        {project.targets.map(target => (
          <span key={target.id} className="flex items-center gap-1 rounded border border-border bg-bg px-1.5 py-0.5">
            <span className="font-mono text-2xs text-text">{target.id}</span>
            <StatusChip status={target.status} aligned={target.aligned} />
            <TierChip tier={target.tier} />
          </span>
        ))}
        <span className="ml-auto text-2xs text-muted">
          {project.claims.total} claim(s)
          {project.lowYield.flag ? ' · LOW_YIELD' : ''}
        </span>
      </div>
    </div>
  )
}

function EventRow({ event }: { event: any }) {
  const tone = event.verdict === 'fail' || event.verdict === 'REFUTED'
    ? 'danger'
    : event.verdict === 'pass' || event.verdict === 'VERIFIED'
      ? 'ok'
      : event.type === 'alignment_confirmed'
        ? 'ok'
        : 'muted'
  return (
    <div className="flex items-start gap-2 rounded border border-border bg-bg px-2 py-1 text-[12px]">
      <span className="w-8 shrink-0 text-right font-mono text-2xs text-muted">{event.seq}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1">
          <span className="font-medium text-text">{event.summary}</span>
          {event.verdict && <Chip tone={tone}>{event.verdict}</Chip>}
          {event.claim && <Mono>{event.claim}</Mono>}
          {event.route && <Mono>#{event.route}</Mono>}
        </span>
        {event.detail && <span className="mt-0.5 block truncate text-2xs text-muted">{event.detail}</span>}
      </span>
      <span className="shrink-0 text-2xs text-muted">{relativeTime(event.ts)}</span>
    </div>
  )
}

function ProjectDetail({ root }: { root: string }) {
  const status = useEndpoint(statusUrl({ path: root }), 8_000)
  const log = useEndpoint(logUrl({ path: root }, 30), 15_000)

  return (
    <div className="space-y-2 border-t border-border px-3 py-2">
      {status.loading && !status.data && <Spinner label="reading kernel status…" />}
      {status.error && <ErrorLine>{status.error}</ErrorLine>}
      {status.data && (
        <>
          <div className="flex flex-wrap items-center gap-1">
            <Chip tone="muted">ledger {status.data.status.ledger.events}</Chip>
            <Chip tone={status.data.status.ledger.chain_ok ? 'ok' : 'danger'}>
              {status.data.status.ledger.chain_ok ? 'chain ok' : 'chain broken'}
            </Chip>
            <Chip tone="muted">
              review {status.data.status.review_rule.passes_required}× / {status.data.status.review_rule.families_required} families
            </Chip>
            <span className="ml-auto text-2xs text-muted">read {relativeTime(status.data.meta.readAt)}</span>
          </div>
          <StatusBoard status={status.data.status} />
        </>
      )}
      <SectionTitle right={<span className="text-2xs text-muted">last 30</span>}>ledger timeline</SectionTitle>
      {log.loading && !log.data && <Spinner label="reading ledger…" />}
      {log.error && <ErrorLine>{log.error}</ErrorLine>}
      {log.data && log.data.events.length === 0 && <Empty>No ledger events yet.</Empty>}
      {log.data && log.data.events.length > 0 && (
        <div className="space-y-1">
          {[...log.data.events].reverse().map(event => <EventRow key={event.seq} event={event} />)}
        </div>
      )}
      <div className="text-2xs text-muted">
        <Mono>{root}</Mono>
      </div>
    </div>
  )
}

export function ProofOverviewPage({ onClose }: { onClose?: () => void }) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const { data, error, loading, reload } = useEndpoint(projectsUrl, 60_000)

  const projects = data?.projects ?? []
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return projects
    return projects.filter(project =>
      [project.title, project.id, project.root, ...project.targets.map(target => target.id)]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    )
  }, [projects, query])
  const counts = statusCounts(projects)

  return (
    <div className="mx-auto w-full max-w-6xl space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-semibold text-text-strong">Proof board</span>
        <Chip tone="muted">kernel-derived</Chip>
        {data?.kernel && <span className="truncate font-mono text-2xs text-muted">{shortPath(data.kernel.packageRoot, 2)}</span>}
        <button
          type="button"
          className="rounded border border-border bg-bg px-2 py-1 text-2xs text-muted hover:text-text"
          onClick={() => {
            invalidatePimatrixCache()
            reload(true)
          }}
        >
          refresh
        </button>
        <button
          type="button"
          className="rounded border border-border bg-bg px-2 py-1 text-2xs text-muted hover:text-text"
          onClick={() => {
            if (onClose) onClose()
            else goto('/chat')
          }}
        >
          close
        </button>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {Object.entries(counts).map(([status, count]) => (
            <Chip key={status} tone={status === 'proved' ? 'ok' : status === 'refuted' || status === 'disproved' ? 'danger' : status === 'open' ? 'muted' : 'warn'}>
              {status} {count}
            </Chip>
          ))}
          <Chip tone="muted">{projects.length} project(s)</Chip>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="filter projects, targets…"
          className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-[12px] text-text outline-none focus:border-accent"
        />
        <span className="shrink-0 text-2xs text-muted">roots: {data?.roots?.length ?? 0}</span>
      </div>

      {loading && !data && <Spinner label="scanning configured roots…" />}
      {error && <ErrorLine>{error}</ErrorLine>}

      {data && projects.length === 0 && (
        <Card icon="∑" title="No proof projects found" defaultOpen>
          <p className="text-[12px] text-muted">
            The board scans <Mono>pimatrix.roots</Mono> in <Mono>~/.pi/dashboard.json</Mono>, the Repos registry and
            running chat slots. Add a proof repository to <Mono>repos</Mono>, set <Mono>pimatrix.roots</Mono>, or open a
            chat slot whose working directory contains <Mono>pimatrix.json</Mono>.
          </p>
          <Pre>{JSON.stringify({ roots: data.roots, kernel: data.kernel }, null, 2)}</Pre>
        </Card>
      )}

      <div className="space-y-1.5">
        {filtered.map(project => (
          <div key={project.root} className="overflow-hidden rounded-lg border border-border bg-card">
            <ProjectRow
              project={project}
              expanded={selected === project.root}
              onToggle={() => setSelected(current => (current === project.root ? null : project.root))}
            />
            {project.error && <div className="px-3 pb-2"><ErrorLine>{project.error}</ErrorLine></div>}
            {selected === project.root && <ProjectDetail root={project.root} />}
          </div>
        ))}
      </div>

      {data && projects.length > 0 && filtered.length === 0 && <Empty>No projects match “{query}”.</Empty>}
      {data && data.projects.some(project => project.meta?.stale) && (
        <p className="text-2xs text-muted">
          Some rows reuse a cached status because the kernel was busy (a certificate replay or audit holds the ledger
          transaction). Expand the row to retry.
        </p>
      )}
    </div>
  )
}
