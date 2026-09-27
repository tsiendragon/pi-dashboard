import { describe, expect, it } from 'vitest'
import { modelSelectionPatterns, selectedModelIds } from '../utils/modelSelection'

const models = [
  { provider: 'anthropic', id: 'claude-opus', name: 'Claude Opus' },
  { provider: 'anthropic', id: 'claude-sonnet', name: 'Claude Sonnet' },
  { provider: 'dashscope', id: 'kimi-k3', name: 'Kimi K3' },
]

describe('modelSelection', () => {
  it('uses the dashboard defaults when there is no explicit allowlist', () => {
    expect(selectedModelIds(models, [], [models[0], models[2]])).toEqual(new Set([
      'anthropic/claude-opus',
      'dashscope/kimi-k3',
    ]))
  })

  it('resolves provider and model glob patterns', () => {
    expect(selectedModelIds(models, ['anthropic/*'], [])).toEqual(new Set([
      'anthropic/claude-opus',
      'anthropic/claude-sonnet',
    ]))
  })

  it('compresses complete provider selections and preserves thinking levels', () => {
    expect(modelSelectionPatterns(models, new Set([
      'anthropic/claude-opus',
      'anthropic/claude-sonnet',
    ]), ['anthropic/*:high', 'unknown/*'])).toEqual([
      'unknown/*',
      'anthropic/*:high',
    ])
  })

  it('writes partial selections as exact IDs and keeps unmatched rules', () => {
    expect(modelSelectionPatterns(models, new Set(['anthropic/claude-opus']), [
      'anthropic/*:xhigh',
      'other-provider/model',
    ])).toEqual([
      'other-provider/model',
      'anthropic/claude-opus:xhigh',
    ])
  })
})
