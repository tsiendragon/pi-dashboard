export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = typeof THINKING_LEVELS[number]

const THINKING_SET = new Set<string>(THINKING_LEVELS)

export interface ModelLike {
  provider: string
  id: string
  name?: string | null
  reasoning?: boolean | null
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>> | null
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_SET.has(value)
}

export function splitThinkingSuffix(pattern: string): { modelPattern: string; thinkingLevel?: ThinkingLevel } {
  const idx = pattern.lastIndexOf(':')
  if (idx === -1) return { modelPattern: pattern }
  const suffix = pattern.slice(idx + 1)
  if (!isThinkingLevel(suffix)) return { modelPattern: pattern }
  return { modelPattern: pattern.slice(0, idx), thinkingLevel: suffix }
}

export function modelFullId(model: ModelLike): string {
  return `${model.provider}/${model.id}`
}

export function modelLabel(model: ModelLike): string {
  return model.name || model.id
}

export function splitModelFullId(fullId: string): { provider: string; modelId: string } | null {
  const idx = fullId.indexOf('/')
  if (idx === -1) return null
  const provider = fullId.slice(0, idx)
  const modelId = fullId.slice(idx + 1)
  if (!provider || !modelId) return null
  return { provider, modelId }
}

export function isConcreteModelPattern(pattern: string): boolean {
  const { modelPattern } = splitThinkingSuffix(pattern.trim())
  return !!modelPattern && !/[\*\?\[]/.test(modelPattern)
}

export function normalizeConcreteModelPattern(pattern: string): string | null {
  const { modelPattern } = splitThinkingSuffix(pattern.trim())
  if (!modelPattern || !isConcreteModelPattern(modelPattern)) return null
  return modelPattern
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

export function modelPatternMatches(pattern: string, model: ModelLike): boolean {
  const { modelPattern } = splitThinkingSuffix(pattern.trim())
  if (!modelPattern) return false
  const fullId = modelFullId(model)
  const id = model.id

  if (/[*?]/.test(modelPattern)) {
    const regex = globToRegExp(modelPattern)
    return regex.test(fullId) || regex.test(id)
  }

  return modelPattern === fullId || modelPattern === id
}

export function supportedThinkingLevels(model?: ModelLike | null): ThinkingLevel[] {
  if (!model) return [...THINKING_LEVELS]
  if (!model.reasoning) return ['off']

  return THINKING_LEVELS.filter(level => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null) return false
    // pi only exposes xhigh / max when a model explicitly maps them, so a model
    // that never mentions them must not show them as choices.
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

export function clampThinkingLevel(model: ModelLike | undefined | null, level: ThinkingLevel): ThinkingLevel {
  const available = supportedThinkingLevels(model)
  if (available.includes(level)) return level

  const requestedIndex = THINKING_LEVELS.indexOf(level)
  if (requestedIndex === -1) return available[0] || 'off'

  for (let i = requestedIndex; i < THINKING_LEVELS.length; i++) {
    const candidate = THINKING_LEVELS[i]
    if (available.includes(candidate)) return candidate
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    const candidate = THINKING_LEVELS[i]
    if (available.includes(candidate)) return candidate
  }
  return available[0] || 'off'
}

export function preferredThinkingLevel(
  model: ModelLike | undefined | null,
  enabledModels: string[],
  fallback: ThinkingLevel = 'medium'
): ThinkingLevel {
  for (const pattern of enabledModels) {
    const { thinkingLevel } = splitThinkingSuffix(pattern.trim())
    if (!thinkingLevel) continue
    if (model && modelPatternMatches(pattern, model)) return clampThinkingLevel(model, thinkingLevel)
  }
  return clampThinkingLevel(model, fallback)
}
