import type { Express, Request, Response, NextFunction } from 'express'
import path from 'node:path'
import os from 'node:os'
import { realpath } from 'node:fs/promises'
import type { LiveSessionBrowserAuth } from '../live-sessions/auth.js'
import { requireBrowserAuth } from './require-browser-auth.js'
import { getDashConfig, saveDashConfig } from '../pi-env.js'
import type { SupervisorConfig, SupervisorRequest } from '../../shared/src/supervisor.js'
import type { SupervisorRuntime } from '../supervisor/runtime.js'
import type { SupervisorService } from '../supervisor/service.js'
import type { SupervisorStore } from '../supervisor/store.js'
import { minimalSupervisorConfig, normalizeEventTypes, normalizeSupervisorConfig } from '../supervisor/config.js'

function routeError(res: Response, e: unknown): void {
  const value = e as { status?: number; code?: string; message?: string }
  res.status(value.status || (/read_only|forbidden|not_authorized/.test(value.code || value.message || '') ? 403 : 400)).json({ error: value.code || 'supervisor_failed', message: value.message || String(e) })
}
/** Protect private archives from the dashboard's generic file-reading routes, including symlink aliases. */
export function protectSupervisorFiles(root: string, auth: LiveSessionBrowserAuth) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!/^\/api\/(?:file|files|local-file|path-complete|browse|read|download|image|save-image|upload-files|pi\/file|skills|styles)/i.test(req.path)) return next()
    const candidates: string[] = []
    const visit = (value: unknown): void => {
      if (typeof value === 'string' && !value.includes('\0')) candidates.push(value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value)
      else if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') Object.entries(value).forEach(([key, child]) => { if (!['content', 'data', 'text', 'comment', 'body', 'css'].includes(key)) visit(child) })
    }
    visit(req.query); visit(req.body); visit(req.params)
    const agentDir = process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
    if (/^\/api\/pi\/file/i.test(req.path)) for (const value of [...candidates]) if (!path.isAbsolute(value)) candidates.push(path.join(agentDir, value))
    const skillName = req.path.match(/^\/api\/skills\/([^/]+)/i)?.[1]
    if (skillName) for (const value of [...candidates]) if (!path.isAbsolute(value)) candidates.push(path.join(os.homedir(), '.pi', 'agent', 'skills', decodeURIComponent(skillName), value))
    const styleName = req.path.match(/^\/api\/styles\/([^/]+)/i)?.[1]
    if (styleName) candidates.push(path.join(os.homedir(), '.pi', 'dashboard', 'styles', decodeURIComponent(styleName) + '.css'))
    if (/^\/api\/styles(?:-active)?\/?$/i.test(req.path)) candidates.push(path.join(os.homedir(), '.pi', 'dashboard', 'styles', '.active'))
    try {
      const canonicalize: (value: string) => Promise<string> = async value => {
        const absolute = path.resolve(value)
        try { return await realpath(absolute) } catch(error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENAMETOOLONG') return absolute
          // Missing parents are resolved recursively so aliases of the archive are still caught.
          if (!['ENOENT', 'ENOTDIR'].includes(code || '')) return absolute
          const parent = path.dirname(absolute)
          return parent === absolute ? absolute : path.join(await canonicalize(parent), path.basename(absolute))
        }
      }
      const privateRoots = await Promise.all([root, ...(auth.tokenPath ? [path.dirname(auth.tokenPath)] : [])].map(canonicalize))
      const privateToken = await canonicalize(path.join(os.homedir(), '.pi', 'dashboard-token'))
      for (const value of candidates) {
        const actual = await canonicalize(path.resolve(value))
        if (actual === privateToken || privateRoots.some(privateRoot => actual === privateRoot || actual.startsWith(privateRoot + path.sep))) {
          // Only the dedicated attachment/report API may read the archive, even after browser authentication.
          res.status(403).json({ error: 'protected_supervisor_archive', message: '请通过监督页面的受保护接口访问档案。' }); return
        }
      }
      next()
    } catch(e) { routeError(res, e) }
  }
}
export function registerSupervisorRoutes(options: { app: Express; auth: LiveSessionBrowserAuth; runtime: SupervisorRuntime; service: SupervisorService; store: SupervisorStore }): void {
  const { app, auth, runtime, service, store } = options
  app.use('/api/supervisor', requireBrowserAuth(auth), (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next() })
  app.get('/api/supervisor/config', (_req, res) => res.json(normalizeSupervisorConfig(getDashConfig().supervisor)))
  app.put('/api/supervisor/config', (req, res) => {
    try {
      const raw = req.body?.config as SupervisorConfig
      if (!raw || typeof raw !== 'object' || typeof raw.enabled !== 'boolean') return res.status(400).json({ error: 'invalid_supervisor_config' })
      const rawTypes = (raw as { eventTypes?: unknown }).eventTypes
      if (rawTypes !== undefined && normalizeEventTypes(rawTypes) === null) return res.status(400).json({ error: 'invalid_event_types', message: 'Event types must be unique lowercase identifiers, at most 32, without reserved working_state/suggestion.' })
      const config = normalizeSupervisorConfig(raw)
      const paths = [config.cwd, config.agentResources.rolePath, ...config.agentResources.skillPaths, ...config.agentResources.extensionPaths, ...config.allowedRoots]
      if (paths.some(p => !path.isAbsolute(p)) || !Number.isFinite(config.pollIntervalMs) || !Number.isFinite(config.staleAfterMs)) return res.status(400).json({ error: 'absolute_paths_and_finite_intervals_required' })
      saveDashConfig({ ...getDashConfig(), supervisor: minimalSupervisorConfig(config) }); return res.json(config)
    } catch(e) { routeError(res, e) }
  })
  app.get('/api/supervisor/state', async (_req, res) => { try { res.json(await runtime.state()) } catch(e) { routeError(res, e) } })
  app.post('/api/supervisor/agent/start', async (_req, res) => { try { res.json(await runtime.start()) } catch(e) { routeError(res, e) } })
  app.get('/api/supervisor/agent/detail', (_req, res) => { try { res.json(runtime.detail()) } catch(e) { routeError(res, e) } })
  app.post('/api/supervisor/agent/input', async (req, res) => {
    try {
      const text = typeof req.body?.text === 'string' ? req.body.text : ''
      const ids = Array.isArray(req.body?.attachmentIds) ? req.body.attachmentIds : []
      for (const id of ids) await store.readAttachment(String(id))
      const images = req.body?.images
      if (images !== undefined && (!Array.isArray(images) || images.length > 4 || images.some((i: { type?: string; data?: string; mimeType?: string }) => i.type !== 'image' || typeof i.data !== 'string' || !['image/png','image/jpeg','image/webp'].includes(i.mimeType || '')))) return res.status(400).json({ error: 'invalid_images' })
      if (images && JSON.stringify(images).length > 8 * 1024 * 1024) return res.status(413).json({ error: 'images_too_large' })
      await runtime.input(text, images, ids, typeof req.body?.objectRef === 'string' ? req.body.objectRef : undefined); res.json({ ok: true })
    } catch(e) { routeError(res, e) }
  })
  app.post('/api/supervisor/execute', async (req, res) => {
    try {
      const request = req.body as SupervisorRequest
      // Pages use this endpoint to read. All writes use the single Agent entrance and its verified user grant.
      if (!['context','events','query','analyze'].includes(request.operation)) return res.status(403).json({ error: 'use_primary_agent_entry' })
      res.json({ result: await service.execute(request, { actor: '浏览器', userInitiated: false }) })
    } catch(e) { routeError(res, e) }
  })
  app.post('/api/supervisor/attachments', async (req, res) => {
    try {
      if (!runtime.config.enabled) return res.status(403).json({ error: 'supervisor_disabled' })
      if (typeof req.body?.data !== 'string' || req.body.data.length > 4 * 1024 * 1024 + 100) return res.status(413).json({ error: 'invalid_attachment_size' })
      const attachment = await store.uploadImage({ name: String(req.body.name || '截图'), mime: String(req.body.mime || ''), data: Buffer.from(req.body.data, 'base64') }); res.status(201).json({ attachment })
    } catch(e) { routeError(res, e) }
  })
  app.get('/api/supervisor/attachments/:id', async (req, res) => {
    try { const result = await store.readAttachment(String(req.params.id)); res.set('X-Content-Type-Options', 'nosniff').type(result.metadata.mime).send(result.data) } catch(e) { routeError(res, e) }
  })
}
