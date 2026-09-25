/**
 * Env file support for the dashboard process.
 *
 * Every pi slot is spawned with `...process.env` (see pi-manager's spawnOpts), so anything loaded
 * here automatically reaches each pi child — extensions included. That is how a machine supplies
 * provider keys and portable data roots (`PI_TRACE_DIR`, `PI_OBSERVATION_DIR`, `PI_SCRIPT`, …)
 * without editing launchd/systemd units.
 *
 * Files are read in this order and, like dotenv, never override a variable that is already set:
 *   1. `PI_DASH_ENV_FILE` — explicit path; a missing file is reported, because it was asked for.
 *   2. `<repo>/.env` — the local checkout file.
 *   3. `<PI_CODING_AGENT_DIR | ~/.pi/agent>/dashboard.env` — machine-wide dashboard config.
 */
import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import os from 'os'

export interface LoadedEnvFile {
  path: string
  /** Variable names applied from this file (values are never logged). */
  applied: string[]
}

export interface LoadDashboardEnvResult {
  files: LoadedEnvFile[]
  /** Variable names that were already set in the environment and therefore kept as-is. */
  skipped: string[]
  /** Present when `PI_DASH_ENV_FILE` was set but could not be read. */
  error?: string
}

/** Parse `KEY=VALUE` lines. Blank lines and `#` comments are ignored, `export ` is allowed. */
export function parseEnvFile(text: string): Record<string, string> {
  const parsed: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const eq = body.indexOf('=')
    if (eq <= 0) continue
    const key = body.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = body.slice(eq + 1).trim()
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
    if (quoted && value.length >= 2) value = value.slice(1, -1)
    parsed[key] = value
  }
  return parsed
}

export function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim()
  return configured ? configured : join(os.homedir(), '.pi', 'agent')
}

/** Candidate env files in load order; only explicitly requested and existing files are returned. */
export function dashboardEnvFilePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env.PI_DASH_ENV_FILE?.trim()
  const paths: string[] = []
  if (explicit) paths.push(explicit)
  const checkout = join(repoRoot(), '.env')
  if (existsSync(checkout)) paths.push(checkout)
  const machine = join(agentDir(env), 'dashboard.env')
  if (existsSync(machine)) paths.push(machine)
  return paths
}

/** Apply one env file into `env`, keeping already-set variables. Returns the applied names. */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const parsed = parseEnvFile(readFileSync(path, 'utf-8'))
  const applied: string[] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] !== undefined && env[key] !== '') continue
    env[key] = value
    applied.push(key)
  }
  return applied
}

export function loadDashboardEnv(env: NodeJS.ProcessEnv = process.env): LoadDashboardEnvResult {
  const result: LoadDashboardEnvResult = { files: [], skipped: [] }
  for (const path of dashboardEnvFilePaths(env)) {
    if (!existsSync(path)) {
      result.error = `PI_DASH_ENV_FILE=${path} does not exist`
      continue
    }
    let applied: string[]
    try {
      applied = loadEnvFile(path, env)
    } catch (err) {
      result.error = `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`
      continue
    }
    result.files.push({ path, applied })
  }
  const seen = new Set(result.files.flatMap((f) => f.applied))
  const requested = new Set(dashboardEnvFilePaths(env).flatMap((p) => Object.keys(parseSafe(p))))
  result.skipped = [...requested].filter((key) => !seen.has(key))
  return result
}

function parseSafe(path: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}