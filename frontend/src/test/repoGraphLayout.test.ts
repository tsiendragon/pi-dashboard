import { describe, expect, it } from 'vitest'
import { layoutGraph } from '../features/repos/graphLayout'

const c = (hash: string, ...parents: string[]) => ({ hash, parents })

describe('layoutGraph', () => {
  it('keeps a linear history in one lane', () => {
    const { rows, laneCount } = layoutGraph([c('c', 'b'), c('b', 'a'), c('a')])
    expect(laneCount).toBe(1)
    expect(rows.map(r => r.node)).toEqual([0, 0, 0])
    expect(rows[0]!.segments).toEqual([{ kind: 'out', lane: 0, color: 0 }])
    expect(rows[2]!.segments).toEqual([{ kind: 'in', lane: 0, color: 0 }])
  })

  it('forks a merge into a second lane and joins it at the fork point', () => {
    // m merges f into main; both come from a.
    const { rows, laneCount } = layoutGraph([c('m', 'b', 'f'), c('f', 'a'), c('b', 'a'), c('a')])
    expect(laneCount).toBe(2)
    expect(rows.map(r => r.node)).toEqual([0, 1, 0, 1])
    // row f: lane 0 passes through, f itself continues on lane 1
    expect(rows[1]!.segments).toContainEqual({ kind: 'pass', lane: 0, color: 0 })
    // row b joins f's lane (a is already expected there) instead of opening a duplicate
    expect(rows[2]!.segments).toContainEqual({ kind: 'out', lane: 1, color: 1 })
  })

  it('starts a new lane for an unrelated tip and reuses freed lanes', () => {
    const { rows } = layoutGraph([c('x', 'a'), c('y', 'a'), c('a')])
    expect(rows.map(r => r.node)).toEqual([0, 1, 0])
  })
})
