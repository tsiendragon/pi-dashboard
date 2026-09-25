/**
 * Write routes for the Extensions page (P2).
 *
 *   POST /api/pi/ext/toggle  { path, enabled }   → rewrite the entry's `+`/`-` prefix in place
 *   PUT  /api/pi/ext/order   { paths: string[] } → reorder the unprefixed entries
 *
 * Both go through `SettingsStore` (serialized + backed up + atomic). The response always carries the
 * before/after arrays, the backup path and a readable diff, so the page can show what happened.
 *
 * Both require the Live Session browser auth: the server binds `0.0.0.0` and has no global auth
 * middleware, so a route that rewrites `settings.json` must not be reachable unauthenticated.
 */
import type { Express, Request, Response } from 'express'
import type { LiveSessionBrowserAuth } from '../live-sessions/auth.js'
import { appendAuditRecord } from '../ext-audit.js'
import { applyOrder, applyToggle, describeDiff } from '../ext-writes.js'
import { requireBrowserAuth } from './require-browser-auth.js'
import { settingsStore } from '../settings-store.js'

function readEntries(settings: Record<string, unknown>): string[] {
  const extensions = settings['extensions']
  return Array.isArray(extensions) ? (extensions as unknown[]).filter((entry): entry is string => typeof entry === 'string') : []
}

export function registerPiExtWriteRoutes({ app, auth }: { app: Express; auth: LiveSessionBrowserAuth }): void {
  const store = settingsStore
  const requireAuth = requireBrowserAuth(auth)

  app.post('/api/pi/ext/toggle', requireAuth, async (req: Request, res: Response) => {
    const body = req.body as { path?: unknown; enabled?: unknown } | undefined
    const path = typeof body?.path === 'string' ? body.path : null
    const enabled = typeof body?.enabled === 'boolean' ? body.enabled : null
    if (!path) return res.status(400).json({ error: 'body must include a string `path`' })
    if (enabled === null) return res.status(400).json({ error: 'body must include a boolean `enabled`' })

    try {
      const outcome = await store.mutate((settings, save) => {
        const entries = readEntries(settings)
        let next: string[]
        try {
          next = applyToggle(entries, path, enabled ? 'enable' : 'disable')
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
        if (next.join('\u0000') === entries.join('\u0000')) return { before: entries, after: entries, unchanged: true }
        settings['extensions'] = next
        save(settings)
        return { before: entries, after: next }
      })

      const result = outcome.result as { error?: string; before: string[]; after: string[]; unchanged?: boolean }
      if (result.error) return res.status(404).json({ error: result.error })
      const audit = appendAuditRecord(store.agentDir, {
        action: 'toggle',
        target: path,
        actor: auth.getIdentity(req)?.browserClientId ?? null,
        ok: outcome.changed,
        backupPath: outcome.backupPath,
        before: result.before,
        after: result.after,
      })
      return res.json({
        ok: true,
        changed: outcome.changed,
        audit,
        backupPath: outcome.backupPath,
        before: result.before,
        after: result.after,
        diff: describeDiff({ before: result.before, after: result.after }),
        note: '禁用只改前缀，不会卸载代码：其它扩展仍可能 import 它的模块。',
      })
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.put('/api/pi/ext/order', requireAuth, async (req: Request, res: Response) => {
    const body = req.body as { paths?: unknown } | undefined
    const paths = Array.isArray(body?.paths) ? (body.paths as unknown[]) : null
    if (!paths || !paths.every((item): item is string => typeof item === 'string')) {
      return res.status(400).json({ error: 'body must include `paths: string[]`' })
    }

    try {
      const outcome = await store.mutate((settings, save) => {
        const entries = readEntries(settings)
        let next: string[]
        try {
          next = applyOrder(entries, paths)
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
        if (next.join('\u0000') === entries.join('\u0000')) return { before: entries, after: entries, unchanged: true }
        settings['extensions'] = next
        save(settings)
        return { before: entries, after: next }
      })

      const result = outcome.result as { error?: string; before: string[]; after: string[]; unchanged?: boolean }
      if (result.error) return res.status(400).json({ error: result.error })
      const audit = appendAuditRecord(store.agentDir, {
        action: 'order',
        target: `loadOrder(${paths.length})`,
        actor: auth.getIdentity(req)?.browserClientId ?? null,
        ok: outcome.changed,
        backupPath: outcome.backupPath,
        before: result.before,
        after: result.after,
      })
      return res.json({
        ok: true,
        changed: outcome.changed,
        audit,
        backupPath: outcome.backupPath,
        before: result.before,
        after: result.after,
        diff: describeDiff({ before: result.before, after: result.after }),
        note: '顺序约束：tool-result-pipeline 必须紧跟 web-tools；trajectory-recorder 与 capability 通常在最后。',
      })
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
}