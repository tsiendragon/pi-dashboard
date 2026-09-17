import type { Express, Request, Response } from 'express'
import type { PlanningOverlay } from '@shared/tasks.js'
import type { TaskService } from '../tasks/service.js'
import type { TaskCreateInput, TaskUpdateInput } from '../tasks/types.js'

export interface TaskRouteOptions {
  app: Express
  service: TaskService
}

function fail(res: Response, error: unknown): void {
  res.status(500).json({ error: 'tasks_failed', message: error instanceof Error ? error.message : String(error) })
}

/** Map service-level error codes to HTTP status for write endpoints. */
function writeError(res: Response, error: unknown): void {
  const code = error instanceof Error ? error.message : ''
  if (code === 'title_required') return void res.status(400).json({ error: code })
  if (code === 'read_only_source') return void res.status(409).json({ error: code, message: '此来源只读，修改请走 task-pilot' })
  if (code === 'task_not_found' || code === 'provider_not_found') return void res.status(404).json({ error: code })
  if (code === 'no_writable_provider') return void res.status(409).json({ error: code, message: '没有可写入的任务来源' })
  fail(res, error)
}

export function registerTaskRoutes({ app, service }: TaskRouteOptions): void {
  app.get('/api/tasks', async (_req: Request, res: Response) => {
    try {
      res.json(await service.snapshot())
    } catch (error) {
      fail(res, error)
    }
  })

  // Register concrete paths before the `:uid` catch-all.
  app.get('/api/tasks/providers', async (_req: Request, res: Response) => {
    try {
      const { providers, warnings } = await service.snapshot()
      res.json({ providers, warnings })
    } catch (error) {
      fail(res, error)
    }
  })

  app.get('/api/tasks/planning', async (_req: Request, res: Response) => {
    try {
      res.json(await service.planning())
    } catch (error) {
      fail(res, error)
    }
  })

  app.get('/api/tasks/history', async (req: Request, res: Response) => {
    try {
      const days = Math.min(365, Math.max(1, Number(req.query.days) || 30))
      res.json({ points: await service.historySeries(days) })
    } catch (error) {
      fail(res, error)
    }
  })

  app.put('/api/tasks/planning', async (req: Request, res: Response) => {
    try {
      const body = req.body as { overlay?: PlanningOverlay; patch?: PlanningOverlay; expectedVersion?: number }
      const patch = body?.patch ?? body?.overlay
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return res.status(400).json({ error: 'invalid_body', message: 'expect { patch: { <uid>: {...} } }' })
      }
      const expectedVersion = typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined
      const result = await service.updatePlanning(patch, expectedVersion)
      if (result.conflict) {
        return res.status(409).json({ error: 'planning_conflict', version: result.version, overlay: result.overlay })
      }
      res.json(result)
    } catch (error) {
      fail(res, error)
    }
  })

  app.post('/api/tasks', async (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as TaskCreateInput
      res.status(201).json({ task: await service.createTask(body) })
    } catch (error) {
      writeError(res, error)
    }
  })

  app.patch('/api/tasks/:uid', async (req: Request, res: Response) => {
    try {
      const patch = (req.body || {}) as TaskUpdateInput
      res.json({ task: await service.updateTask(String(req.params.uid), patch) })
    } catch (error) {
      writeError(res, error)
    }
  })

  app.delete('/api/tasks/:uid', async (req: Request, res: Response) => {
    try {
      await service.deleteTask(String(req.params.uid))
      res.json({ ok: true })
    } catch (error) {
      writeError(res, error)
    }
  })

  app.get('/api/tasks/:uid', async (req: Request, res: Response) => {
    try {
      const task = await service.get(String(req.params.uid))
      if (!task) return res.status(404).json({ error: 'task_not_found' })
      res.json({ task })
    } catch (error) {
      fail(res, error)
    }
  })
}
