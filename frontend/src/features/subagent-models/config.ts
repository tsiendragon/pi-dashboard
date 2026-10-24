/** Pure helpers for editing `subagent-models.json` (schema v1). Unknown keys are preserved by spreading. */
export const TIERS = ['light', 'medium', 'heavy', 'ultra'] as const
export type Tier = (typeof TIERS)[number]
/** Automatic escalation never reaches heavy/ultra (same rule as the workbench extension). */
export const AUTO_ESCALATION_TIERS: readonly Tier[] = ['light', 'medium']
export const TIER_LABEL: Record<Tier, string> = { light: '轻量', medium: '普通', heavy: '强', ultra: '超强' }
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export const ACTIONS = ['wait', 'wait_then_escalate', 'escalate', 'fail'] as const
export const ACTION_LABEL: Record<string, string> = { wait: '等待', wait_then_escalate: '先等待，超时后升级', escalate: '直接升级', fail: '直接失败' }
export const ROLES = ['read_only', 'research', 'code'] as const
export const ROLE_LABEL: Record<string, string> = { read_only: '只读任务', research: '调研任务', code: '改代码任务' }

export interface Candidate { model: string; thinking?: string; maxConcurrency?: number; quotaGroup?: string; [k: string]: unknown }
export interface OnExhausted { action: string; maxWaitMs?: number; escalateTo?: Tier; [k: string]: unknown }
export interface TierConfig { candidates: Candidate[]; spillover?: boolean; onExhausted?: OnExhausted; [k: string]: unknown }
export interface SubagentModelsConfig {
  version: 1
  defaultTier: Tier
  roles: Record<string, Tier>
  allowInherit: boolean
  tiers: Record<Tier, TierConfig>
  timeouts?: { workHardMs?: number; workHardMaxMs?: number }
  budgets?: { maxModelCallsPerTask?: number }
  [k: string]: unknown
}

export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

export function emptyConfig(): SubagentModelsConfig {
  return {
    version: 1,
    defaultTier: 'medium',
    roles: { read_only: 'light', research: 'medium', code: 'medium' },
    allowInherit: false,
    tiers: { light: { candidates: [] }, medium: { candidates: [] }, heavy: { candidates: [] }, ultra: { candidates: [] } },
  }
}

export function tierOf(config: SubagentModelsConfig, model: string): Tier | null {
  return TIERS.find(t => config.tiers[t]?.candidates.some(c => c.model === model)) ?? null
}

/** Move a model to `tier` (appended at the end, keeping its advanced options when it moves) or remove it (null). */
export function assignModel(config: SubagentModelsConfig, model: string, tier: Tier | null): SubagentModelsConfig {
  const existing = TIERS.flatMap(t => config.tiers[t].candidates).find(c => c.model === model)
  const tiers = { ...config.tiers }
  for (const t of TIERS) tiers[t] = { ...tiers[t], candidates: tiers[t].candidates.filter(c => c.model !== model) }
  if (tier) tiers[tier] = { ...tiers[tier], candidates: [...tiers[tier].candidates, existing ?? { model }] }
  return { ...config, tiers }
}

export function moveCandidate(config: SubagentModelsConfig, tier: Tier, index: number, delta: -1 | 1): SubagentModelsConfig {
  const list = [...config.tiers[tier].candidates]
  const target = index + delta
  if (target < 0 || target >= list.length) return config
  ;[list[index], list[target]] = [list[target], list[index]]
  return { ...config, tiers: { ...config.tiers, [tier]: { ...config.tiers[tier], candidates: list } } }
}

export function patchCandidate(config: SubagentModelsConfig, tier: Tier, index: number, patch: Partial<Candidate>): SubagentModelsConfig {
  const list = config.tiers[tier].candidates.map((c, i) => {
    if (i !== index) return c
    const next = { ...c, ...patch }
    for (const key of Object.keys(patch)) if (next[key] === undefined || next[key] === '') delete next[key]
    return next
  })
  return { ...config, tiers: { ...config.tiers, [tier]: { ...config.tiers[tier], candidates: list } } }
}

export function patchTier(config: SubagentModelsConfig, tier: Tier, patch: Partial<TierConfig>): SubagentModelsConfig {
  return { ...config, tiers: { ...config.tiers, [tier]: { ...config.tiers[tier], ...patch } } }
}

/** Hours/days input -> ms; empty input -> undefined (key removed). */
export function unitToMs(value: string, unitMs: number): number | undefined {
  const n = Number(value)
  return value.trim() === '' || !Number.isFinite(n) || n <= 0 ? undefined : Math.round(n * unitMs)
}
export function msToUnit(ms: number | undefined, unitMs: number): string {
  return ms === undefined ? '' : String(Math.round((ms / unitMs) * 100) / 100)
}
