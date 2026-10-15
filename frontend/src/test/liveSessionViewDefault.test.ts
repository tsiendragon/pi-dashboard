import { describe, expect, it } from 'vitest'
import { defaultAuxiliaryView } from '../features/live-sessions/LiveSessionPage'

describe('时间线默认视图', () => {
  it('主 Agent 默认活动视图：只留关键节点与回复', () => {
    expect(defaultAuxiliaryView('main', false)).toBe(false)
  })

  it('子 Agent 与未知角色沿用旧默认：宽屏完整对话', () => {
    expect(defaultAuxiliaryView('subagent', false)).toBe(true)
    expect(defaultAuxiliaryView(undefined, false)).toBe(true)
  })

  it('窄屏一律默认活动视图', () => {
    expect(defaultAuxiliaryView('main', true)).toBe(false)
    expect(defaultAuxiliaryView('subagent', true)).toBe(false)
  })
})