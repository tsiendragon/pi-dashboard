/**
 * Read-only projection of the PiMatrix `proof-jobs` live feature.
 *
 * Wire contract (a `live_feature_snapshot` with `feature: 'proof-jobs'`):
 *   { tasks: [{ id, label, state, createdAt?, startedAt?, finishedAt?, collected? }] }
 * - `state`: queued | running | finished | failed | cancelled
 * - timestamps: epoch milliseconds
 * - `collected` is optional and may be absent; when it is, nothing is claimed.
 *
 * The dashboard only displays this list. It sends no commands for it; results are
 * collected inside the session (`proof_jobs`), never from the dashboard.
 */

export const PROOF_JOBS_FEATURE = 'proof-jobs'

export type ProofJobState = 'queued' | 'running' | 'finished' | 'failed' | 'cancelled' | 'unknown'

export interface ProofJob {
  id: string
  label: string
  state: ProofJobState
  createdAt?: number
  startedAt?: number
  finishedAt?: number
  collected?: boolean
}

export interface ProofJobsProjection {
  jobs: ProofJob[]
  /** queued + running */
  active: number
}

const KNOWN_STATES = new Set<ProofJobState>(['queued', 'running', 'finished', 'failed', 'cancelled'])

export const PROOF_JOB_STATE_LABEL: Record<ProofJobState, string> = {
  queued: '排队中',
  running: '运行中',
  finished: '已完成',
  failed: '失败',
  cancelled: '已取消',
  unknown: '未知',
}

/** Running first, then queued, then settled jobs newest first. */
const STATE_ORDER: Record<ProofJobState, number> = { running: 0, queued: 1, failed: 2, finished: 2, cancelled: 2, unknown: 3 }

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function time(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** `undefined` when the session never published the feature (non-PiMatrix sessions). */
export function projectProofJobs(snapshot: unknown): ProofJobsProjection | undefined {
  const root = record(snapshot)
  if (!root || !Array.isArray(root.tasks)) return undefined
  const seen = new Set<string>()
  const jobs: ProofJob[] = []
  for (const raw of root.tasks) {
    const task = record(raw)
    const id = typeof task?.id === 'string' ? task.id.trim() : ''
    if (!task || !id || seen.has(id)) continue
    seen.add(id)
    const state = typeof task.state === 'string' && KNOWN_STATES.has(task.state as ProofJobState) ? task.state as ProofJobState : 'unknown'
    const label = typeof task.label === 'string' && task.label.trim() ? task.label.trim() : id
    jobs.push({
      id,
      label,
      state,
      createdAt: time(task.createdAt),
      startedAt: time(task.startedAt),
      finishedAt: time(task.finishedAt),
      collected: typeof task.collected === 'boolean' ? task.collected : undefined,
    })
  }
  const recency = (job: ProofJob) => job.finishedAt ?? job.startedAt ?? job.createdAt ?? 0
  jobs.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || recency(b) - recency(a))
  return { jobs, active: jobs.filter(job => job.state === 'running' || job.state === 'queued').length }
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ''}`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** One-line timing text: queue wait, run time, or total. */
export function proofJobTiming(job: ProofJob, now: number): string {
  if (job.state === 'queued') return job.createdAt ? `已排队 ${duration(now - job.createdAt)}` : '等待空位'
  if (job.state === 'running') return job.startedAt ? `已运行 ${duration(now - job.startedAt)}` : '运行中'
  const start = job.startedAt ?? job.createdAt
  if (start && job.finishedAt) return `用时 ${duration(job.finishedAt - start)}`
  return ''
}
