import type { Express, Request, Response } from 'express'
import type { CodeChurnLedger } from '../code-churn.js'

export interface CodeChurnRouteOptions {
  app: Express
  ledger: CodeChurnLedger
}

function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

export function registerCodeChurnRoutes(options: CodeChurnRouteOptions): void {
  options.app.get('/api/code-churn', async (req: Request, res: Response) => {
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
        error: 'invalid_code_churn_query',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })
}