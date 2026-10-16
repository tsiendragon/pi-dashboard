import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'
import { StatusCache } from '../repos/status-cache.js'
import type { RepoGitStatus } from '../../shared/src/repos.js'

const status = (branch: string, slow = false): RepoGitStatus => ({
  isGit: true, branch, detached: false, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0,
  conflicted: 0, stash: 0, worktrees: 1, localBranches: 1, slow, webUrl: null, last: null,
})

const dirs: string[] = []
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('StatusCache', () => {
  it('serves the cached value without recomputing until the ttl passes', async () => {
    vi.useFakeTimers()
    const compute = vi.fn(async () => status('main'))
    const cache = new StatusCache(compute, 1000)
    await cache.get('/r')
    await cache.get('/r')
    expect(compute).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1001)
    // stale: the old value is returned immediately and a refresh starts in the background
    expect(cache.peekAndRefresh('/r')?.value.branch).toBe('main')
    expect(cache.isRefreshing('/r')).toBe(true)
    await cache.refresh('/r')
    expect(compute).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight computation and recomputes on force', async () => {
    const compute = vi.fn(async () => status('main'))
    const cache = new StatusCache(compute, 60_000)
    await Promise.all([cache.get('/r'), cache.get('/r'), cache.refresh('/r')])
    expect(compute).toHaveBeenCalledTimes(1)
    cache.peekAndRefresh('/r', true)
    await cache.refresh('/r')
    expect(compute).toHaveBeenCalledTimes(2)
  })

  it('keeps a good value when a later refresh times out, but records a first-time timeout', async () => {
    const results = [status('main'), status('?', true)]
    const cache = new StatusCache(async () => results.shift()!, 0)
    await cache.refresh('/r')
    expect((await cache.refresh('/r')).slow).toBe(false)
    expect(cache.peek('/r')?.value.branch).toBe('main')

    const first = new StatusCache(async () => status('?', true), 60_000)
    await first.refresh('/x')
    expect(first.peek('/x')?.value.slow).toBe(true)
  })

  it('survives a restart through the cache file and ignores timed-out entries', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'status-cache-'))
    dirs.push(dir)
    const file = path.join(dir, 'cache.json')
    const first = new StatusCache(async () => status('dev'), 60_000, file)
    await first.refresh('/r')
    const slow = new StatusCache(async () => status('?', true), 60_000, file)
    await slow.refresh('/slow')

    const reborn = new StatusCache(async () => status('other'), 60_000, file)
    expect(reborn.peek('/r')?.value.branch).toBe('dev')
    expect(reborn.peek('/slow')).toBeUndefined()
    reborn.forget('/r')
    expect(new StatusCache(async () => status('x'), 1, file).peek('/r')).toBeUndefined()
  })
})
