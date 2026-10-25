import type { Express } from 'express'
import type { SubagentStatsLedger } from '../subagent-stats.js'

export function registerSubagentStatsRoutes({ app, ledger }: { app: Express; ledger: SubagentStatsLedger }): void {
  app.get('/api/subagent-stats', async (req, res) => {
    const rawDays = Number(req.query.days ?? 7)
    const days = Number.isFinite(rawDays) ? Math.min(90, Math.max(1, Math.round(rawDays))) : 7
    const timezone = typeof req.query.timezone === 'string' ? req.query.timezone : ''
    try {
      res.json(await ledger.getReport(days, timezone))
    } catch (error) {
      res.status(500).json({ message: error instanceof Error ? error.message : String(error) })
    }
  })
}