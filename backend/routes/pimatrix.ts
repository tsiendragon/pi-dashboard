/**
 * Read-only pi-matrix routes.
 *
 *   GET /api/pimatrix/status  ?slot=<slotKey> | ?path=<dir> [&refresh=1]
 *   GET /api/pimatrix/log     ?slot|path [&last=50]
 *   GET /api/pimatrix/solver  ?slot|path &run=<id>
 *   GET /api/pimatrix/projects
 *   GET /api/pimatrix/doctor  [&refresh=1]
 *
 * Everything is a thin transport over the Python kernel. Routes never append
 * proof events or take shell strings; the CLI may acquire a transaction lock.
 */
import { readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Request, Response } from 'express'
import type { RouteDeps } from './types.js'
import type { LiveSessionBrowserAuth } from '../live-sessions/auth.js'
import { requireBrowserAuth } from './require-browser-auth.js'
import { getDashConfig } from '../pi-env.js'
import {
  doctor,
  kernelInfo,
  ledgerUpdatedAt,
  logForRoot,
  mapPool,
  PimatrixRouteError,
  projectSummary,
  resolveProject,
  solverForRoot,
  statusForRoot,
  expandHome,
} from '../pimatrix/kernel.js'
import type { PimatrixProjectSummary } from '../../shared/src/pimatrix.js'

const MAX_PROJECTS = 40
const OVERVIEW_CONCURRENCY = 6
const OVERVIEW_TIMEOUT_MS = 5_000

function fail(res: Response, error: unknown): void {
  if (res.headersSent) return
  const known = error instanceof PimatrixRouteError
  const status = known ? error.status : 500
  const code = known ? error.code : 'pimatrix_error'
  res.status(status).json({ ok: false, error: error instanceof Error ? error.message : String(error), code })
}

/** Wrap an async handler so Express 4 does not leak an unhandled rejection. */
function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    void fn(req, res).catch(error => fail(res, error))
  }
}

function queryString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function rootFromQuery(req: Request, manager: RouteDeps['manager']): string {
  const slot = queryString(req.query.slot)
  if (slot) {
    const pi = manager.getSlot(slot)
    if (!pi) throw new PimatrixRouteError(`slot not found: ${slot}`, 404, 'slot_not_found')
    if (!pi.cwd) throw new PimatrixRouteError('slot has no working directory', 400, 'slot_has_no_cwd')
    return resolveAllowedProject(pi.cwd)
  }
  const requested = queryString(req.query.path)
  if (requested) return resolveAllowedProject(requested)
  throw new PimatrixRouteError('query parameter "slot" or "path" is required', 400, 'missing_project')
}

/** Only administrator-configured roots grant access; a chat slot grants none. */
function configuredRoots(): string[] {
  const cfg = getDashConfig() as {
    pimatrix?: { roots?: unknown }
    repos?: unknown
    liveSessions?: { repoRoots?: unknown }
  }
  const roots: string[] = []
  const seen = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return
    const normalized = path.resolve(expandHome(value.trim()))
    if (seen.has(normalized)) return
    seen.add(normalized)
    roots.push(normalized)
  }
  if (Array.isArray(cfg.pimatrix?.roots)) cfg.pimatrix.roots.forEach(add)
  const envRoots = process.env.PIMATRIX_PROJECT_ROOTS
  if (envRoots) for (const entry of envRoots.split(path.delimiter)) add(entry)
  if (roots.length || Array.isArray(cfg.pimatrix?.roots)) return roots
  if (Array.isArray(cfg.repos)) {
    for (const repo of cfg.repos) {
      if (typeof repo === 'string') add(repo)
      else add((repo as { path?: unknown })?.path)
    }
  }
  if (Array.isArray(cfg.liveSessions?.repoRoots)) cfg.liveSessions.repoRoots.forEach(add)
  return roots
}

function realDirectory(dir: string): string | undefined {
  try {
    const real = realpathSync(dir)
    return statSync(real).isDirectory() ? real : undefined
  } catch {
    return undefined
  }
}

function visibleChild(name: string): boolean {
  return !name.startsWith('.') && name !== 'node_modules'
}

export function resolveAllowedProject(input: string, roots = configuredRoots()): string {
  const project = resolveProject(input)
  for (const root of roots) {
    const real = realDirectory(root)
    if (!real) continue
    if (project === real) return project
    if (path.dirname(project) === real && visibleChild(path.basename(project)) && !projectAt(real)) return project
  }
  throw new PimatrixRouteError('project is outside configured pi-matrix roots', 403, 'project_not_allowed')
}

const MAX_SCAN_ENTRIES = 500

/** Direct project-marker check; unlike findProjectRoot it never walks upward. */
function projectAt(dir: string): string | undefined {
  try {
    const real = realpathSync(dir)
    if (!statSync(real).isDirectory()) return undefined
    return statSync(path.join(real, 'pimatrix.json')).isFile() ? real : undefined
  } catch {
    return undefined
  }
}

/**
 * A configured root may be a single proof project, or a directory whose
 * immediate children are proof projects (the usual `~/repos` layout). Only one
 * level is scanned, and markers are checked directly: walking up from a child
 * would collapse every child into a project above the configured root.
 */
export function projectRootsUnder(root: string): string[] {
  const real = realDirectory(root)
  if (!real) return []
  const direct = projectAt(real)
  if (direct) return [direct]
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(real, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  let scanned = 0
  for (const entry of entries) {
    if (++scanned > MAX_SCAN_ENTRIES) break
    if (!visibleChild(entry.name) || !entry.isDirectory()) continue
    const projectRoot = projectAt(path.join(real, entry.name))
    if (projectRoot && path.dirname(projectRoot) === real && visibleChild(path.basename(projectRoot))) found.push(projectRoot)
  }
  return found
}

function emptySummary(root: string, error: string): PimatrixProjectSummary {
  return {
    root,
    id: path.basename(root),
    title: path.basename(root),
    targets: [],
    ledger: { events: 0, head: null, chain_ok: false },
    reviewRule: { passes_required: 0, families_required: 0 },
    lowYield: { flag: false, events_since_progress: 0, window: 0 },
    warnings: [],
    claims: { total: 0, byTier: {} },
    updatedAt: ledgerUpdatedAt(root),
    error,
  }
}

export function registerPimatrixRoutes({ app, manager }: RouteDeps, auth: LiveSessionBrowserAuth): void {
  app.use('/api/pimatrix', (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store')
    next()
  }, requireBrowserAuth(auth))
  app.get('/api/pimatrix/status', handle(async (req, res) => {
    const root = rootFromQuery(req, manager)
    const force = queryString(req.query.refresh) === '1'
    const value = await statusForRoot(root, { force })
    res.json(value)
  }))

  app.get('/api/pimatrix/log', handle(async (req, res) => {
    const root = rootFromQuery(req, manager)
    const last = Number.parseInt(queryString(req.query.last) || '50', 10)
    const value = await logForRoot(root, Number.isFinite(last) ? last : 50)
    res.json(value)
  }))

  app.get('/api/pimatrix/solver', handle(async (req, res) => {
    const root = rootFromQuery(req, manager)
    const run = queryString(req.query.run)
    if (!run) throw new PimatrixRouteError('query parameter "run" is required', 400, 'missing_run')
    const value = await solverForRoot(root, run)
    res.json(value)
  }))

  app.get('/api/pimatrix/doctor', handle(async (req, res) => {
    const force = queryString(req.query.refresh) === '1'
    const value = await doctor(force)
    res.json(value)
  }))

  app.get('/api/pimatrix/projects', handle(async (req, res) => {
    const force = queryString(req.query.refresh) === '1'
    const roots = configuredRoots()
    const projects: string[] = []
    const seen = new Set<string>()
    for (const root of roots) {
      for (const projectRoot of projectRootsUnder(root)) {
        if (seen.has(projectRoot)) continue
        seen.add(projectRoot)
        projects.push(projectRoot)
        if (projects.length >= MAX_PROJECTS) break
      }
      if (projects.length >= MAX_PROJECTS) break
    }

    const summaries = await mapPool(projects, OVERVIEW_CONCURRENCY, async root => {
      try {
        const value = await statusForRoot(root, { force, maxAgeMs: force ? 0 : 6000, timeoutMs: OVERVIEW_TIMEOUT_MS })
        return value.meta.stale && value.meta.error
          ? { ...projectSummary(value.status, root, value.meta), error: value.meta.error }
          : projectSummary(value.status, root, value.meta)
      } catch (error) {
        return emptySummary(root, error instanceof Error ? error.message : String(error))
      }
    })

    res.json({
      ok: true,
      projects: summaries,
      roots,
      kernel: kernelInfo(),
      generatedAt: new Date().toISOString(),
    })
  }))
}
