/**
 * Routes: `/api/services` — the registry-backed service panel.
 *
 * Reads show config + live probe state. Writes (start/stop/restart) carry the same browser-auth
 * gate as every other machine-mutating route, and resolve the command from the registry file —
 * the request body is never interpreted as a command.
 */
import type { Express, Request, Response } from 'express'
import type { LiveSessionBrowserAuth } from '../live-sessions/auth.js'
import { requireBrowserAuth } from './require-browser-auth.js'
import {
  listServices,
  loadServices,
  readServiceLog,
  restartService,
  startService,
  stopService,
  type ServiceActionResult,
  type ServiceEntry,
} from '../services/registry.js'

const MAX_LOG_LINES = 400

export function registerServiceRoutes({ app, auth, configPath }: { app: Express; auth?: LiveSessionBrowserAuth; configPath?: string }): void {
  if (!auth) {
    // Fail closed: without an auth object there is no safe way to expose process control.
    app.get('/api/services', (_req: Request, res: Response) => {
      res.status(503).json({ error: 'auth_unavailable', hint: 'Live session browser auth is not initialised.' })
    })
    return
  }
  const guard = requireBrowserAuth(auth)

  const entryFor = (id: string): ServiceEntry | undefined => loadServices(configPath).entries.find(entry => entry.id === id)

  app.get('/api/services', async (_req: Request, res: Response) => {
    res.json(await listServices(configPath))
  })

  const actions = { start: startService, stop: stopService, restart: restartService } as const

  for (const [name, run] of Object.entries(actions)) {
    app.post(`/api/services/:id/${name}`, guard, async (req: Request, res: Response) => {
      const id = String(req.params['id'] ?? '')
      const entry = entryFor(id)
      if (!entry) {
        res.status(404).json({ ok: false, action: name, error: 'unknown_service' })
        return
      }
      let result: ServiceActionResult
      try {
        result = await run(entry)
      } catch (error) {
        result = { ok: false, action: name as ServiceActionResult['action'], error: error instanceof Error ? error.message : String(error) }
      }
      res.status(result.ok ? 200 : 500).json(result)
    })
  }

  app.get('/api/services/:id/logs', (req: Request, res: Response) => {
    const entry = entryFor(String(req.params['id'] ?? ''))
    if (!entry) {
      res.status(404).json({ error: 'unknown_service' })
      return
    }
    const requested = Number(req.query['lines'] ?? 120)
    const lines = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), MAX_LOG_LINES) : 120
    res.json(readServiceLog(entry, lines))
  })
}