/**
 * Model allowlist matching — kept semantically identical to the frontend's
 * `utils/modelUtils.ts` (`modelPatternMatches`) so `/api/models`, the
 * dashboard Model selector and pi's own `enabledModels` scoping all agree.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface ModelLike {
  provider?: string
  id?: string
  name?: string | null
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

function isThinkingLevel(value: string): boolean {
  return THINKING_LEVELS.includes(value)
}

/** Split an optional `:thinkingLevel` suffix off a model pattern. */
export function splitThinkingSuffix(pattern: string): { modelPattern: string; thinkingLevel?: string } {
  const idx = pattern.lastIndexOf(':')
  if (idx === -1) return { modelPattern: pattern }
  const suffix = pattern.slice(idx + 1)
  if (!isThinkingLevel(suffix)) return { modelPattern: pattern }
  return { modelPattern: pattern.slice(0, idx), thinkingLevel: suffix }
}

function modelFullId(model: ModelLike): string {
  return `${model.provider}/${model.id}`
}

function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i++ }
      else out += '[^/]*'
    } else if (c === '?') {
      out += '[^/]'
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      out += '\\' + c
    } else {
      out += c
    }
  }
  return new RegExp(`^${out}$`, 'i')
}

/** Mirrors `modelPatternMatches` in frontend `utils/modelUtils.ts`. */
export function modelPatternMatches(pattern: string, model: ModelLike): boolean {
  const { modelPattern } = splitThinkingSuffix(pattern.trim())
  if (!modelPattern || !model.provider || !model.id) return false
  const fullId = modelFullId(model)
  const id = model.id

  if (/[*?]/.test(modelPattern)) {
    const regex = globToRegExp(modelPattern)
    return regex.test(fullId) || regex.test(id)
  }

  return modelPattern === fullId || modelPattern === id
}

/** Read `enabledModels` / `disabledProviders` from ~/.pi/agent/settings.json. */
export function readPiModelSettings(): { enabledModels: string[]; disabledProviders: string[] } {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), '.pi', 'agent', 'settings.json'), 'utf-8'))
    return {
      enabledModels: Array.isArray(raw.enabledModels) ? raw.enabledModels.filter((p: unknown): p is string => typeof p === 'string') : [],
      disabledProviders: Array.isArray(raw.disabledProviders) ? raw.disabledProviders.filter((p: unknown): p is string => typeof p === 'string') : [],
    }
  } catch {
    return { enabledModels: [], disabledProviders: [] }
  }
}

/** Return the models allowed by `enabledModels`, in the order the patterns appear. */
export function filterEnabledModels(models: ModelLike[], enabledModels: string[]): ModelLike[] {
  if (enabledModels.length === 0) return []
  const result: ModelLike[] = []
  const seen = new Set<string>()
  for (const pattern of enabledModels) {
    for (const m of models) {
      if (!modelPatternMatches(pattern, m)) continue
      const key = modelFullId(m)
      if (seen.has(key)) continue
      seen.add(key)
      result.push(m)
    }
  }
  return result
}