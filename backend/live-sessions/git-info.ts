export interface LiveSessionGitInfo {
  root?: string
  branch?: string
  /** `origin` (or the first configured remote) with credentials removed. */
  remoteUrl?: string
}

type CacheEntry = { value: LiveSessionGitInfo; expiresAt: number }

const REMOTE_TOKENS = [
  /(?:github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]+/g,
  /\bglpat-[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:xox[baprs]-)[A-Za-z0-9-]+/g,
]

/**
 * Remotes can carry credentials in userinfo or a query token. Session rows are visible
 * to every authenticated dashboard client, so never hand the raw `git remote` value to
 * the browser or phone. SSH/scp forms are kept because their username is not a secret.
 */
export function safeRemoteUrl(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 4_096 || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined
  let value = trimmed
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      url.username = ''
      url.password = ''
      for (const key of [...url.searchParams.keys()]) {
        if (/token|key|secret|password|passwd|auth/i.test(key)) url.searchParams.delete(key)
      }
      url.hash = ''
      value = url.toString()
    } catch {
      return undefined
    }
  } else if (/^ssh:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      url.password = ''
      url.hash = ''
      value = url.toString()
    } catch {
      return undefined
    }
  }
  for (const token of REMOTE_TOKENS) value = value.replace(token, '***')
  return value
}

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

  private async branch(root: string): Promise<string | undefined> {
    try {
      return (await this.exec(['-C', root, 'symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() || undefined
    } catch {
      const detached = await this.exec(['-C', root, 'rev-parse', '--short', 'HEAD']).catch(() => undefined)
      return detached?.trim() || undefined
    }
  }

  /** One `config` call covers `origin` and any fallback remote; output stays in memory. */
  private async remote(root: string): Promise<string | undefined> {
    const output = await this.exec(['-C', root, 'config', '--get-regexp', '^remote\\..*\\.url$']).catch(() => '')
    const remotes = output.split('\n').map(line => {
      const match = /^remote\.([^.]+)\.url\s+(.+)$/.exec(line)
      return match ? { name: match[1], url: match[2] } : undefined
    }).filter((entry): entry is { name: string; url: string } => !!entry)
    const chosen = remotes.find(entry => entry.name === 'origin') ?? remotes[0]
    return chosen ? safeRemoteUrl(chosen.url) : undefined
  }

  async resolve(cwd: string): Promise<LiveSessionGitInfo | undefined> {
    const cached = this.cache.get(cwd)
    if (cached && cached.expiresAt > Date.now()) return { ...cached.value }
    try {
      const root = (await this.exec(['-C', cwd, 'rev-parse', '--show-toplevel'])).trim()
      if (!root) return undefined
      const [branch, remoteUrl] = await Promise.all([this.branch(root), this.remote(root)])
      const value = { root, ...(branch ? { branch } : {}), ...(remoteUrl ? { remoteUrl } : {}) }
      this.cache.set(cwd, { value, expiresAt: Date.now() + this.ttlMs })
      return { ...value }
    } catch {
      this.cache.set(cwd, { value: {}, expiresAt: Date.now() + this.ttlMs })
      return undefined
    }
  }

  clear(): void { this.cache.clear() }
}
