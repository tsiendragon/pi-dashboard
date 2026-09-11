/**
 * REST routes for the web shared terminal (tmux relay).
 *
 * Auth reuses the Live Session browser auth: the same `live-control-token` + a
 * HttpOnly `pi_live_session` cookie. The terminal therefore does not introduce
 * a second credential surface — it inherits the live-session trust boundary.
 */
import type { Express, Request, Response, NextFunction } from 'express'
import type { LiveSessionBrowserAuth } from '../live-sessions/auth.js'
import {
  createTmuxSession,
  killTmuxSession,
  listTmuxSessions,
} from '../tmux-sessions.js'

export interface PtyRouteOptions {
  app: Express
  auth: LiveSessionBrowserAuth
}

export function registerPtyRoutes(options: PtyRouteOptions): void {
  const { app, auth } = options

  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    if (!auth.isOriginAllowed(req, true)) {
      res.status(403).json({ error: 'cross_origin_forbidden' })
      return
    }
    if (!auth.getIdentity(req)) {
      res.status(401).json({ error: 'authentication_required' })
      return
    }
    next()
  }

  app.post('/api/pty/auth', async (req: Request, res: Response) => {
    if (!auth.isOriginAllowed(req, true)) {
      res.status(403).json({ error: 'cross_origin_forbidden' })
      return
    }
    try {
      const result = await auth.authenticate(
        req.body?.token,
        auth.isSecure(req) || !!(req.socket as any).encrypted,
      )
      if (!result) {
        res.status(401).json({ error: 'authentication_failed' })
        return
      }
      res.setHeader('Set-Cookie', result.setCookie)
      res.json({ ok: true, browserClientId: result.browserClientId })
    } catch (error) {
      res.status(500).json({ error: 'auth_error', message: (error as Error).message })
    }
  })

  app.get('/api/pty/sessions', requireAuth, (_req: Request, res: Response) => {
    res.json({ sessions: listTmuxSessions() })
  })

  app.post('/api/pty/sessions', requireAuth, (req: Request, res: Response) => {
    try {
      const name = createTmuxSession(typeof req.body?.name === 'string' ? req.body.name : '')
      res.json({ name })
    } catch (error) {
      res.status(400).json({ error: 'invalid_session_name', message: (error as Error).message })
    }
  })

  app.delete('/api/pty/sessions/:name', requireAuth, (req: Request, res: Response) => {
    try {
      killTmuxSession(String(req.params.name))
      res.json({ ok: true })
    } catch (error) {
      res.status(400).json({ error: 'invalid_session_name', message: (error as Error).message })
    }
  })
}