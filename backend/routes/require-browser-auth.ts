/**
 * Browser-auth middleware for routes that change machine state.
 *
 * The dashboard binds `0.0.0.0` by default and has no global auth middleware, so any route that
 * writes to the machine must carry its own gate. This reuses the Live Session browser auth
 * (`pi_live_session` HttpOnly cookie) exactly like the terminal relay does — one credential
 * surface, not a second one.
 */
import type { NextFunction, Request, Response } from 'express'
import type { LiveSessionBrowserAuth } from '../live-sessions/auth.js'

export function requireBrowserAuth(auth: LiveSessionBrowserAuth) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!auth.isOriginAllowed(req, true)) {
      res.status(403).json({ error: 'cross_origin_forbidden' })
      return
    }
    if (!auth.getIdentity(req)) {
      res.status(401).json({
        error: 'authentication_required',
        hint: '在 dashboard 的终端面板（或 live session 页）粘贴启动日志里的 live-n 令牌完成一次认证，浏览器会拿到 HttpOnly cookie。',
      })
      return
    }
    next()
  }
}