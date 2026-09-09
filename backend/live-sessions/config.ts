import path from 'path'

export type LiveSessionClaimMode = 'manual' | 'on-first-input'

export interface LiveSessionConfig {
  enabled: boolean
  roots: string[]
  includeOutsideRoots: boolean
  claimMode: LiveSessionClaimMode
  leaseMs: number
  disconnectGraceMs: number
  snapshotEntryLimit: number
}

export const DEFAULT_LIVE_SESSION_CONFIG: LiveSessionConfig = {
  enabled: true,
  roots: ['/mnt/workspace/lilong/repos/worktree'],
  includeOutsideRoots: false,
  claimMode: 'on-first-input',
  leaseMs: 30_000,
  disconnectGraceMs: 15_000,
  snapshotEntryLimit: 200,
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : fallback
}

export function parseLiveSessionConfig(value: unknown): LiveSessionConfig {
  if (value === undefined) return { ...DEFAULT_LIVE_SESSION_CONFIG, roots: [...DEFAULT_LIVE_SESSION_CONFIG.roots] }
  const input = record(value)
  if (!input) return { ...DEFAULT_LIVE_SESSION_CONFIG, enabled: false, roots: [] }
  const enabled = input.enabled === undefined ? true : input.enabled === true
  const rootsValue = input.roots === undefined ? DEFAULT_LIVE_SESSION_CONFIG.roots : input.roots
  const roots = Array.isArray(rootsValue)
    ? [...new Set(rootsValue.filter((root): root is string => typeof root === 'string' && path.isAbsolute(root)))]
    : []
  const includeOutsideRoots = input.includeOutsideRoots === true
  // includeOutsideRoots is reserved for a future explicit all-local mode. It
  // never broadens access until the path policy has a separately reviewed rule.
  const claimMode: LiveSessionClaimMode = input.claimMode === 'manual' ? 'manual' : 'on-first-input'
  return {
    enabled: enabled && roots.length > 0,
    roots,
    includeOutsideRoots,
    claimMode,
    leaseMs: boundedInteger(input.leaseMs, DEFAULT_LIVE_SESSION_CONFIG.leaseMs, 10_000, 120_000),
    disconnectGraceMs: boundedInteger(input.disconnectGraceMs, DEFAULT_LIVE_SESSION_CONFIG.disconnectGraceMs, 5_000, 60_000),
    snapshotEntryLimit: boundedInteger(input.snapshotEntryLimit, DEFAULT_LIVE_SESSION_CONFIG.snapshotEntryLimit, 20, 500),
  }
}
