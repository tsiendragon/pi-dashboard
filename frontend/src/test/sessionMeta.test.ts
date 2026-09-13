import { describe, it, expect } from 'vitest'
import {
  isSystemTag, visibleTags, tagColorClass, projectName, relTime, slotOrder, tagCounts,
} from '../pages/chat/sessionMeta'

const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

describe('isSystemTag', () => {
  it('hides the job namespace and the legacy bare job tag', () => {
    expect(isSystemTag('job:abc123')).toBe(true)
    expect(isSystemTag('job')).toBe(true)
    expect(isSystemTag('subagent:7')).toBe(true)
  })
  it('keeps human tags', () => {
    expect(isSystemTag('router')).toBe(false)
    expect(isSystemTag('ocr')).toBe(false)
    expect(isSystemTag(undefined)).toBe(false)
  })
})

describe('visibleTags', () => {
  it('drops system tags and tolerates undefined', () => {
    expect(visibleTags(['ocr', 'job:1', 'job'])).toEqual(['ocr'])
    expect(visibleTags(undefined)).toEqual([])
  })
})

describe('tagColorClass', () => {
  it('is deterministic and palette-bound', () => {
    expect(tagColorClass('ocr')).toBe(tagColorClass('ocr'))
    const palette = new Set(['bg-accent/15 text-accent border-accent/25',
      'bg-ok/15 text-ok border-ok/25', 'bg-warn/15 text-warn border-warn/25',
      'bg-danger/15 text-danger border-danger/25', 'bg-bg-hover text-text border-border-strong'])
    for (const t of ['ocr', 'router', 'forgery', 'infra', 'wip', 'a', 'bb']) expect(palette.has(tagColorClass(t))).toBe(true)
  })
  it('spreads at least 3 distinct colors over 8 tags', () => {
    const set = new Set(['ocr', 'router', 'forgery', 'infra', 'wip', 'quality', 'cold-start', 'p0'].map(tagColorClass))
    expect(set.size).toBeGreaterThanOrEqual(3)
  })
})

describe('projectName', () => {
  it('takes the last path segment and tolerates trailing slash', () => {
    expect(projectName('/home/u/repos/pi-dashboard')).toBe('pi-dashboard')
    expect(projectName('/home/u/repos/pi-dashboard/')).toBe('pi-dashboard')
    expect(projectName(null)).toBe('')
  })
})

describe('relTime', () => {
  const now = Date.now()
  it('formats buckets', () => {
    expect(relTime(at(0), now)).toBe('0s')
    expect(relTime(at(45_000), now)).toBe('45s')
    expect(relTime(at(12 * 60_000), now)).toBe('12m')
    expect(relTime(at(3 * 3600_000), now)).toBe('3h')
    expect(relTime(at(5 * 86400_000), now)).toBe('5d')
  })
  it('falls back to a date beyond a week and tolerates junk', () => {
    expect(relTime(at(40 * 86400_000), now)).toMatch(/^\d{2}-\d{2}$|^\d{2}-\d{2}-\d{2}$/)
    expect(relTime(undefined, now)).toBe('')
    expect(relTime('not-a-date', now)).toBe('')
  })
})

describe('slotOrder', () => {
  const base = { key: 'k', title: 't', running: false }
  it('pins first regardless of recency', () => {
    const pinned = { ...base, key: 'old-pinned', pinned: true, updated: at(9 * 86400_000) }
    const fresh = { ...base, key: 'new', updated: at(1000) }
    expect([pinned, fresh].sort(slotOrder).map(s => s.key)).toEqual(['old-pinned', 'new'])
  })
  it('sorts newest first and puts missing timestamps last', () => {
    const a = { ...base, key: 'a', updated: at(1000) }
    const b = { ...base, key: 'b', updated: at(60_000) }
    const c = { ...base, key: 'c' }
    expect([b, c, a].sort(slotOrder).map(s => s.key)).toEqual(['a', 'b', 'c'])
  })
})

describe('tagCounts', () => {
  it('counts human tags, most used first', () => {
    const slots = [
      { key: '1', title: '', running: false, tags: ['ocr', 'router', 'job:9'] },
      { key: '2', title: '', running: false, tags: ['ocr'] },
      { key: '3', title: '', running: false },
    ]
    expect(tagCounts(slots)).toEqual([{ tag: 'ocr', count: 2 }, { tag: 'router', count: 1 }])
  })
})
