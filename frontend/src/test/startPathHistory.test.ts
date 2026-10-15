import { describe, it, expect } from 'vitest'
import { isPathLikeQuery, matchStartPaths, mergeStartPathHistory } from '../features/live-sessions/startPathHistory'

const REPOS = [
  '~/repos/toolkit',
  '~/repos/pi-dashboard',
  '~/repos/task-journal/tasks/card-router/TASK-0000/card-router-v1',
]

describe('mergeStartPathHistory', () => {
  it('keeps recent paths first and appends unseen session cwds', () => {
    expect(mergeStartPathHistory(['/a'], ['/b', '/a', undefined, '  '])).toEqual(['/a', '/b'])
  })

  it('trims entries and drops blanks', () => {
    expect(mergeStartPathHistory(['  /a  ', ''], [])).toEqual(['/a'])
  })
})

describe('isPathLikeQuery', () => {
  it('separates a keyword from a path being typed', () => {
    expect(isPathLikeQuery('toolkit')).toBe(false)
    expect(isPathLikeQuery('/home/user/projects')).toBe(true)
    expect(isPathLikeQuery('~/repos')).toBe(true)
    expect(isPathLikeQuery('./local')).toBe(true)
  })
})

describe('matchStartPaths', () => {
  it('keeps the incoming order when nothing was typed', () => {
    expect(matchStartPaths(REPOS, '   ')).toEqual(REPOS)
  })

  it('ranks a last-segment hit above a match in a parent directory', () => {
    expect(matchStartPaths(REPOS, 'toolkit')[0]).toBe(REPOS[0])
    // "repos" only appears in a parent segment, so nothing beats a name hit.
    expect(matchStartPaths(['~/repos/app', '~/app-repos'], 'repos')[0]).toBe('~/app-repos')
  })

  it('ignores case, matches path fragments and returns nothing for a miss', () => {
    expect(matchStartPaths(REPOS, 'PI-DASH')).toEqual(['~/repos/pi-dashboard'])
    expect(matchStartPaths(REPOS, 'card-router-v1')).toEqual([REPOS[2]])
    expect(matchStartPaths(REPOS, 'zzz')).toEqual([])
  })

  it('prefers the shorter path when scores tie, and honours the limit', () => {
    const ties = ['/mnt/x/app-tool', '/mnt/x/tool']
    expect(matchStartPaths(ties, 'tool')[0]).toBe('/mnt/x/tool')
    expect(matchStartPaths(REPOS, 'repos', 1)).toHaveLength(1)
  })
})