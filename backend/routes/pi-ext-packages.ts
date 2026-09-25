/**
 * Package management routes for the Extensions page (P3).
 *
 *   POST /api/pi/ext/install   { source }
 *   POST /api/pi/ext/remove    { source }
 *   POST /api/pi/ext/update    { source }
 *   GET  /api/pi/ext/audit     ?limit=
 *   POST /api/pi/ext/rollback  { backupPath }
 *
 * Install/remove/update/rollback are machine-state changes and require the Live Session browser auth
 * (the server binds 0.0.0.0 with no global auth middleware). All of them go through `runPackageOperation`
 * (no shell, settings backup, before/after diff, audit record). `audit` is read-only.
 */
import type { Express, Request, Response } from 'express'
import { readFileSync, readdirSync } from 'fs'
import { join, resolve as resolvePath, sep } from 'path'
import type { LiveSessionBrowserAuth } from '../live-sessions/auth.js'
import { appendAuditRecord, readAuditRecords } from '../ext-audit.js'
import { runPackageOperation } from '../ext-packages.js'
import { resolvePiScript } from '../pi-manager.js'
import { settingsStore } from '../settings-store.js'
import { requireBrowserAuth } from './require-browser-auth.js'

function actorOf(auth: LiveSessionBrowserAuth, req: Request): string | null {
  return auth.getIdentity(req)?.browserClientId ?? null
}

export function registerPiExtPackagesRoutes({ app, auth }: { app: Express; auth: LiveSessionBrowserAuth }): void {
  const requireAuth = requireBrowserAuth(auth)

  const runAction = (action: 'install' | 'remove' | 'update') => async (req: Request, res: Response) => {
    const body = req.body as { source?: unknown } | undefined
    const source = typeof body?.source === 'string' ? body.source : ''
    const result = await runPackageOperation({
      action,
      source,
      store: settingsStore,
      piBin: resolvePiScript(),
      actor: actorOf(auth, req),
    })
    if (!result.ok) return res.status(400).json(result)
    return res.json(result)
  }

  app.post('/api/pi/ext/install', requireAuth, runAction('install'))
  app.post('/api/pi/ext/remove', requireAuth, runAction('remove'))
  app.post('/api/pi/ext/update', requireAuth, runAction('update'))

  app.get('/api/pi/ext/audit', (req: Request, res: Response) => {
    const limit = Number.parseInt(String(req.query.limit ?? '50'), 10)
    res.json({ records: readAuditRecords(settingsStore.agentDir, Number.isFinite(limit) ? limit : 50), logPath: join(settingsStore.agentDir, 'extension-audit.jsonl') })
  })

  app.post('/api/pi/ext/rollback', requireAuth, async (req: Request, res: Response) => {
    const body = req.body as { backupPath?: unknown } | undefined
    const backupPath = typeof body?.backupPath === 'string' ? body.backupPath : ''
    if (!backupPath) return res.status(400).json({ error: 'body must include `backupPath`' })

    // Only backups of settings.json inside this agent dir may be restored.
    const backupsDir = settingsStore.backupsDir
    const target = resolvePath(backupPath)
    if (!target.startsWith(resolvePath(backupsDir) + sep) || !/settings-.*\.json$/.test(target)) {
      return res.status(400).json({ error: `backupPath must be a settings-*.json inside ${backupsDir}` })
    }

    let restored: Record<string, unknown>
    try {
      restored = JSON.parse(readFileSync(target, 'utf-8')) as Record<string, unknown>
    } catch (error) {
      return res.status(400).json({ error: `cannot read backup: ${error instanceof Error ? error.message : String(error)}` })
    }

    const beforeList = settingsStore.read()['extensions']
    const outcome = await settingsStore.mutate((_current, save) => {
      save(restored)
    })
    const afterList = settingsStore.read()['extensions']
    const audit = appendAuditRecord(settingsStore.agentDir, {
      action: 'rollback',
      target: target,
      actor: actorOf(auth, req),
      ok: outcome.changed,
      backupPath: outcome.backupPath,
      before: Array.isArray(beforeList) ? (beforeList as string[]) : null,
      after: Array.isArray(afterList) ? (afterList as string[]) : null,
    })
    return res.json({ ok: true, changed: outcome.changed, backupPath: outcome.backupPath, audit, availableBackups: listBackups(backupsDir) })
  })
}

/** Newest first, for the UI picker. */
export function listBackups(backupsDir: string): string[] {
  try {
    return readdirSync(backupsDir)
      .filter((name) => /^settings-.*\.json$/.test(name))
      .sort()
      .reverse()
      .slice(0, 50)
      .map((name) => join(backupsDir, name))
  } catch {
    return []
  }
}
