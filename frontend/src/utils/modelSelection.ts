import {
  modelFullId,
  modelPatternMatches,
  splitThinkingSuffix,
  type ModelLike,
} from './modelUtils'

type SelectableModel = ModelLike & { provider: string; id: string }

/** Resolve the current allowlist against the models Pi knows about. */
export function selectedModelIds(
  models: SelectableModel[],
  patterns: string[],
  defaultModels: SelectableModel[],
): Set<string> {
  if (patterns.length === 0) return new Set(defaultModels.map(modelFullId))
  return new Set(
    models
      .filter(model => patterns.some(pattern => modelPatternMatches(pattern, model)))
      .map(modelFullId),
  )
}

/**
 * Convert a click-based selection back to Pi's enabledModels patterns.
 * Fully selected providers are compressed to provider/*; partial selections
 * remain exact IDs. Thinking-level suffixes and patterns for models not in the
 * current catalog are preserved.
 */
export function modelSelectionPatterns(
  models: SelectableModel[],
  selectedIds: Set<string>,
  previousPatterns: string[],
): string[] {
  const unmatchedPatterns = previousPatterns.filter(pattern =>
    !models.some(model => modelPatternMatches(pattern, model)),
  )
  const providers = [...new Set(models.map(model => model.provider))].sort()
  const output = [...unmatchedPatterns]

  for (const provider of providers) {
    const providerModels = models.filter(model => model.provider === provider)
    const selected = providerModels.filter(model => selectedIds.has(modelFullId(model)))
    if (selected.length === 0) continue

    const levels = new Map(selected.map(model => {
      const matching = previousPatterns.find(pattern => modelPatternMatches(pattern, model))
      return [modelFullId(model), matching ? splitThinkingSuffix(matching).thinkingLevel : undefined]
    }))
    const suffixFor = (model: SelectableModel) => {
      const level = levels.get(modelFullId(model))
      return level ? `:${level}` : ''
    }

    if (selected.length === providerModels.length) {
      const suffixes = new Set(selected.map(suffixFor))
      if (suffixes.size === 1) {
        output.push(`${provider}/*${suffixFor(selected[0])}`)
        continue
      }
    }

    output.push(...selected.map(model => `${modelFullId(model)}${suffixFor(model)}`))
  }

  return output
}
