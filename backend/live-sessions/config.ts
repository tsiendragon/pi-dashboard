import path from 'path'

export type LiveSessionClaimMode = 'manual' | 'on-first-input'

/**
 * How a dashboard-started live Pi is launched inside its tmux pane.
 *
 * `command` exists so the pane can go through the user's own wrapper (for
 * example a `pi-clean` script that unsets provider credentials, disables
 * context files and appends a system prompt). The dashboard must not copy that
 * logic: the wrapper is the single source of truth, and the dashboard only
 * appends its own `--name/--model/--thinking` after `args`.
 */
export interface LivePiLaunchConfig {
  /** Pane command. Defaults to the `pi` launcher on PATH. */
  command?: string
  /** Arguments placed before the dashboard's own arguments. */
  args: string[]
  /** Variables really removed from the pane env (`env -u`), not merely blanked. */
  unsetEnv: string[]
}

export interface LiveSessionConfig {
  enabled: boolean
  roots: string[]
  includeOutsideRoots: boolean
  claimMode: LiveSessionClaimMode
  leaseMs: number
  disconnectGraceMs: number
  snapshotEntryLimit: number
  launch: LivePiLaunchConfig
}

export const DEFAULT_LIVE_SESSION_CONFIG: LiveSessionConfig = {
  enabled: true,
  /** No hard-coded roots: configure `liveSessions.roots` to the directories worth scanning. */
  roots: [],
  includeOutsideRoots: false,
  claimMode: 'on-first-input',
  leaseMs: 30_000,
  disconnectGraceMs: 15_000,
  snapshotEntryLimit: 200,
  launch: { args: [], unsetEnv: [] },
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : fallback
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function parseLaunch(value: unknown): LivePiLaunchConfig {
  const input = record(value)
  if (!input) return { args: [], unsetEnv: [] }
  const command = typeof input.command === 'string' && input.command.trim() ? input.command.trim() : undefined
  const args = Array.isArray(input.args) ? input.args.filter((arg): arg is string => typeof arg === 'string') : []
  const unsetEnv = Array.isArray(input.unsetEnv)
    ? [...new Set(input.unsetEnv.filter((name): name is string => typeof name === 'string' && ENV_NAME_RE.test(name)))]
    : []
  return { ...(command ? { command } : {}), args, unsetEnv }
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
    launch: parseLaunch(input.launch),
  }
}
