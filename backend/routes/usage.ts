import type { Express, Request, Response } from 'express'
import { UsageLedger } from '../usage-ledger.js'

export interface UsageRouteOptions {
  app: Express
  ledger: UsageLedger
}

function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

export function registerUsageRoutes(options: UsageRouteOptions): void {
  options.app.get('/api/usage', async (req: Request, res: Response) => {
    const month = typeof req.query.month === 'string' && req.query.month.length > 0
      ? req.query.month
      : currentMonth()
    const timezone = typeof req.query.timezone === 'string' && req.query.timezone.length > 0
      ? req.query.timezone
      : undefined
    try {
      res.json(await options.ledger.getReport(month, timezone))
    } catch (error) {
      res.status(400).json({
        error: 'invalid_usage_query',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })
}
