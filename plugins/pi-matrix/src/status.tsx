// @ts-nocheck — Plugin files are bundled by Vite, not type-checked by the frontend tsc config.
/** Kernel-derived status views: targets, claims, routes, warnings. */
import { useMemo, useState } from 'react'
import type {
  PimatrixClaim,
  PimatrixReviewRule,
  PimatrixRoute,
  PimatrixStatus,
  PimatrixTarget,
} from '@shared/pimatrix'
import {
  Card,
  Chip,
  Dot,
  Empty,
  Mono,
  Progress,
  SectionTitle,
  Statement,
  StatusChip,
  TierChip,
  Warnings,
} from './ui'

export function LedgerChips({ status }: { status: PimatrixStatus }) {
  const chain = status.ledger?.chain_ok
  const tone = chain === true ? 'ok' : chain === false ? 'danger' : 'muted'
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Chip tone={tone} title={chain === true ? 'hash chain verified' : chain === false ? 'hash chain broken' : 'chain state not reported'}>
        <Dot tone={tone} /> ledger {status.ledger?.events ?? 0}
      </Chip>
      {status.low_yield?.flag && <Chip tone="warn" title={status.low_yield.events_since_progress + ' work events without progress'}>LOW_YIELD</Chip>}
      {status.review_rule && (
        <Chip tone="muted" title="reviews required per route">
          review {status.review_rule.passes_required}× / {status.review_rule.families_required} families
        </Chip>
      )}
    </span>
  )
}

function routeChips(route: PimatrixRoute) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Mono>{route.route}</Mono>
      {route.reviewed && <Chip tone="warn">reviewed</Chip>}
      {route.stale && <Chip tone="warn">stale</Chip>}
      {!route.live && route.dead_reason && <Chip tone="danger" title={route.dead_reason}>dead</Chip>}
      {!route.integrity_ok && <Chip tone="danger">integrity</Chip>}
      {route.families?.length > 0 && <Chip tone="muted">{route.families.join(', ')}</Chip>}
    </span>
  )
}

export function RouteTable({ claim, rule }: { claim: PimatrixClaim; rule?: PimatrixReviewRule }) {
  if (!claim.routes?.length) return <Empty>No proof routes yet.</Empty>
  return (
    <div className="space-y-1.5">
      {claim.routes.map(route => (
        <div key={route.route} className="rounded border border-border bg-bg px-2 py-1.5">
          <div className="flex flex-wrap items-center gap-1">
            {routeChips(route)}
            <span className="ml-auto flex items-center gap-2">
              {rule?.passes_required ? (
                <Progress
                  value={route.passes ?? 0}
                  max={rule.passes_required}
                  tone={route.reviewed ? 'warn' : 'muted'}
                  label={`${route.passes ?? 0}✓`}
                />
              ) : null}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-muted">
            <span>{route.path}</span>
            {route.uses?.length > 0 && <span>uses {route.uses.join(', ')}</span>}
            <span>{route.reviews ?? 0} review(s)</span>
            {route.dead_reason && <span className="text-danger">{route.dead_reason}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

function BasisCounts({ target }: { target: PimatrixTarget }) {
  const basis = target.basis
  if (!basis) return null
  return (
    <div className="flex flex-wrap gap-1">
      <Chip tone="warn" title="LLM-reviewed steps are candidate evidence, not machine verification">
        {basis.reviewed?.length ?? 0} reviewed step(s)
      </Chip>
      <Chip tone="accent">{basis.certified?.length ?? 0} certificate(s)</Chip>
      <Chip tone="muted">{basis.cited?.length ?? 0} citation(s)</Chip>
    </div>
  )
}

export function TargetCard({ target, rule, defaultOpen = false }: { target: PimatrixTarget; rule?: PimatrixReviewRule; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const hasFrontier = !!target.frontier?.length
  return (
    <div className="rounded border border-border bg-bg">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        className="flex w-full items-start gap-2 px-2 py-1.5 text-left"
        aria-expanded={open}
      >
        <span className="mt-0.5 w-3 shrink-0 text-2xs text-muted">{open ? '▾' : '▸'}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1">
            <span className="font-mono text-[12px] font-semibold text-text">{target.id}</span>
            <StatusChip status={target.status} aligned={target.aligned} />
            <TierChip tier={target.tier} />
            {target.refines && <Chip tone="muted">refines {target.refines}</Chip>}
          </span>
          <span className="mt-1 block truncate text-[12px] text-muted">{target.statement}</span>
        </span>
        {hasFrontier && <Chip tone="warn">{target.frontier.length} open</Chip>}
      </button>
      {open && (
        <div className="space-y-2 border-t border-border px-2 py-2">
          <Statement text={target.statement} />
          <BasisCounts target={target} />
          {hasFrontier && (
            <div>
              <SectionTitle>frontier</SectionTitle>
              <ul className="mt-1 space-y-1">
                {target.frontier.map(item => (
                  <li key={item.claim} className="flex gap-2 text-[12px]">
                    <Mono>{item.claim}</Mono>
                    <span className="min-w-0 break-words text-muted">{item.action}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ClaimsList({ claims, rule }: { claims: PimatrixClaim[]; rule?: PimatrixReviewRule }) {
  const [query, setQuery] = useState('')
  const [onlyOpen, setOnlyOpen] = useState(false)
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return claims.filter(claim => {
      if (onlyOpen && claim.closed) return false
      if (!needle) return true
      return claim.id.toLowerCase().includes(needle)
        || (claim.tier || '').toLowerCase().includes(needle)
        || (claim.statement || '').toLowerCase().includes(needle)
    })
  }, [claims, query, onlyOpen])

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="filter claims…"
          className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-[12px] text-text outline-none focus:border-accent"
        />
        <label className="flex shrink-0 items-center gap-1 text-2xs text-muted">
          <input type="checkbox" checked={onlyOpen} onChange={event => setOnlyOpen(event.target.checked)} />
          open only
        </label>
        <span className="shrink-0 text-2xs text-muted">{filtered.length}/{claims.length}</span>
      </div>
      {filtered.length === 0 && <Empty>No claims match.</Empty>}
      {filtered.map(claim => (
        <details key={claim.id} className="rounded border border-border bg-bg">
          <summary className="flex cursor-pointer flex-wrap items-center gap-1 px-2 py-1.5">
            <span className="font-mono text-[12px] font-semibold text-text">{claim.id}</span>
            <Chip tone="muted">{claim.kind}</Chip>
            <TierChip tier={claim.tier} />
            {claim.closed && <Chip tone="ok">closed</Chip>}
            {claim.has_formal && <Chip tone="accent">formal</Chip>}
            {claim.cycle && <Chip tone="danger">cycle</Chip>}
            {claim.flags?.map(flag => <Chip key={flag} tone="warn">{flag}</Chip>)}
            <span className="ml-auto text-2xs text-muted">{claim.routes?.length ?? 0} route(s)</span>
          </summary>
          <div className="space-y-2 border-t border-border px-2 py-2">
            <Statement text={claim.statement} />
            <RouteTable claim={claim} rule={rule} />
          </div>
        </details>
      ))}
    </div>
  )
}

export function StatusBoard({ status, compact = false }: { status: PimatrixStatus; compact?: boolean }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[13px] font-semibold text-text-strong">{status.project}</span>
        <LedgerChips status={status} />
      </div>
      <Warnings warnings={status.warnings} />
      {status.targets?.length === 0 && <Empty>No targets registered yet.</Empty>}
      {status.targets?.map(target => (
        <TargetCard key={target.id} target={target} rule={status.review_rule} defaultOpen={status.targets.length === 1} />
      ))}
      {!compact && (
        <>
          <SectionTitle right={<span className="text-2xs text-muted">{status.claims?.length ?? 0} claim(s)</span>}>
            claims
          </SectionTitle>
          <ClaimsList claims={status.claims ?? []} rule={status.review_rule} />
        </>
      )}
      {status.ledger?.head && (
        <div className="flex items-center gap-1 text-2xs text-muted">
          <span>ledger head</span>
          <Mono>{status.ledger.head.slice(0, 26)}…</Mono>
        </div>
      )}
    </div>
  )
}

export function StatusSummaryCard({ status }: { status: PimatrixStatus }) {
  return (
    <Card icon="∑" title={status.project} subtitle={`${status.ledger?.events ?? 0} ledger events`} badge={<LedgerChips status={status} />}>
      <StatusBoard status={status} compact />
    </Card>
  )
}
