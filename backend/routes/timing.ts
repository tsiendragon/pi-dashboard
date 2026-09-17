import type { Express, Request, Response } from 'express'
import { TimingLedger } from '../timing-ledger.js'
import type { TimingRange } from '../../shared/src/timing.js'

export interface TimingRouteOptions {
  app: Express
  ledger: TimingLedger
}

function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function parseRange(value: unknown): TimingRange {
  return value === '7d' || value === '30d' ? value : 'month'
}

export function registerTimingRoutes(options: TimingRouteOptions): void {
  options.app.get('/api/timing', async (req: Request, res: Response) => {
    const range = parseRange(req.query.range)
    const month = typeof req.query.month === 'string' && req.query.month.length > 0
      ? req.query.month
      : currentMonth()
    const timezone = typeof req.query.timezone === 'string' && req.query.timezone.length > 0
      ? req.query.timezone
      : undefined
    try {
      res.json(await options.ledger.getReport(range, month, timezone))
    } catch (error) {
      res.status(400).json({
        error: 'invalid_timing_query',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })
}