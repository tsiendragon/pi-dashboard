import { describe, expect, it } from 'vitest'
import { applyOrder, applyToggle, describeDiff } from '../ext-writes.js'

const entries = [
  '/repo/packages/pi-tsien-rtk-fork/src/index.ts',
  '/repo/packages/pi-tsien-goal/src/index.ts',
  '-/repo/packages/pi-tsien-sidebar/src/index.ts',
]

describe('applyToggle', () => {
  it('disables with a force-exclude prefix and keeps the position', () => {
    const next = applyToggle(entries, '/repo/packages/pi-tsien-goal/src/index.ts', 'disable')
    expect(next[1]).toBe('-/repo/packages/pi-tsien-goal/src/index.ts')
    expect(next.length).toBe(3)
    expect(next[0]).toBe(entries[0])
  })

  it('round-trips disable → enable back to a plain entry', () => {
    const disabled = applyToggle(entries, '/repo/packages/pi-tsien-goal/src/index.ts', 'disable')
    const enabled = applyToggle(disabled, '/repo/packages/pi-tsien-goal/src/index.ts', 'enable')
    expect(enabled).toEqual(entries)
  })

  it('enables an excluded (!) or force-included (+) entry as a force-include', () => {
    expect(applyToggle(['!/a/x.ts'], '/a/x.ts', 'enable')).toEqual(['+/a/x.ts'])
    expect(applyToggle(['+/a/x.ts'], '/a/x.ts', 'enable')).toEqual(['+/a/x.ts'])
  })

  it('is idempotent and reports unknown paths', () => {
    const once = applyToggle(entries, '/repo/packages/pi-tsien-sidebar/src/index.ts', 'disable')
    expect(applyToggle(once, '/repo/packages/pi-tsien-sidebar/src/index.ts', 'disable')).toEqual(once)
    expect(() => applyToggle(entries, '/nope.ts', 'disable')).toThrow(/not found/)
  })
})

describe('applyOrder', () => {
  it('reorders only unprefixed entries and leaves overrides at their index', () => {
    const next = applyOrder(entries, ['/repo/packages/pi-tsien-goal/src/index.ts', '/repo/packages/pi-tsien-rtk-fork/src/index.ts'])
    expect(next).toEqual([
      '/repo/packages/pi-tsien-goal/src/index.ts',
      '/repo/packages/pi-tsien-rtk-fork/src/index.ts',
      '-/repo/packages/pi-tsien-sidebar/src/index.ts',
    ])
  })

  it('rejects an order that is not a permutation of the managed entries', () => {
    expect(() => applyOrder(entries, ['/repo/packages/pi-tsien-goal/src/index.ts'])).toThrow(/exactly the 2/)
    expect(() => applyOrder(entries, ['/nope.ts', '/repo/packages/pi-tsien-rtk-fork/src/index.ts'])).toThrow(/exactly the 2/)
  })
})

describe('describeDiff', () => {
  it('shows prefix changes and order changes', () => {
    expect(describeDiff({ before: entries, after: applyToggle(entries, entries[1]!, 'disable') })).toEqual([
      `~ ${entries[1]}  →  -${entries[1]}`,
    ])
    expect(describeDiff({ before: ['/a.ts', '/b.ts'], after: ['/b.ts', '/a.ts'] })).toEqual(['~ order changed'])
  })
})
