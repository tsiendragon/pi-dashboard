// @ts-nocheck — Plugin files are bundled by Vite, not type-checked by the frontend tsc config.
/**
 * Renderers for the two custom message types the pi-matrix extension injects
 * (`pimatrix-status`, `pimatrix-check`). The status text is a compact projection
 * of the ledger; the full board stays one click away.
 */
import { useMemo, useState } from 'react'
import { goto } from './api'
import { Card, Chip, Dot, Pre, SectionTitle, StatusChip, Warnings, statusLabel, statusTone } from './ui'

interface ParsedTarget {
  id: string
  status: string
  aligned: boolean
  statement: string
  basis?: string
  frontier: { claim: string; action: string }[]
}

interface ParsedStatus {
  project: string
  events?: number
  targets: ParsedTarget[]
  tiers?: string
  lowYield?: string
  warnings: string[]
  other: string[]
}

const TARGET_RE = /^TARGET\s+(\S+):\s+([A-Z]+)\s*(.*)$/
const FRONTIER_RE = /^\s{2}open:\s+(\S+)\s+—\s+(.*)$/
const REST_RE = /^\s{2}rests on:\s+(.*)$/
const WARNING_RE = /^warning:\s+(.*)$/
const LOW_YIELD_RE = /^LOW_YIELD:\s+(.*)$/
const TIERS_RE = /^claims by tier:\s+(.*)$/
const HEADER_RE = /^pi-matrix status\s+—\s+(.*?)\s+\(ledger:\s+(\d+)\s+events?\)/

export function parseStatusText(text: string): ParsedStatus {
  const parsed: ParsedStatus = { project: 'pi-matrix', targets: [], warnings: [], other: [] }
  let current: ParsedTarget | null = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line.trim()) continue
    const header = HEADER_RE.exec(line)
    if (header) {
      parsed.project = header[1]
      parsed.events = Number(header[2])
      continue
    }
    const target = TARGET_RE.exec(line)
    if (target) {
      let rest = target[3] || ''
      const aligned = !/\[alignment unconfirmed\]/.test(rest)
      rest = rest.replace(/\[alignment unconfirmed\]/, '').trim()
      const dash = rest.indexOf('—')
      const statement = dash >= 0 ? rest.slice(dash + 1).trim() : rest
      current = { id: target[1], status: target[2].toLowerCase(), aligned, statement, frontier: [] }
      parsed.targets.push(current)
      continue
    }
    const frontier = FRONTIER_RE.exec(line)
    if (frontier && current) {
      current.frontier.push({ claim: frontier[1], action: frontier[2] })
      continue
    }
    const rests = REST_RE.exec(line)
    if (rests && current) {
      current.basis = rests[1]
      continue
    }
    const warning = WARNING_RE.exec(line)
    if (warning) {
      parsed.warnings.push(warning[1])
      continue
    }
    const low = LOW_YIELD_RE.exec(line)
    if (low) {
      parsed.lowYield = low[1]
      continue
    }
    const tiers = TIERS_RE.exec(line)
    if (tiers) {
      parsed.tiers = tiers[1]
      continue
    }
    if (!line.startsWith('  ')) parsed.other.push(line)
  }
  return parsed
}

export function PimatrixStatusMessage({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false)
  const parsed = useMemo(() => parseStatusText(content), [content])
  const hasStructure = parsed.targets.length > 0

  if (!hasStructure) {
    return (
      <Card icon="∑" title="pi-matrix" subtitle="ledger status" defaultOpen={false} badge={<Chip tone="muted">status</Chip>}>
        <Pre>{content}</Pre>
      </Card>
    )
  }

  return (
    <Card
      icon="∑"
      title={parsed.project}
      subtitle={parsed.events !== undefined ? `${parsed.events} ledger events` : 'ledger status'}
      badge={
        <>
          {parsed.lowYield && <Chip tone="warn">LOW_YIELD</Chip>}
          {parsed.warnings.length > 0 && <Chip tone="warn">{parsed.warnings.length} warning(s)</Chip>}
          <Chip tone="muted">kernel-derived</Chip>
        </>
      }
      defaultOpen={false}
    >
      {parsed.targets.map(target => (
        <div key={target.id} className="rounded border border-border bg-bg px-2 py-1.5">
          <div className="flex flex-wrap items-center gap-1">
            <Dot tone={statusTone(target.status)} />
            <span className="font-mono text-[12px] font-semibold text-text">{target.id}</span>
            <StatusChip status={target.status} aligned={target.aligned} />
            {target.frontier.length > 0 && <Chip tone="warn">{target.frontier.length} open</Chip>}
          </div>
          <p className="mt-1 text-[12px] text-muted">{target.statement || statusLabel(target.status)}</p>
          {target.basis && <p className="mt-0.5 text-2xs text-muted">{target.basis}</p>}
          {target.frontier.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {target.frontier.slice(0, 4).map(item => (
                <li key={item.claim} className="text-2xs text-muted">
                  <span className="font-mono text-text">{item.claim}</span> — {item.action}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {parsed.tiers && (
        <div className="text-2xs text-muted">
          <SectionTitle>claims by tier</SectionTitle>
          {parsed.tiers}
        </div>
      )}
      <Warnings warnings={parsed.warnings} />
      {parsed.lowYield && <p className="rounded border border-warn/20 bg-warn-subtle px-2 py-1 text-[12px] text-warn">LOW_YIELD: {parsed.lowYield}</p>}
      {parsed.other.length > 0 && (
        <div>
          <SectionTitle>other status lines</SectionTitle>
          <Pre maxHeight="8rem">{parsed.other.join('\n')}</Pre>
        </div>
      )}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => goto('/plugin/proof')}
          className="rounded border border-accent/40 bg-accent-subtle px-2 py-1 text-2xs font-medium text-accent hover:brightness-110"
        >
          Open proof board
        </button>
        <button type="button" onClick={() => setExpanded(value => !value)} className="text-2xs text-muted hover:text-text">
          {expanded ? 'hide raw status' : 'raw status'}
        </button>
      </div>
      {expanded && <Pre>{content}</Pre>}
    </Card>
  )
}

export function PimatrixCheckMessage({ content }: { content: string }) {
  return (
    <div className="rounded-lg border border-danger/40 bg-danger-subtle px-3 py-2 animate-scale-in">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-danger">
        <span>⚠</span>
        <span>Ledger check — the prose and the ledger disagree</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-[12px] text-text">{content}</p>
    </div>
  )
}
