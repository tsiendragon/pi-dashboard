/**
 * How the graph reacts when the pi process it follows swaps to another session file.
 *
 * `/ls-fork` (from the graph's 从此分叉) does NOT start a new pi process: it gives the
 * same process a new session file. A plain session swap should keep the graph, but a
 * fork should land the reader in the new branch's agent page, at the entry they forked.
 */
import { describe, expect, it } from 'vitest'
import { followSessionFile } from '../features/live-sessions/graph/SessionGraphPage'

describe('followSessionFile', () => {
  it('jumps to the new branch session page after a fork', () => {
    const plan = followSessionFile('pid-1', '/tmp/new.jsonl', 'entry-9')
    expect(plan).toEqual({ kind: 'navigate', to: '/live-sessions/pid-1?node=entry-9' })
  })

  it('escapes ids that need it', () => {
    const plan = followSessionFile('pid 1', '/tmp/new.jsonl', 'a/b?c')
    expect(plan.kind).toBe('navigate')
    expect(plan.kind === 'navigate' ? plan.to : '').toBe('/live-sessions/pid%201?node=a%2Fb%3Fc')
  })

  it('keeps the graph and just follows the new file for a plain swap', () => {
    expect(followSessionFile('pid-1', '/tmp/new.jsonl', null)).toEqual({ kind: 'follow', file: '/tmp/new.jsonl' })
  })
})