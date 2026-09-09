import { realpath, stat } from 'fs/promises'
import path from 'path'

export interface LiveSessionPathDecision {
  allowed: boolean
  canonicalCwd?: string
  canonicalRoot?: string
  code?: 'invalid_configuration' | 'cwd_unavailable' | 'out_of_scope'
  message?: string
}

export function isPathWithinRoot(canonicalRoot: string, canonicalPath: string): boolean {
  const relative = path.relative(canonicalRoot, canonicalPath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export class LiveSessionPathPolicy {
  private canonicalRoots: string[] = []
  private initialization?: Promise<void>
  private configurationError?: Error

  constructor(private readonly roots: readonly string[]) {}

  start(): Promise<void> {
    if (!this.initialization) this.initialization = this.initialize()
    return this.initialization
  }

  async stop(): Promise<void> {
    this.initialization = undefined
    this.canonicalRoots = []
    this.configurationError = undefined
  }

  cleanup(): Promise<void> {
    return this.stop()
  }

  getCanonicalRoots(): readonly string[] {
    return [...this.canonicalRoots]
  }

  async authorize(cwd: string): Promise<LiveSessionPathDecision> {
    try { await this.start() } catch {}
    if (this.configurationError || this.canonicalRoots.length === 0) {
      return {
        allowed: false,
        code: 'invalid_configuration',
        message: this.configurationError?.message || 'no canonical live session roots are configured',
      }
    }
    if (!path.isAbsolute(cwd)) return { allowed: false, code: 'out_of_scope', message: 'cwd must be absolute' }
    let canonicalCwd: string
    try {
      canonicalCwd = await realpath(cwd)
      const cwdStat = await stat(canonicalCwd)
      if (!cwdStat.isDirectory()) return { allowed: false, code: 'cwd_unavailable', message: 'cwd is not a directory' }
    } catch {
      return { allowed: false, code: 'cwd_unavailable', message: 'cwd cannot be resolved' }
    }
    for (const canonicalRoot of this.canonicalRoots) {
      if (isPathWithinRoot(canonicalRoot, canonicalCwd)) return { allowed: true, canonicalCwd, canonicalRoot }
    }
    return { allowed: false, canonicalCwd, code: 'out_of_scope', message: 'cwd is outside configured roots' }
  }

  private async initialize(): Promise<void> {
    try {
      if (this.roots.length === 0) throw new Error('live session roots must not be empty')
      const canonical = await Promise.all(this.roots.map(async root => {
        if (!path.isAbsolute(root)) throw new Error(`live session root must be absolute: ${root}`)
        const resolved = await realpath(root)
        if (!(await stat(resolved)).isDirectory()) throw new Error(`live session root is not a directory: ${root}`)
        return resolved
      }))
      this.canonicalRoots = [...new Set(canonical)]
      this.configurationError = undefined
    } catch (error) {
      this.canonicalRoots = []
      this.configurationError = error instanceof Error ? error : new Error(String(error))
      throw this.configurationError
    }
  }
}
