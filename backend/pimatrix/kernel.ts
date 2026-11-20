/**
 * Read-only bridge to the pi-matrix Python kernel.
 *
 * The dashboard never re-derives a proof status. Every call here shells out to
 * `python -m pimatrix ...` (argv only, no shell) and returns the kernel's JSON.
 * The module is pure Node and dependency-injectable enough to unit test without
 * the Python environment.
 */
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  PimatrixClaim,
  PimatrixDoctorResponse,
  PimatrixEvent,
  PimatrixKernelInfo,
  PimatrixLogResponse,
  PimatrixProjectSummary,
  PimatrixSolverResponse,
  PimatrixSolverRun,
  PimatrixStatus,
  PimatrixStatusResponse,
  PimatrixTarget,
} from '../../shared/src/pimatrix.js'

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const STATUS_TTL_MS = 4000
const DOCTOR_TTL_MS = 60_000
const MAX_KERNEL_PROCESSES = 12
let activeKernelProcesses = 0

export class PimatrixRouteError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'pimatrix_error') {
    super(message)
  }
}

export interface RunResult {
  code: number
  json: any
  stderr: string
}

export interface RunOptions {
  root?: string
  timeoutMs?: number
  maxBytes?: number
  /** Overrides for tests; production callers leave these undefined. */
  python?: string
  packageRoot?: string
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
}

export function expandHome(input: string): string {
  if (input === '~') return os.homedir()
  return input.startsWith('~/') ? path.join(os.homedir(), input.slice(2)) : input
}

/** Walk up from `start` until a directory contains `pimatrix.json`. */
export function findProjectRoot(start: string): string | undefined {
  let dir: string
  try {
    dir = realpathSync(expandHome(start))
  } catch {
    return undefined
  }
  for (;;) {
    try {
      if (statSync(path.join(dir, 'pimatrix.json')).isFile()) return dir
    } catch {
      // Not a project marker; keep walking up.
    }
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Resolve a caller-supplied directory to a canonical pi-matrix project root. */
export function resolveProject(input: string): string {
  const raw = expandHome(input.trim())
  if (!raw) throw new PimatrixRouteError('path is required', 400, 'path_required')
  let dir: string
  try {
    dir = realpathSync(path.resolve(raw))
  } catch {
    throw new PimatrixRouteError(`path does not exist: ${raw}`, 404, 'path_not_found')
  }
  if (!statSync(dir).isDirectory()) throw new PimatrixRouteError(`not a directory: ${dir}`, 400, 'not_a_directory')
  const root = findProjectRoot(dir)
  if (!root) throw new PimatrixRouteError(`no pimatrix.json in ${dir} or its parents`, 400, 'not_a_pimatrix_project')
  return root
}

interface PackageEntry {
  source?: unknown
}

/** Local package sources declared by a pi settings file, resolved against that file. */
export function settingsPackagePaths(settingsPath: string): string[] {
  let raw: any
  try {
    raw = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  } catch {
    return []
  }
  const packages = Array.isArray(raw?.packages) ? raw.packages : []
  const out: string[] = []
  for (const entry of packages) {
    const source = typeof entry === 'string' ? entry : (entry as PackageEntry)?.source
    if (typeof source !== 'string' || !source.trim()) continue
    if (/^(?:npm:|git:|https?:\/\/|ssh:\/\/|git:\/\/)/.test(source)) continue
    const resolved = path.isAbsolute(source) ? source : path.resolve(path.dirname(settingsPath), source)
    out.push(resolved)
  }
  return out
}

/** A package root is usable when it contains the Python kernel source. */
export function isPimatrixPackage(candidate: string): boolean {
  try {
    return existsSync(path.join(candidate, 'verifier', 'src', 'pimatrix', '__init__.py'))
  } catch {
    return false
  }
}

/**
 * Locate the pi-matrix checkout that owns the kernel.
 *
 * Only service/operator-controlled locations are trusted. A proof project
 * supplies data, never the kernel or interpreter used by the dashboard.
 */
export function locatePackage(): string | undefined {
  const candidates: string[] = []
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim() && !candidates.includes(value)) candidates.push(value)
  }
  const configured = process.env.PIMATRIX_PACKAGE?.trim()
  if (configured) {
    const candidate = path.resolve(expandHome(configured))
    return isPimatrixPackage(candidate) ? candidate : undefined
  }
  for (const entry of settingsPackagePaths(path.join(agentDir(), 'settings.json'))) push(entry)
  push(path.join(os.homedir(), 'repos', 'pi_matrix'))
  return candidates.find(isPimatrixPackage)
}

export function resolvePython(packageRoot: string): string {
  if (process.env.PIMATRIX_PYTHON) {
    const configured = expandHome(process.env.PIMATRIX_PYTHON)
    return path.isAbsolute(configured) ? configured : path.resolve(packageRoot, configured)
  }
  const venv = path.join(packageRoot, 'verifier', '.venv', 'bin', 'python')
  if (existsSync(venv)) return venv
  return 'python3'
}

export function kernelInfo(): PimatrixKernelInfo | null {
  const packageRoot = locatePackage()
  return packageRoot ? { packageRoot, python: resolvePython(packageRoot) } : null
}

function pythonEnv(packageRoot: string, python: string): NodeJS.ProcessEnv {
  const src = path.join(packageRoot, 'verifier', 'src')
  return {
    ...process.env,
    PIMATRIX_PYTHON: python,
    // Do not let a project directory shadow the kernel module with a local
    // `pimatrix.py`/package: the project root is the spawn cwd, not a code root.
    PYTHONSAFEPATH: '1',
    PYTHONPATH: src,
    PYTHONDONTWRITEBYTECODE: '1',
  }
}

function killTree(pid: number | undefined, child?: { kill: (signal?: NodeJS.Signals) => boolean }): void {
  if (pid) {
    try {
      if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL')
      else process.kill(pid, 'SIGKILL')
    } catch {
      // The process group may already be gone; fall through to the direct kill.
    }
  }
  try {
    child?.kill('SIGKILL')
  } catch {
    // Already exited.
  }
}

/** Run the kernel CLI and parse its final JSON line. Never throws for a non-zero exit. */
export function runPimatrix(args: string[], options: RunOptions = {}): Promise<RunResult> {
  const packageRoot = options.packageRoot ?? locatePackage()
  if (!packageRoot) {
    return Promise.resolve({
      code: 3,
      json: { ok: false, error: 'pi-matrix package not found; set PIMATRIX_PACKAGE or install it for pi' },
      stderr: '',
    })
  }
  const python = options.python ?? resolvePython(packageRoot)
  const fullArgs = ['-P', '-m', 'pimatrix', ...(options.root ? ['-C', options.root] : []), ...args]
  const timeoutMs = options.timeoutMs ?? 15_000
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

  if (activeKernelProcesses >= MAX_KERNEL_PROCESSES) {
    return Promise.resolve({ code: 3, json: { ok: false, error: 'pi-matrix kernel busy (process limit reached)' }, stderr: '' })
  }
  activeKernelProcesses++
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(python, fullArgs, {
        cwd: packageRoot,
        env: pythonEnv(packageRoot, python),
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error: any) {
      activeKernelProcesses--
      resolve({ code: 3, json: { ok: false, error: `cannot run ${python}: ${error?.message ?? String(error)}` }, stderr: '' })
      return
    }

    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    // Pipe chunks can split a multi-byte UTF-8 character; decode across chunks.
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let settled = false
    const finish = (result: RunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      killTree(child.pid, child)
      finish({ code: 3, json: { ok: false, error: 'pimatrix timed out' }, stderr })
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      stdout += stdoutDecoder.write(chunk)
      stdoutBytes += chunk.length
      if (stdoutBytes > maxBytes) {
        killTree(child.pid, child)
        finish({ code: 3, json: { ok: false, error: 'pimatrix output exceeded the limit' }, stderr })
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled) return
      stderr += stderrDecoder.write(chunk)
      stderrBytes += chunk.length
      if (stderrBytes > maxBytes) {
        killTree(child.pid, child)
        finish({ code: 3, json: { ok: false, error: 'pimatrix stderr exceeded the limit' }, stderr })
      }
    })
    child.on('error', (error: Error) => {
      finish({ code: 3, json: { ok: false, error: `cannot run ${python}: ${error.message}` }, stderr })
    })
    child.once('close', (code: number | null) => {
      activeKernelProcesses--
      if (settled) return
      stdout += stdoutDecoder.end()
      stderr += stderrDecoder.end()
      const line = stdout.trim().split('\n').pop() ?? ''
      let json: any
      try {
        json = JSON.parse(line)
      } catch {
        json = { ok: false, error: `pimatrix produced no JSON (exit ${code}): ${stderr.slice(-800) || stdout.slice(-800)}` }
      }
      finish({ code: code ?? 3, json, stderr })
    })
  })
}

export function ledgerStamp(root: string): string {
  try {
    const stat = statSync(path.join(root, 'ledger', 'events.jsonl'))
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'none'
  }
}

export function ledgerUpdatedAt(root: string): string | null {
  try {
    return new Date(statSync(path.join(root, 'ledger', 'events.jsonl')).mtimeMs).toISOString()
  } catch {
    return null
  }
}

export function projectTitle(root: string): string {
  try {
    const raw = JSON.parse(readFileSync(path.join(root, 'pimatrix.json'), 'utf-8'))
    if (typeof raw?.title === 'string' && raw.title.trim()) return raw.title.trim()
  } catch {
    // Fall back to the directory name.
  }
  return path.basename(root)
}

/** Classify a kernel result for HTTP: a timeout/lock/missing runtime is 503, not a proof error. */
function kernelFailure(result: RunResult, fallback: string): PimatrixRouteError {
  const message = String(result.json?.error ?? fallback)
  const busy = /timed out|busy|locked|transaction/i.test(message)
  const unavailable = busy || /cannot run|package not found/i.test(message)
  return new PimatrixRouteError(message, unavailable ? 503 : 500, busy ? 'kernel_busy' : unavailable ? 'kernel_unavailable' : 'kernel_error')
}

const statusCache = new Map<string, { at: number; stamp: string; value: PimatrixStatusResponse }>()
const statusInflight = new Map<string, { stamp: string; promise: Promise<PimatrixStatusResponse> }>()
let doctorCache: { at: number; value: PimatrixDoctorResponse } | null = null
let doctorInflight: Promise<PimatrixDoctorResponse> | null = null

export function clearPimatrixCache(): void {
  statusCache.clear()
  statusInflight.clear()
  doctorCache = null
  doctorInflight = null
}

/** Read `pimatrix status`, reusing a cached value while the ledger is unchanged. */
export async function statusForRoot(root: string, options: { force?: boolean; maxAgeMs?: number; timeoutMs?: number } = {}): Promise<PimatrixStatusResponse> {
  const stamp = ledgerStamp(root)
  const cached = statusCache.get(root)
  const maxAge = options.maxAgeMs ?? STATUS_TTL_MS
  if (!options.force && cached && cached.stamp === stamp && Date.now() - cached.at < maxAge) return cached.value
  const pending = statusInflight.get(root)
  // Refresh bypasses completed cache entries but joins an active read of the
  // same ledger version. A newly observed version starts a distinct read.
  if (pending?.stamp === stamp) return pending.promise

  const promise = Promise.resolve().then(async (): Promise<PimatrixStatusResponse> => {
    const started = Date.now()
    const result = await runPimatrix(['status'], { root, timeoutMs: options.timeoutMs ?? 15_000 })
    if (result.json?.ok === false) {
      const failure = kernelFailure(result, 'pimatrix status failed')
      if (cached) {
        const stale: PimatrixStatusResponse = {
          ...cached.value,
          meta: { ...cached.value.meta, stale: true, busy: failure.code === 'kernel_busy', error: failure.message },
        }
        return stale
      }
      throw failure
    }
    const status = result.json
    if (!status || typeof status !== 'object' || !Array.isArray(status.targets) || !Array.isArray(status.claims) || !status.ledger) {
      throw new PimatrixRouteError('unexpected pimatrix status payload', 502, 'kernel_contract')
    }
    // The Python lock is released before the result arrives. If the stamp
    // changed, we cannot tell which version the response represents.
    const changed = ledgerStamp(root) !== stamp
    const value: PimatrixStatusResponse = {
      ok: true,
      status: status as PimatrixStatus,
      meta: {
        root,
        readAt: new Date().toISOString(),
        elapsedMs: Date.now() - started,
        ...(changed ? { error: 'ledger changed during the status read' } : { ledgerStamp: stamp }),
        stale: changed,
        busy: false,
      },
    }
    if (!changed && statusInflight.get(root)?.promise === promise) {
      statusCache.delete(root)
      if (statusCache.size >= 200) {
        const oldest = statusCache.keys().next().value
        if (oldest !== undefined) statusCache.delete(oldest)
      }
      statusCache.set(root, { at: Date.now(), stamp, value })
    }
    return value
  })

  statusInflight.set(root, { stamp, promise })
  try {
    return await promise
  } finally {
    if (statusInflight.get(root)?.promise === promise) statusInflight.delete(root)
  }
}

function short(value: unknown, limit = 300): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

export function projectEvent(event: any): PimatrixEvent {
  const data = event?.data && typeof event.data === 'object' ? event.data : {}
  const type = String(event?.type ?? 'unknown')
  const claim = typeof data.claim === 'string' ? data.claim : typeof data.id === 'string' ? data.id : undefined
  let summary = type
  let detail: string | undefined
  switch (type) {
    case 'claim_registered':
      summary = `registered ${data.kind ?? 'claim'} ${data.id ?? '?'}`
      detail = short(data.note)
      break
    case 'alignment_confirmed':
      summary = `aligned ${data.claim ?? '?'}`
      break
    case 'proof_submitted':
      summary = `submitted ${data.claim ?? '?'}#${data.route ?? '?'} (${data.completeness ?? '?'})`
      break
    case 'review_recorded':
      summary = `${String(data.verdict ?? '?').toUpperCase()} by ${data.model ?? '?'} (${data.family ?? '?'})`
      detail = typeof data.score === 'number' ? `score ${data.score}` : short(data.note)
      break
    case 'certificate_checked':
      summary = `${data.adapter ?? 'checker'}: ${data.verdict ?? '?'}`
      detail = short(data.detail)
      break
    case 'citation_recorded':
      summary = `citation recorded for ${data.claim ?? '?'}`
      detail = short(data.source)
      break
    case 'citation_checked':
      summary = `citation ${data.verdict ?? '?'} for ${data.claim ?? '?'}`
      break
    case 'attempt_logged':
      summary = `${data.outcome ?? 'attempt'} on ${data.claim ?? '?'}`
      detail = short(data.reason)
      break
  }
  return {
    seq: Number(event?.seq ?? 0),
    ts: String(event?.ts ?? ''),
    type,
    claim,
    route: typeof data.route === 'string' ? data.route : undefined,
    verdict: typeof data.verdict === 'string' ? data.verdict : undefined,
    adapter: typeof data.adapter === 'string' ? data.adapter : undefined,
    outcome: typeof data.outcome === 'string' ? data.outcome : undefined,
    model: typeof data.model === 'string' ? data.model : undefined,
    family: typeof data.family === 'string' ? data.family : undefined,
    summary,
    detail,
  }
}

export async function logForRoot(root: string, last = 50): Promise<PimatrixLogResponse> {
  const count = Math.min(Math.max(Number.isFinite(last) ? Math.trunc(last) : 50, 1), 200)
  const started = Date.now()
  const result = await runPimatrix(['log', '--last', String(count)], { root, timeoutMs: 15_000 })
  if (result.json?.ok === false) throw kernelFailure(result, 'pimatrix log failed')
  if (!Array.isArray(result.json?.events)) {
    throw new PimatrixRouteError('unexpected pimatrix log payload', 502, 'kernel_contract')
  }
  const events = result.json.events.map(projectEvent)
  return {
    ok: true,
    events,
    meta: { root, readAt: new Date().toISOString(), elapsedMs: Date.now() - started, ledgerStamp: ledgerStamp(root) },
  }
}

export function trimSolverRun(raw: any): PimatrixSolverRun {
  return {
    id: String(raw?.id ?? ''),
    claim: String(raw?.claim ?? ''),
    phase: String(raw?.phase ?? 'unknown'),
    stop_reason: raw?.stop_reason ?? null,
    created_ms: typeof raw?.created_ms === 'number' ? raw.created_ms : undefined,
    deadline_ms: typeof raw?.deadline_ms === 'number' ? raw.deadline_ms : undefined,
    used: raw?.used && typeof raw.used === 'object' ? raw.used : undefined,
    budget: raw?.budget && typeof raw.budget === 'object' ? raw.budget : undefined,
    operations: Array.isArray(raw?.operations) ? raw.operations.length : undefined,
    remaining_obligations: Array.isArray(raw?.remaining_obligations) ? raw.remaining_obligations : undefined,
    audit_status: typeof raw?.audit_status === 'string' ? raw.audit_status : undefined,
    candidate: raw?.candidate ? { path: raw.candidate.path, source_hash: raw.candidate.source_hash } : null,
    certificate: raw?.certificate
      ? { verdict: raw.certificate.verdict, adapter: raw.certificate.adapter, detail: short(raw.certificate.detail) }
      : null,
  }
}

export async function solverForRoot(root: string, run: string): Promise<PimatrixSolverResponse> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(run)) {
    throw new PimatrixRouteError('invalid solver run id', 400, 'invalid_run_id')
  }
  const started = Date.now()
  const result = await runPimatrix(['solve-run', 'show', run], { root, timeoutMs: 15_000 })
  if (result.json?.ok === false) {
    const message = String(result.json.error ?? 'solver run not found')
    if (/timed out|cannot run|package not found|busy|locked|transaction/i.test(message)) {
      throw new PimatrixRouteError(message, 503, 'kernel_unavailable')
    }
    if (/not found|no such|does not exist|unknown solver/i.test(message)) {
      throw new PimatrixRouteError(message, 404, 'solver_run_not_found')
    }
    throw new PimatrixRouteError(message, 500, 'kernel_error')
  }
  if (!result.json?.run || typeof result.json.run !== 'object') {
    throw new PimatrixRouteError('unexpected solver payload', 502, 'kernel_contract')
  }
  return {
    ok: true,
    run: trimSolverRun(result.json.run),
    meta: { root, readAt: new Date().toISOString(), elapsedMs: Date.now() - started, ledgerStamp: ledgerStamp(root) },
  }
}

export async function doctor(force = false): Promise<PimatrixDoctorResponse> {
  if (!force && doctorCache && Date.now() - doctorCache.at < DOCTOR_TTL_MS) return doctorCache.value
  if (doctorInflight) return doctorInflight
  const promise = (async () => {
    const info = kernelInfo()
    const started = Date.now()
    const result = await runPimatrix(['doctor'], { timeoutMs: 30_000 })
    const report = result.json
    // A capability failure (missing Lean, sympy, ...) is still a diagnostic
    // report and should be displayed. A timeout/no-runtime is not.
    if (!report || typeof report !== 'object' || (report.ok !== true && !('capabilities' in report) && !('dependencies' in report))) {
      throw kernelFailure(result, 'pimatrix doctor failed')
    }
    const value: PimatrixDoctorResponse = {
      ok: true,
      doctor: report,
      kernel: info,
      meta: { readAt: new Date().toISOString(), elapsedMs: Date.now() - started },
    }
    if (report.ok === true) doctorCache = { at: Date.now(), value }
    return value
  })()
  doctorInflight = promise
  try {
    return await promise
  } finally {
    if (doctorInflight === promise) doctorInflight = null
  }
}

export function claimTierCounts(claims: PimatrixClaim[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const claim of claims) counts[claim.tier] = (counts[claim.tier] ?? 0) + 1
  return counts
}

function targetSummary(target: PimatrixTarget) {
  return { id: target.id, status: target.status, tier: target.tier, aligned: target.aligned }
}

/** Compact row for the cross-project board. */
export function projectSummary(status: PimatrixStatus, root: string, meta?: PimatrixStatusResponse['meta']): PimatrixProjectSummary {
  return {
    root,
    id: status.project || path.basename(root),
    title: projectTitle(root),
    targets: (status.targets ?? []).map(targetSummary),
    ledger: status.ledger,
    reviewRule: status.review_rule,
    lowYield: status.low_yield,
    warnings: status.warnings ?? [],
    claims: { total: (status.claims ?? []).length, byTier: claimTierCounts(status.claims ?? []) },
    updatedAt: ledgerUpdatedAt(root),
    meta,
  }
}

/** Run `fn` over `items` with a bounded number of concurrent kernels. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}
