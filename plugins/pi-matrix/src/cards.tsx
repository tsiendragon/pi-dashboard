// @ts-nocheck — Plugin files are bundled by Vite, not type-checked by the frontend tsc config.
/**
 * Rich renderers for every `proof_*` tool.
 *
 * The cards never decide whether a claim is proved. They show the tool's own
 * output plus, where useful, the current kernel-derived status fetched through
 * `/api/pimatrix/status?slot=…`.
 */
import { useEffect, useRef, useState } from 'react'
import type { PimatrixClaim, PimatrixRoute, PimatrixSolverRun } from '@shared/pimatrix'
import { solverUrl, statusUrl, useEndpoint } from './api'
import { LedgerChips, StatusBoard } from './status'
import {
  Card,
  Chip,
  CopyButton,
  Empty,
  ErrorLine,
  KeyValue,
  Mono,
  Pre,
  Progress,
  SectionTitle,
  Spinner,
  Statement,
} from './ui'

interface ToolProps {
  toolName: string
  toolInput: Record<string, unknown>
  toolResult?: string
  partialResult?: { content?: { type?: string; text?: string }[]; details?: Record<string, unknown> }
  isRunning?: boolean
  isError?: boolean
  sessionId: string
}

function partialText(props: ToolProps): string {
  return (props.partialResult?.content ?? [])
    .map(part => (part?.type === 'text' ? part.text ?? '' : ''))
    .join('\n')
    .trim()
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? fallback : String(value)
}

function useStatus(sessionId: string, version = 0, force = false) {
  const url = sessionId ? `${statusUrl({ slot: sessionId }, force || version > 0)}&v=${version}` : null
  const { data, error, reload } = useEndpoint(url, 0)
  return { status: data?.status, meta: data?.meta, error, reload }
}

function verdictTone(verdict: string): 'ok' | 'danger' | 'warn' | 'muted' {
  if (verdict === 'VERIFIED' || verdict === 'PASS' || verdict === 'QUOTE-VERIFIED') return 'ok'
  if (verdict === 'REFUTED' || verdict === 'FAIL' || verdict === 'QUOTE-NOT-FOUND') return 'danger'
  if (verdict === 'WITNESS-UNCERTIFIED') return 'warn'
  return 'muted'
}

function ToolCard({
  icon,
  title,
  subtitle,
  isError,
  badge,
  defaultOpen = true,
  children,
}: {
  icon: string
  title: string
  subtitle?: string
  isError?: boolean
  badge?: React.ReactNode
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  return (
    <Card
      icon={icon}
      title={title}
      subtitle={subtitle}
      defaultOpen={defaultOpen}
      badge={
        <>
          {isError && <Chip tone="danger">error</Chip>}
          {badge}
        </>
      }
    >
      {children}
    </Card>
  )
}

// ── proof_status ─────────────────────────────────────────────────────────────

export function ProofStatusRenderer(props: ToolProps) {
  const { status, meta, error } = useStatus(props.sessionId, 0, true)
  if (status) {
    return (
      <Card
        icon="∑"
        title={status.project}
        subtitle={meta?.readAt ? `read ${new Date(meta.readAt).toLocaleTimeString()}` : undefined}
        badge={<LedgerChips status={status} />}
      >
        <StatusBoard status={status} />
        {props.isError && props.toolResult && <ErrorLine>{props.toolResult}</ErrorLine>}
        {meta?.stale && <Chip tone="warn" title={meta.error}>stale{meta.busy ? ' · kernel busy' : ''}</Chip>}
      </Card>
    )
  }
  return (
    <ToolCard icon="∑" title="Proof status" isError={props.isError || !!error}>
      {props.isRunning ? <Spinner label="deriving ledger status…" /> : null}
      {error && <ErrorLine>{error}</ErrorLine>}
      {props.toolResult ? <Pre>{props.toolResult}</Pre> : !props.isRunning && <Empty>No status available.</Empty>}
    </ToolCard>
  )
}

// ── proof_claim ──────────────────────────────────────────────────────────────

export function ProofClaimRenderer(props: ToolProps) {
  const id = str(props.toolInput.id, '?')
  const kind = str(props.toolInput.kind, 'claim')
  const formal = props.toolInput.formal
  return (
    <ToolCard
      icon="＋"
      title={`${kind} ${id}`}
      isError={props.isError}
      badge={
        <>
          <Chip tone="muted">{kind}</Chip>
          {formal ? <Chip tone="accent">formal</Chip> : null}
          {props.toolInput.refines ? <Chip tone="muted">refines {str(props.toolInput.refines)}</Chip> : null}
        </>
      }
    >
      <Statement text={str(props.toolInput.statement)} />
      {props.toolInput.note ? <KeyValue label="note">{str(props.toolInput.note)}</KeyValue> : null}
      {props.toolResult && <Pre>{props.toolResult}</Pre>}
    </ToolCard>
  )
}

// ── proof_submit ─────────────────────────────────────────────────────────────

export function ProofSubmitRenderer(props: ToolProps) {
  const claim = str(props.toolInput.claim, '?')
  const route = str(props.toolInput.route, '?')
  const file = str(props.toolInput.path)
  const completeness = str(props.toolInput.completeness, '')
  return (
    <ToolCard
      icon="≣"
      title={`submit ${claim}#${route}`}
      isError={props.isError}
      badge={completeness ? <Chip tone={completeness === 'complete' ? 'ok' : 'warn'}>{completeness}</Chip> : null}
    >
      {file && (
        <div className="flex items-center gap-2">
          <Mono>{file}</Mono>
          <CopyButton value={file} />
        </div>
      )}
      {props.toolResult ? <Pre>{props.toolResult}</Pre> : <Empty>No submission recorded yet.</Empty>}
    </ToolCard>
  )
}

// ── proof_prove / reviser ────────────────────────────────────────────────────

export function ProofProveRenderer(props: ToolProps) {
  const claim = str(props.toolInput.claim, '?')
  const mode = str(props.toolInput.mode, 'prove')
  const route = str(props.toolInput.route, '')
  const live = partialText(props)
  return (
    <ToolCard
      icon="✎"
      title={`${mode === 'revise' ? 'reviser' : 'prover'} · ${claim}${route ? `#${route}` : ''}`}
      isError={props.isError}
      defaultOpen={!!props.isRunning}
      badge={props.isRunning ? <Chip tone="accent">running</Chip> : null}
    >
      {props.isRunning && <Spinner label="independent model writing a proof (this takes minutes)" />}
      {props.toolInput.guidance ? <KeyValue label="guidance">{str(props.toolInput.guidance)}</KeyValue> : null}
      {live && <Pre maxHeight="10rem">{live}</Pre>}
      {props.toolResult && <Pre maxHeight="16rem">{props.toolResult}</Pre>}
      {!props.isRunning && !props.toolResult && <Empty>No output yet.</Empty>}
      <p className="text-2xs text-muted">The proof is a draft until independent reviews pass; reviews are candidate evidence, not machine verification.</p>
    </ToolCard>
  )
}

// ── proof_review ─────────────────────────────────────────────────────────────

function ReviewProgress({ claim, route, sessionId, version }: { claim: string; route: string; sessionId: string; version: number }) {
  const { status } = useStatus(sessionId, version)
  const rule = status?.review_rule
  const info: PimatrixRoute | undefined = status?.claims
    ?.find((entry: PimatrixClaim) => entry.id === claim)
    ?.routes?.find((entry: PimatrixRoute) => entry.route === route)
  if (!info || !rule) return null
  return (
    <div className="space-y-1 rounded border border-border bg-bg px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <Mono>{claim}#{route}</Mono>
        {info.reviewed ? <Chip tone="warn">reviewed (candidate)</Chip> : <Chip tone="muted">not reviewed</Chip>}
        {info.stale && <Chip tone="warn">stale</Chip>}
        {!info.live && info.dead_reason && <Chip tone="danger">dead</Chip>}
      </div>
      <Progress value={info.passes ?? 0} max={rule.passes_required || 1} tone={info.reviewed ? 'warn' : 'muted'} label={`${info.passes ?? 0}/${rule.passes_required} passes`} />
      <Progress value={info.families?.length ?? 0} max={rule.families_required || 1} tone="accent" label={`${info.families?.length ?? 0}/${rule.families_required} families`} />
      {info.families?.length > 0 && <p className="text-2xs text-muted">families: {info.families.join(', ')}</p>}
    </div>
  )
}

export function ProofReviewRenderer(props: ToolProps) {
  const claim = str(props.toolInput.claim, '?')
  const route = str(props.toolInput.route, '?')
  const [version, setVersion] = useState(0)
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && !props.isRunning) setVersion(value => value + 1)
    wasRunning.current = !!props.isRunning
  }, [props.isRunning])
  const text = props.toolResult ?? ''
  const lines = text.split('\n')
  const reviewerLines = lines.filter(line => /^- reviewer \d+/.test(line))
  const otherLines = lines.filter(line => line.trim() && !/^- reviewer \d+/.test(line) && !/^\s{4}•/.test(line))
  const findings = lines.filter(line => /^\s{2,}•/.test(line))
  return (
    <ToolCard
      icon="⚖"
      title={`review ${claim}#${route}`}
      isError={props.isError}
      defaultOpen={!!props.isRunning}
      badge={
        <>
          {props.toolInput.reviewers ? <Chip tone="muted">{str(props.toolInput.reviewers)} requested</Chip> : null}
          {props.isRunning ? <Chip tone="accent">running</Chip> : null}
        </>
      }
    >
      {props.isRunning && <Spinner label="independent reviewers checking the proof (this takes minutes)" />}
      <ReviewProgress claim={claim} route={route} sessionId={props.sessionId} version={version} />
      {reviewerLines.length > 0 && (
        <div className="space-y-1">
          {reviewerLines.map((line, index) => {
            const dismissed = /dismissed by meta-review/i.test(line)
            const pass = !dismissed && /:\s*(PASS|VERIFIED)/i.test(line)
            const fail = !dismissed && /:\s*(FAIL|REFUTED)/i.test(line)
            return (
              <div key={index} className={`rounded border px-2 py-1 text-[12px] ${fail ? 'border-danger/30 bg-danger-subtle text-danger' : pass ? 'border-ok/30 bg-ok-subtle text-ok' : 'border-border bg-bg text-muted'}`}>
                {line.replace(/^- /, '')}
              </div>
            )
          })}
        </div>
      )}
      {findings.length > 0 && (
        <details>
          <summary className="cursor-pointer text-2xs text-muted">{findings.length} finding(s)</summary>
          <Pre maxHeight="14rem">{findings.join('\n')}</Pre>
        </details>
      )}
      {otherLines.length > 0 && <Pre maxHeight="10rem">{otherLines.join('\n')}</Pre>}
      {!text && !props.isRunning && <Empty>No review output yet.</Empty>}
    </ToolCard>
  )
}

// ── proof_certify ────────────────────────────────────────────────────────────

export function ProofCertifyRenderer(props: ToolProps) {
  const claim = str(props.toolInput.claim, '?')
  const adapter = str(props.toolInput.adapter, '?')
  const artifact = str(props.toolInput.artifact, '')
  const text = props.toolResult ?? ''
  const verdict = /(VERIFIED|REFUTED|WITNESS-UNCERTIFIED|INCONCLUSIVE)/.exec(text)?.[1] ?? ''
  return (
    <ToolCard
      icon="◈"
      title={`certify ${claim}`}
      isError={props.isError}
      badge={
        <>
          <Chip tone="muted">{adapter}</Chip>
          {verdict && <Chip tone={verdictTone(verdict)}>{verdict}</Chip>}
        </>
      }
    >
      {artifact && (
        <div className="flex items-center gap-2">
          <Mono>{artifact}</Mono>
          <CopyButton value={artifact} />
        </div>
      )}
      {text ? <Pre maxHeight="14rem">{text}</Pre> : <Empty>No verdict yet.</Empty>}
      <p className="text-2xs text-muted">Only a registered checker can certify; a verified certificate still needs human alignment before the target is <span className="font-mono">proved</span>.</p>
    </ToolCard>
  )
}

// ── proof_audit ──────────────────────────────────────────────────────────────

export function ProofAuditRenderer(props: ToolProps) {
  const text = props.toolResult ?? ''
  const failed = /AUDIT FAILED/i.test(text)
  const problems = text.split('\n').filter(line => /^-\s*problem:/i.test(line)).map(line => line.replace(/^-\s*problem:\s*/i, ''))
  const notes = text.split('\n').filter(line => /^-\s*note:/i.test(line)).map(line => line.replace(/^-\s*note:\s*/i, ''))
  return (
    <ToolCard
      icon="⛓"
      title="ledger audit"
      isError={props.isError || failed}
      badge={
        <Chip tone={failed || props.isError ? 'danger' : text ? 'ok' : 'muted'}>
          {failed ? 'FAILED' : props.isError ? 'error' : text ? 'passed' : '—'}
        </Chip>
      }
    >
      {problems.length > 0 && (
        <ul className="space-y-1">
          {problems.map((problem, index) => (
            <li key={index} className="rounded border border-danger/30 bg-danger-subtle px-2 py-1 text-[12px] text-danger">{problem}</li>
          ))}
        </ul>
      )}
      {notes.length > 0 && (
        <ul className="space-y-1">
          {notes.map((note, index) => (
            <li key={index} className="rounded border border-warn/20 bg-warn-subtle px-2 py-1 text-[12px] text-warn">{note}</li>
          ))}
        </ul>
      )}
      {!problems.length && !notes.length && <Pre maxHeight="10rem">{text || 'No audit output.'}</Pre>}
    </ToolCard>
  )
}

// ── solver ───────────────────────────────────────────────────────────────────

const PHASE_TONE: Record<string, 'muted' | 'accent' | 'warn' | 'danger' | 'ok'> = {
  preflight: 'muted',
  searching: 'accent',
  certifying: 'accent',
  composing: 'accent',
  completed: 'ok',
  blocked: 'warn',
  budget_exhausted: 'warn',
  cancelled: 'muted',
  failed: 'danger',
}

function usedNumber(run: PimatrixSolverRun, key: string): number {
  const value = run.used?.[key]
  return typeof value === 'number' ? value : 0
}

function budgetNumber(run: PimatrixSolverRun, key: string): number {
  const value = run.budget?.[key]
  return typeof value === 'number' ? value : 0
}

export function SolverView({ sessionId, runId }: { sessionId: string; runId: string }) {
  const { data, error, loading } = useEndpoint(sessionId ? solverUrl({ slot: sessionId }, runId) : null, 0)
  if (loading && !data) return <Spinner label={`loading solver run ${runId}…`} />
  if (error) return <ErrorLine>{error}</ErrorLine>
  const run = data?.run
  if (!run) return <Empty>No solver record.</Empty>
  const modelMax = budgetNumber(run, 'max_model_runs')
  const feedbackMax = budgetNumber(run, 'max_feedback_checks')
  return (
    <div className="space-y-1 rounded border border-border bg-bg px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <Mono>{run.id}</Mono>
        <Chip tone={PHASE_TONE[run.phase] ?? 'muted'}>{run.phase}</Chip>
        <Chip tone="muted">{run.claim}</Chip>
        {run.stop_reason && <Chip tone="warn">{run.stop_reason}</Chip>}
        {run.audit_status && <Chip tone="muted">audit {run.audit_status}</Chip>}
      </div>
      {modelMax > 0 && <Progress value={usedNumber(run, 'model')} max={modelMax} label={`model ${usedNumber(run, 'model')}/${modelMax}`} />}
      {feedbackMax > 0 && <Progress value={usedNumber(run, 'feedback')} max={feedbackMax} tone="muted" label={`feedback ${usedNumber(run, 'feedback')}/${feedbackMax}`} />}
      <div className="flex flex-wrap gap-2 text-2xs text-muted">
        {run.operations !== undefined && <span>{run.operations} operation(s)</span>}
        {run.remaining_obligations?.length ? <span>{run.remaining_obligations.length} remaining obligation(s)</span> : null}
        {run.certificate?.verdict && <Chip tone={verdictTone(run.certificate.verdict)}>{run.certificate.adapter}: {run.certificate.verdict}</Chip>}
        {run.candidate?.path && <span className="font-mono">{run.candidate.path}</span>}
      </div>
      {run.certificate?.detail && <p className="text-2xs text-muted">{run.certificate.detail}</p>}
    </div>
  )
}

export function ProofSolveRenderer(props: ToolProps) {
  const claim = str(props.toolInput.claim, '?')
  const text = `${props.toolResult ?? ''}\n${partialText(props)}`
  const runId = /(?:^|\s)Run\s+(s[A-Za-z0-9._-]+)/.exec(text)?.[1] ?? str(props.toolInput.resume, '')
  return (
    <ToolCard
      icon="▷"
      title={`solve ${claim}`}
      isError={props.isError}
      defaultOpen={!!props.isRunning}
      badge={props.isRunning ? <Chip tone="accent">running</Chip> : null}
    >
      {props.isRunning && <Spinner label={partialText(props) || 'bounded formal solver running…'} />}
      {runId && props.sessionId && <SolverView sessionId={props.sessionId} runId={runId} />}
      {props.toolResult && <Pre maxHeight="14rem">{props.toolResult}</Pre>}
      {!props.toolResult && !props.isRunning && <Empty>No solver output yet.</Empty>}
      <p className="text-2xs text-muted">Execution status is not a mathematical verdict; only the checker certificate counts.</p>
    </ToolCard>
  )
}

export function ProofSolveStatusRenderer(props: ToolProps) {
  const runId = str(props.toolInput.run, '')
  return (
    <ToolCard icon="▷" title={`solver run ${runId || '?'}`} isError={props.isError} badge={<Chip tone="muted">checkpoint</Chip>}>
      {runId && props.sessionId && <SolverView sessionId={props.sessionId} runId={runId} />}
      {props.toolResult && <Pre maxHeight="12rem">{props.toolResult}</Pre>}
      <p className="text-2xs text-muted">A timestamped checkpoint, not a fresh audit.</p>
    </ToolCard>
  )
}

// ── lean exploration ─────────────────────────────────────────────────────────

export function ProofLeanRenderer(props: ToolProps) {
  const claim = str(props.toolInput.claim, '?')
  const source = str(props.toolInput.source)
  const query = str(props.toolInput.query)
  const action = props.toolName === 'proof_lean_search' ? 'lean search' : 'lean check'
  return (
    <ToolCard
      icon="Λ"
      title={`${action} ${claim}`}
      isError={props.isError}
      defaultOpen={!!props.isError}
      badge={<Chip tone="warn">exploration</Chip>}
    >
      {source && (
        <div className="flex items-center gap-2">
          <Mono>{source}</Mono>
          <CopyButton value={source} />
        </div>
      )}
      {query && <KeyValue label="query">{query}</KeyValue>}
      {props.toolResult ? <Pre maxHeight="24rem" tone={props.isError ? 'danger' : 'muted'}>{props.toolResult}</Pre> : <Empty>No compiler output.</Empty>}
      <p className="text-2xs text-muted">Compilation and search are not certification: neither records evidence nor changes a tier.</p>
    </ToolCard>
  )
}

// ── search (counterexample / SOS) ────────────────────────────────────────────

const OUTCOME_TONE: Record<string, 'muted' | 'warn' | 'danger' | 'accent' | 'ok'> = {
  abandoned: 'warn',
  refuted_route: 'danger',
  blocked: 'warn',
  numerical_evidence: 'muted',
  literature_negative: 'muted',
  note: 'muted',
}

export function ProofSearchRenderer(props: ToolProps) {
  const claim = str(props.toolInput.claim, '?')
  const isSos = props.toolName === 'proof_sos_search'
  const artifact = str(props.toolInput.out, '')
  return (
    <ToolCard
      icon={isSos ? '≋' : '⌕'}
      title={`${isSos ? 'SOS search' : 'counterexample search'} ${claim}`}
      isError={props.isError}
      badge={<Chip tone="warn">{isSos ? 'candidate only' : 'search only'}</Chip>}
    >
      <div className="flex flex-wrap gap-1">
        {props.toolInput.half_degree ? <Chip tone="muted">half-degree {str(props.toolInput.half_degree)}</Chip> : null}
        {props.toolInput.budget ? <Chip tone="muted">budget {str(props.toolInput.budget)}</Chip> : null}
        {props.toolInput.denominator ? <Chip tone="muted">denominator {str(props.toolInput.denominator)}</Chip> : null}
        {artifact && <Chip tone="muted">{artifact}</Chip>}
      </div>
      {props.toolResult ? <Pre maxHeight="18rem">{props.toolResult}</Pre> : <Empty>No search output.</Empty>}
      <p className="text-2xs text-muted">
        {isSos
          ? 'A candidate artifact is not evidence; run proof_certify with sos-rational.'
          : 'A hit is an unrecorded artifact; certify it with exact-witness. A failed search proves nothing.'}
      </p>
    </ToolCard>
  )
}

// ── citations ────────────────────────────────────────────────────────────────

export function ProofCiteRenderer(props: ToolProps) {
  const claim = str(props.toolInput.claim, '?')
  const source = str(props.toolInput.source)
  const locator = str(props.toolInput.locator)
  const quote = str(props.toolInput.quote)
  const map = Array.isArray(props.toolInput.hypothesis_map) ? props.toolInput.hypothesis_map : []
  return (
    <ToolCard icon="❝" title={`citation for ${claim}`} isError={props.isError} badge={<Chip tone="warn">candidate</Chip>}>
      <KeyValue label="source">{source || '—'}</KeyValue>
      <KeyValue label="locator">{locator || '—'}</KeyValue>
      {quote && <blockquote className="rounded border-l-2 border-accent/40 bg-bg px-2 py-1 text-[12px] italic text-text">{quote}</blockquote>}
      {map.length > 0 && (
        <div>
          <SectionTitle>hypothesis map</SectionTitle>
          <div className="mt-1 space-y-1">
            {map.map((row: any, index: number) => (
              <div key={index} className="rounded border border-border bg-bg px-2 py-1 text-2xs">
                <div className="text-text">{str(row?.source_hypothesis)}</div>
                <div className="text-muted">↳ {str(row?.our_condition)} — {str(row?.why_it_holds)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {props.toolResult && <Pre maxHeight="8rem">{props.toolResult}</Pre>}
      <p className="text-2xs text-muted">Quotation checking does not check applicability; a citation cannot produce PROVED.</p>
    </ToolCard>
  )
}

export function ProofCiteCheckRenderer(props: ToolProps) {
  const claim = str(props.toolInput.claim, '?')
  const text = props.toolResult ?? ''
  const verdict = /(QUOTE-VERIFIED|QUOTE-NOT-FOUND)/.exec(text)?.[1] ?? ''
  return (
    <ToolCard
      icon="✓"
      title={`quote check ${claim}`}
      isError={props.isError}
      badge={verdict ? <Chip tone={verdictTone(verdict)}>{verdict}</Chip> : null}
    >
      {props.toolInput.url ? <KeyValue label="url">{str(props.toolInput.url)}</KeyValue> : null}
      {props.toolInput.source ? <KeyValue label="source">{str(props.toolInput.source)}</KeyValue> : null}
      {text ? <Pre maxHeight="14rem">{text}</Pre> : <Empty>No check result.</Empty>}
    </ToolCard>
  )
}

// ── attempts ─────────────────────────────────────────────────────────────────

export function ProofAttemptRenderer(props: ToolProps) {
  const claim = str(props.toolInput.claim, '?')
  const outcome = str(props.toolInput.outcome, 'note')
  const route = str(props.toolInput.route)
  return (
    <ToolCard
      icon="✕"
      title={`attempt on ${claim}${route ? `#${route}` : ''}`}
      isError={props.isError}
      defaultOpen={false}
      badge={<Chip tone={OUTCOME_TONE[outcome] ?? 'muted'}>{outcome}</Chip>}
    >
      {props.toolInput.reason ? <KeyValue label="reason">{str(props.toolInput.reason)}</KeyValue> : null}
      {props.toolInput.kill_condition ? <KeyValue label="retry when">{str(props.toolInput.kill_condition)}</KeyValue> : null}
      {props.toolResult && <Pre maxHeight="6rem">{props.toolResult}</Pre>}
    </ToolCard>
  )
}

// ── generic fallback ─────────────────────────────────────────────────────────

export function ProofGenericRenderer(props: ToolProps) {
  return (
    <ToolCard icon="∑" title={props.toolName.replace(/^proof_/, 'proof · ')} isError={props.isError} defaultOpen={!!props.isError}>
      {props.isRunning && <Spinner label="running…" />}
      {props.toolResult ? <Pre maxHeight="18rem">{props.toolResult}</Pre> : !props.isRunning && <Empty>No output.</Empty>}
    </ToolCard>
  )
}
