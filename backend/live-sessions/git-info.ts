export interface LiveSessionGitInfo {
  root?: string
  branch?: string
}

type CacheEntry = { value: LiveSessionGitInfo; expiresAt: number }

export class LiveSessionGitInfoResolver {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly ttlMs = 30_000) {}

  private async exec(args: string[]): Promise<string> {
    const { execFile } = await import('node:child_process')
    return new Promise((resolve, reject) => {
      execFile('git', args, { encoding: 'utf8', timeout: 1_500, maxBuffer: 64 * 1024 }, (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      })
    })
  }

  async resolve(cwd: string): Promise<LiveSessionGitInfo | undefined> {
    const cached = this.cache.get(cwd)
    if (cached && cached.expiresAt > Date.now()) return { ...cached.value }
    try {
      const root = (await this.exec(['-C', cwd, 'rev-parse', '--show-toplevel'])).trim()
      if (!root) return undefined
      let branch: string | undefined
      try {
        branch = (await this.exec(['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() || undefined
      } catch {
        const detached = await this.exec(['-C', cwd, 'rev-parse', '--short', 'HEAD']).catch(() => undefined)
        branch = detached?.trim() || undefined
      }
      const value = { root, ...(branch ? { branch } : {}) }
      this.cache.set(cwd, { value, expiresAt: Date.now() + this.ttlMs })
      return { ...value }
    } catch {
      this.cache.set(cwd, { value: {}, expiresAt: Date.now() + this.ttlMs })
      return undefined
    }
  }

  clear(): void { this.cache.clear() }
}
