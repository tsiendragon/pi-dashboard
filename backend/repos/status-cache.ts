/**
 * Stale-while-revalidate cache for repo git status.
 *
 * `git status` can take tens of seconds on a cold network mount, so the list never waits for it:
 * it shows what is cached (persisted across restarts) and refreshes in the background when the
 * entry is older than `ttlMs`, or when the user asks for a refresh. A refresh that times out never
 * replaces a good earlier value.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import path from 'path'
import type { RepoGitStatus } from '../../shared/src/repos.js'

export interface CachedStatus { at: number; value: RepoGitStatus }

export class StatusCache {
  private readonly entries = new Map<string, CachedStatus>()
  private readonly inflight = new Map<string, Promise<RepoGitStatus>>()

  constructor(
    private readonly compute: (dir: string) => Promise<RepoGitStatus>,
    private readonly ttlMs: number,
    private readonly file?: string,
  ) {
    if (!file) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, CachedStatus>
      for (const [dir, entry] of Object.entries(raw)) {
        if (entry && typeof entry.at === 'number' && entry.value && !entry.value.slow) this.entries.set(dir, entry)
      }
    } catch { /* first run or unreadable cache: start empty */ }
  }

  peek(dir: string): CachedStatus | undefined {
    return this.entries.get(dir)
  }

  isRefreshing(dir: string): boolean {
    return this.inflight.has(dir)
  }

  /** Cached value now; kicks off a background refresh when stale, missing, or `force`d. */
  peekAndRefresh(dir: string, force = false): CachedStatus | undefined {
    const hit = this.entries.get(dir)
    if (force || !hit || Date.now() - hit.at >= this.ttlMs) void this.refresh(dir).catch(() => undefined)
    return hit
  }

  /** Fresh-enough value, waiting for the computation if there is nothing usable cached. */
  async get(dir: string): Promise<RepoGitStatus> {
    const hit = this.entries.get(dir)
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value
    return this.refresh(dir)
  }

  refresh(dir: string): Promise<RepoGitStatus> {
    let pending = this.inflight.get(dir)
    if (!pending) {
      pending = this.compute(dir).then(value => {
        const previous = this.entries.get(dir)
        if (value.slow && previous) return previous.value
        this.entries.set(dir, { at: Date.now(), value })
        this.persist()
        return value
      }).finally(() => { this.inflight.delete(dir) })
      this.inflight.set(dir, pending)
    }
    return pending
  }

  forget(dir: string): void {
    if (this.entries.delete(dir)) this.persist()
  }

  private persist(): void {
    if (!this.file) return
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries)))
      renameSync(tmp, this.file)
    } catch (error) {
      console.error('[repos] could not persist status cache:', error)
    }
  }
}
