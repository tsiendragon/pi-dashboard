/**
 * Repo registry routes.
 *
 *   GET    /api/dash/repos                    list + cached git status; ?refresh=1 recomputes in the background
 *   POST   /api/dash/repos                    register   { path, id?, name?, tags?, ... }
 *   PATCH  /api/dash/repos/:id                edit (id is immutable)
 *   DELETE /api/dash/repos/:id                unregister only; never touches the directory
 *   GET    /api/dash/repos/:id/graph          ?scope=all|head&cursor=N
 *   GET    /api/dash/repos/:id/commit/:sha    changed files
 *   POST   /api/dash/repos/:id/fetch          git fetch --prune, then drops the cached status
 *
 * Reads are open like the other config/file reads; every write carries the browser-auth gate.
 */
import type { Express, Request, Response } from 'express'
import { existsSync } from 'fs'
import path from 'path'
import type { LiveSessionBrowserAuth } from '../live-sessions/auth.js'
import { requireBrowserAuth } from './require-browser-auth.js'
import { fetchRepo, repoCommit, repoGraph, repoStatus, SHA_PATTERN } from '../repos/git.js'
import { StatusCache } from '../repos/status-cache.js'
import { RepoError, RepoStore } from '../repos/store.js'
import type { RepoView } from '../../shared/src/repos.js'

/**
 * Status older than this is refreshed in the background when the list is opened. Daily on purpose:
 * big checkouts on network mounts take tens of seconds; the page shows the read time and the
 * 「刷新状态」 button forces a re-read.
 */
const STATUS_TTL_MS = 24 * 60 * 60_000

export interface RepoRouteOptions {
  app: Express
  auth: LiveSessionBrowserAuth
  store: RepoStore
  /** cwd of every Live Pi currently registered; used only for the "in use" count. */
  liveCwds?: () => string[]
  /** Where cached statuses survive restarts; omitted = memory only. */
  statusCacheFile?: string
}

export function registerRepoRoutes({ app, auth, store, liveCwds = () => [], statusCacheFile }: RepoRouteOptions): void {
  const cache = new StatusCache(repoStatus, STATUS_TTL_MS, statusCacheFile)

  const guard = (handler: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response): void => {
      handler(req, res).catch((error: unknown) => {
        if (error instanceof RepoError) { res.status(error.status).json({ error: error.code, message: error.message }); return }
        const message = error instanceof Error ? error.message : String(error)
        res.status(500).json({ error: 'repo_request_failed', message })
      })
    }
  const write = (handler: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response): void => requireBrowserAuth(auth)(req, res, () => guard(handler)(req, res))

  const needRepo = (req: Request) => {
    const entry = store.get(String(req.params.id))
    if (!entry) throw new RepoError(404, 'repo_not_found', '没有这个仓库')
    if (!existsSync(entry.path)) throw new RepoError(410, 'path_missing', '仓库路径已不存在，请先改路径')
    return entry
  }

  const statusFields = async (dir: string, exists: boolean, mode: 'wait' | 'cached' | 'refresh'): Promise<Pick<RepoView, 'status' | 'statusAt' | 'refreshing'>> => {
    if (!exists) return { status: null, statusAt: null, refreshing: false }
    if (mode === 'wait') {
      const status = await cache.get(dir)
      return { status, statusAt: cache.peek(dir)?.at ?? Date.now(), refreshing: false }
    }
    const hit = cache.peekAndRefresh(dir, mode === 'refresh')
    return { status: hit?.value ?? null, statusAt: hit?.at ?? null, refreshing: cache.isRefreshing(dir) }
  }

  const view = async (entry: ReturnType<RepoStore['list']>[number], cwds: string[], mode: 'wait' | 'cached' | 'refresh' = 'wait'): Promise<RepoView> => {
    const exists = existsSync(entry.path)
    const inside = (cwd: string) => cwd === entry.path || cwd.startsWith(entry.path + path.sep)
    return {
      ...entry,
      exists,
      ...(await statusFields(entry.path, exists, mode)),
      liveSessions: cwds.filter(inside).length,
    }
  }

  app.get('/api/dash/repos', guard(async (req, res) => {
    const cwds = liveCwds()
    const mode = req.query.refresh === '1' ? 'refresh' : 'cached'
    res.json({ repos: await Promise.all(store.list().map(entry => view(entry, cwds, mode))) })
  }))

  app.post('/api/dash/repos', write(async (req, res) => {
    const entry = store.add(req.body ?? {})
    res.status(201).json({ repo: await view(entry, liveCwds()) })
  }))

  app.patch('/api/dash/repos/:id', write(async (req, res) => {
    const entry = store.update(String(req.params.id), req.body ?? {})
    cache.forget(entry.path)
    res.json({ repo: await view(entry, liveCwds()) })
  }))

  app.delete('/api/dash/repos/:id', write(async (req, res) => {
    const removed = store.get(String(req.params.id))
    store.remove(String(req.params.id))
    if (removed) cache.forget(removed.path)
    res.json({ ok: true })
  }))

  app.get('/api/dash/repos/:id/graph', guard(async (req, res) => {
    const entry = needRepo(req)
    const scope = req.query.scope === 'head' ? 'head' : 'all'
    const cursor = Math.max(0, Number.parseInt(String(req.query.cursor ?? '0'), 10) || 0)
    const page = await repoGraph(entry.path, scope, cursor)
    res.json({ repo: { id: entry.id, name: entry.name ?? path.basename(entry.path), path: entry.path }, status: cache.peekAndRefresh(entry.path)?.value ?? null, ...page })
  }))

  app.get('/api/dash/repos/:id/commit/:sha', guard(async (req, res) => {
    const entry = needRepo(req)
    const sha = String(req.params.sha)
    if (!SHA_PATTERN.test(sha)) throw new RepoError(400, 'invalid_sha', 'sha 格式不对')
    res.json({ commit: await repoCommit(entry.path, sha) })
  }))

  app.post('/api/dash/repos/:id/fetch', write(async (req, res) => {
    const entry = needRepo(req)
    await fetchRepo(entry.path)
    cache.forget(entry.path)
    res.json({ repo: await view(entry, liveCwds()) })
  }))
}
