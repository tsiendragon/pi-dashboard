/**
 * Routes: `GET|PUT /api/subagent-models` — edit `<agent dir>/subagent-models.json` (schema v1).
 *
 * Only validates structure; unknown keys are kept verbatim. Writes are serialized, optimistic
 * (`baseMtimeMs` must match the file), backed up to `<agent dir>/backups/`, and atomic (tmp + rename).
 * The file holds model references only, never credentials.
 */
import type { Express, Request, Response } from 'express'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { LiveSessionBrowserAuth } from '../live-sessions/auth.js'
import { requireBrowserAuth } from './require-browser-auth.js'
import { defaultAgentDir } from '../settings-store.js'

const TIERS = ['light', 'medium', 'heavy', 'ultra'] as const
const ROLES = ['read_only', 'research', 'code'] as const
const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
const ACTIONS = ['wait', 'wait_then_escalate', 'escalate', 'fail']
const MODEL_REF = /^[^/\s]+\/\S+$/

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
const isPosInt = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 1

/** Returns an error message, or null when the config is acceptable. */
export function validateSubagentModels(config: unknown): string | null {
  if (!isObj(config)) return 'config must be an object'
  if (config['version'] !== 1) return 'version must be 1'
  if (!TIERS.includes(config['defaultTier'] as never)) return `invalid defaultTier: ${String(config['defaultTier'])}`
  const roles = config['roles']
  if (!isObj(roles)) return 'roles must be an object'
  for (const role of ROLES) if (!TIERS.includes(roles[role] as never)) return `invalid tier for role ${role}: ${String(roles[role])}`
  if (typeof config['allowInherit'] !== 'boolean') return 'allowInherit must be a boolean'
  const tiers = config['tiers']
  if (!isObj(tiers)) return 'tiers must be an object'
  const seen = new Map<string, string>()
  for (const tier of TIERS) {
    const t = tiers[tier]
    if (!isObj(t)) return `tiers.${tier} must be an object`
    if (!Array.isArray(t['candidates'])) return `tiers.${tier}.candidates must be an array`
    for (const c of t['candidates'] as unknown[]) {
      if (!isObj(c) || typeof c['model'] !== 'string' || !MODEL_REF.test(c['model'])) return `invalid model ref in tier ${tier}: ${isObj(c) ? String(c['model']) : String(c)}`
      const model = c['model']
      if (seen.has(model)) return `duplicate model ${model} in tiers ${seen.get(model)} and ${tier}`
      seen.set(model, tier)
      if (c['thinking'] !== undefined && !THINKING.includes(c['thinking'] as string)) return `invalid thinking for ${model}: ${String(c['thinking'])}`
      if (c['maxConcurrency'] !== undefined && !isPosInt(c['maxConcurrency'])) return `invalid maxConcurrency for ${model}`
      if (c['quotaGroup'] !== undefined && typeof c['quotaGroup'] !== 'string') return `invalid quotaGroup for ${model}`
    }
    if (t['spillover'] !== undefined && typeof t['spillover'] !== 'boolean') return `tiers.${tier}.spillover must be a boolean`
    const ex = t['onExhausted']
    if (ex !== undefined) {
      if (!isObj(ex) || !ACTIONS.includes(ex['action'] as string)) return `invalid onExhausted.action in tier ${tier}: ${isObj(ex) ? String(ex['action']) : String(ex)}`
      if (ex['maxWaitMs'] !== undefined && !isPosInt(ex['maxWaitMs'])) return `invalid maxWaitMs in tier ${tier}`
      if (ex['escalateTo'] !== undefined && !TIERS.includes(ex['escalateTo'] as never)) return `invalid escalateTo in tier ${tier}: ${String(ex['escalateTo'])}`
      // Same rule as the workbench extension: automatic escalation stays in light/medium.
      if ((ex['action'] === 'escalate' || ex['action'] === 'wait_then_escalate') &&
        (!['light', 'medium'].includes(ex['escalateTo'] as string) || ex['escalateTo'] === tier)) {
        return `tiers.${tier}.onExhausted.escalateTo must be light or medium and differ from ${tier}`
      }
    }
  }
  const timeouts = config['timeouts']
  if (timeouts !== undefined) {
    if (!isObj(timeouts)) return 'timeouts must be an object'
    for (const key of ['workHardMs', 'workHardMaxMs']) if (timeouts[key] !== undefined && !isPosInt(timeouts[key])) return `invalid timeouts.${key}`
  }
  const budgets = config['budgets']
  if (budgets !== undefined) {
    if (!isObj(budgets)) return 'budgets must be an object'
    if (budgets['maxModelCallsPerTask'] !== undefined && !isPosInt(budgets['maxModelCallsPerTask'])) return 'invalid budgets.maxModelCallsPerTask'
  }
  return null
}

function buildWarnings(config: Obj, catalog: Set<string> | null): string[] {
  const warnings: string[] = []
  const tiers = config['tiers'] as Record<string, Obj>
  const count = (tier: string): number => ((tiers[tier]?.['candidates'] as unknown[]) ?? []).length
  for (const tier of TIERS) {
    if (count(tier) === 0) warnings.push(`tier ${tier} is empty`)
    const to = (tiers[tier]?.['onExhausted'] as Obj | undefined)?.['escalateTo']
    if (typeof to === 'string' && count(to) === 0) warnings.push(`tier ${tier} escalates to empty tier ${to}`)
    if (catalog) {
      for (const c of (tiers[tier]?.['candidates'] as Obj[]) ?? []) {
        if (!catalog.has(c['model'] as string)) warnings.push(`model ${String(c['model'])} (tier ${tier}) is not in the model catalog`)
      }
    }
  }
  return warnings
}

export function registerSubagentModelsRoutes({ app, manager, auth, agentDir }: {
  app: Express
  manager: { getModels: () => Promise<any[]> | any[] }
  auth: LiveSessionBrowserAuth
  agentDir?: () => string
}): void {
  const dir = agentDir ?? defaultAgentDir
  const filePath = (): string => join(dir(), 'subagent-models.json')
  const requireAuth = requireBrowserAuth(auth)
  let queue: Promise<unknown> = Promise.resolve()

  const loadCatalog = async (): Promise<Set<string> | null> => {
    try {
      const models = await manager.getModels()
      return new Set(models.map((m: any) => `${m.provider}/${m.id}`))
    } catch {
      return null // catalog unavailable: skip the "not in catalog" warning instead of flagging everything
    }
  }

  app.get('/api/subagent-models', async (_req: Request, res: Response) => {
    const path = filePath()
    if (!existsSync(path)) return res.json({ config: null, mtimeMs: null, path, warnings: [] })
    try {
      const config: unknown = JSON.parse(readFileSync(path, 'utf-8'))
      const mtimeMs = statSync(path).mtimeMs
      const problem = validateSubagentModels(config)
      const warnings = problem ? [`file is not valid schema v1: ${problem}`] : buildWarnings(config as Obj, await loadCatalog())
      return res.json({ config, mtimeMs, path, warnings })
    } catch (error) {
      return res.status(500).json({ error: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` })
    }
  })

  app.put('/api/subagent-models', requireAuth, (req: Request, res: Response) => {
    const body = req.body as { config?: unknown; baseMtimeMs?: unknown } | undefined
    const problem = validateSubagentModels(body?.config)
    if (problem) return res.status(400).json({ error: problem })
    const config = body!.config as Obj
    const baseMtimeMs = body?.baseMtimeMs
    const run = async (): Promise<void> => {
      const path = filePath()
      const exists = existsSync(path)
      const current = exists ? statSync(path).mtimeMs : null
      if (current !== (typeof baseMtimeMs === 'number' ? baseMtimeMs : null)) {
        res.status(409).json({ error: 'subagent-models.json changed on disk since it was loaded', mtimeMs: current })
        return
      }
      mkdirSync(join(dir(), 'backups'), { recursive: true })
      let backupPath: string | null = null
      if (exists) {
        backupPath = join(dir(), 'backups', `subagent-models-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
        copyFileSync(path, backupPath)
      }
      const temp = `${path}.tmp-${process.pid}`
      writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
      renameSync(temp, path)
      res.json({ ok: true, mtimeMs: statSync(path).mtimeMs, path, backupPath, warnings: buildWarnings(config, await loadCatalog()) })
    }
    const chained = queue.then(run, run).catch((error: unknown) => {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    })
    queue = chained
  })
}
