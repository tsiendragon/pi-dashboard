import { describe, expect, it } from 'vitest'
import { filterEnabledModels, modelPatternMatches, splitThinkingSuffix } from '../model-match.js'

describe('model-match', () => {
  const gpt55 = { provider: 'bedrock-mantle', id: 'openai.gpt-5.5', name: 'OpenAI GPT-5.5 (Bedrock)' }
  const claude = { provider: 'anthropic', id: 'claude-sonnet-v1:0', name: 'Claude Sonnet' }

  it('strips thinking suffixes without corrupting version colons', () => {
    expect(splitThinkingSuffix('bedrock-mantle/openai.gpt-5.5:xhigh')).toEqual({
      modelPattern: 'bedrock-mantle/openai.gpt-5.5',
      thinkingLevel: 'xhigh',
    })
    expect(splitThinkingSuffix('amazon-bedrock/anthropic.claude-sonnet-v1:0')).toEqual({
      modelPattern: 'amazon-bedrock/anthropic.claude-sonnet-v1:0',
    })
  })

  it('matches provider/model, bare model, and glob patterns', () => {
    expect(modelPatternMatches('bedrock-mantle/openai.gpt-5.5:xhigh', gpt55)).toBe(true)
    expect(modelPatternMatches('openai.gpt-5.5:xhigh', gpt55)).toBe(true)
    expect(modelPatternMatches('bedrock-mantle/openai.gpt-5.*:xhigh', gpt55)).toBe(true)
    expect(modelPatternMatches('anthropic/claude-sonnet-v1:0', claude)).toBe(true)
  })

  it('filters to enabled models in pattern order, deduped', () => {
    const all = [
      claude,
      { provider: 'openai-codex', id: 'gpt-5.6-luna', name: null },
      { provider: 'dashscope', id: 'deepseek-v4-pro-0813', name: null },
      { provider: 'openai-codex', id: 'gpt-5.6-luna', name: 'dup' },
      gpt55,
    ]
    const enabled = ['openai-codex/gpt-5.6-luna', 'dashscope/*']
    const out = filterEnabledModels(all, enabled)
    expect(out.map(m => `${m.provider}/${m.id}`)).toEqual([
      'openai-codex/gpt-5.6-luna',
      'dashscope/deepseek-v4-pro-0813',
    ])
  })

  it('returns nothing when no enabled pattern matches', () => {
    expect(filterEnabledModels([claude, gpt55], ['azure-okx/gpt-5.6-sol'])).toEqual([])
  })
})