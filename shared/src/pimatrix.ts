/**
 * pi-matrix proof-project read model.
 *
 * The shapes mirror `pimatrix status` / `pimatrix log` verbatim. The dashboard
 * never derives a mathematical status: every tier/state below comes from the
 * append-only ledger through the Python kernel.
 */

export type PimatrixTargetStatus =
  | 'open'
  | 'reviewed'
  | 'cited'
  | 'certified'
  | 'refuted'
  | 'proved'
  | 'disproved'

export interface PimatrixReviewRule {
  passes_required: number
  families_required: number
}

export interface PimatrixLedgerInfo {
  events: number
  head: string | null
  chain_ok: boolean
}

export interface PimatrixTargetBasis {
  reviewed: string[]
  certified: string[]
  cited: string[]
}

export interface PimatrixFrontierItem {
  claim: string
  action: string
}

export interface PimatrixTarget {
  id: string
  status: PimatrixTargetStatus
  tier: string
  aligned: boolean
  refines: string | null
  statement: string
  basis?: PimatrixTargetBasis
  frontier?: PimatrixFrontierItem[]
}

export interface PimatrixRoute {
  route: string
  path: string
  uses: string[]
  stale: boolean
  live: boolean
  dead_reason: string | null
  passes: number
  families: string[]
  reviewed: boolean
  reviews: number
  integrity_ok: boolean
}

export interface PimatrixClaim {
  id: string
  kind: 'target' | 'lemma'
  tier: string
  closed: boolean
  cycle: boolean
  refines: string | null
  has_formal: boolean
  routes: PimatrixRoute[]
  flags: string[]
  statement: string
}

export interface PimatrixLowYield {
  flag: boolean
  events_since_progress: number
  window: number
}

/** The JSON printed by `pimatrix status`. */
export interface PimatrixStatus {
  ok?: boolean
  project: string
  ledger: PimatrixLedgerInfo
  review_rule: PimatrixReviewRule
  targets: PimatrixTarget[]
  claims: PimatrixClaim[]
  low_yield: PimatrixLowYield
  warnings: string[]
}

export interface PimatrixSourceMeta {
  /** Canonical project root. */
  root: string
  /** ISO timestamp of the read. */
  readAt: string
  /** Kernel round-trip time in milliseconds. */
  elapsedMs?: number
  /** Ledger `mtime:size` used as the cache key. */
  ledgerStamp?: string
  /** True when this response reuses an older value because the kernel was busy. */
  stale?: boolean
  /** True when the kernel could not answer inside the deadline (usually a long certify/audit holds the lock). */
  busy?: boolean
  /** Set when `stale` is true. */
  error?: string
}

export interface PimatrixStatusResponse {
  ok: true
  status: PimatrixStatus
  meta: PimatrixSourceMeta
}

export interface PimatrixTargetSummary {
  id: string
  status: PimatrixTargetStatus
  tier: string
  aligned: boolean
}

/** One row on the cross-project board. */
export interface PimatrixProjectSummary {
  root: string
  id: string
  title: string
  targets: PimatrixTargetSummary[]
  ledger: PimatrixLedgerInfo
  reviewRule: PimatrixReviewRule
  lowYield: PimatrixLowYield
  warnings: string[]
  claims: { total: number; byTier: Record<string, number> }
  updatedAt: string | null
  error?: string
  meta?: PimatrixSourceMeta
}

export interface PimatrixProjectsResponse {
  ok: true
  projects: PimatrixProjectSummary[]
  roots: string[]
  kernel: PimatrixKernelInfo | null
  generatedAt: string
}

export interface PimatrixKernelInfo {
  packageRoot: string
  python: string
}

/** One projected ledger event. Raw large fields are removed by `pimatrix log`. */
export interface PimatrixEvent {
  seq: number
  ts: string
  type: string
  claim?: string
  route?: string
  verdict?: string
  adapter?: string
  outcome?: string
  model?: string
  family?: string
  summary: string
  detail?: string
}

export interface PimatrixLogResponse {
  ok: true
  events: PimatrixEvent[]
  meta: PimatrixSourceMeta
}

/** Trimmed `pimatrix solve-run show` record. */
export interface PimatrixSolverRun {
  id: string
  claim: string
  phase: string
  stop_reason?: string | null
  created_ms?: number
  deadline_ms?: number
  used?: Record<string, number | boolean>
  budget?: Record<string, number | boolean>
  operations?: number
  remaining_obligations?: unknown[]
  audit_status?: string
  candidate?: { path?: string; source_hash?: string } | null
  certificate?: { verdict?: string; adapter?: string; detail?: string } | null
}

export interface PimatrixSolverResponse {
  ok: true
  run: PimatrixSolverRun
  meta: PimatrixSourceMeta
}

export interface PimatrixDoctorMeta {
  readAt: string
  elapsedMs: number
}

export interface PimatrixDoctorResponse {
  ok: true
  doctor: Record<string, unknown>
  kernel: PimatrixKernelInfo | null
  meta: PimatrixDoctorMeta
}

/** Standard error body for the read-only pi-matrix routes. */
export interface PimatrixErrorResponse {
  ok: false
  error: string
  code: string
}
