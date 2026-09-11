/**
 * Thin tmux session helpers for the web shared terminal.
 *
 * All session names are confined to the `pi-dash-` namespace and are passed to
 * tmux as argv (never via a shell string), so a malicious name cannot inject an
 * extra command. The tmux session (and the Pi TUI running inside it) is the
 * single source of truth — the dashboard only creates/attaches/kills its own
 * namespaced sessions.
 */
import { execFileSync, execSync } from 'child_process'

export const PTY_SESSION_PREFIX = 'pi-dash-'

const SESSION_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Normalize a user-supplied name to a `pi-dash-*` session name, or throw. */
export function sanitizeTmuxSession(input: string): string {
  let name = (input || '').trim()
  if (name.startsWith(PTY_SESSION_PREFIX)) name = name.slice(PTY_SESSION_PREFIX.length)
  if (!SESSION_NAME_RE.test(name)) throw new Error('invalid tmux session name')
  return PTY_SESSION_PREFIX + name
}

/** Resolve the `pi` binary path used when creating a new terminal session. */
export function resolvePiBin(): string {
  const fromEnv = process.env.PI_SCRIPT?.trim()
  if (fromEnv) return fromEnv
  try {
    return execSync('which pi', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'pi'
  }
}

export function hasTmuxSession(fullName: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', fullName], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Create (if absent) a detached tmux session running `pi`, and return its full name. */
export function createTmuxSession(name: string, command?: string): string {
  const fullName = sanitizeTmuxSession(name)
  if (hasTmuxSession(fullName)) return fullName
  const cmd = command ?? resolvePiBin()
  execFileSync('tmux', ['new-session', '-d', '-s', fullName, cmd], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  return fullName
}

/** List full names of tmux sessions in the `pi-dash-` namespace. */
export function listTmuxSessions(): string[] {
  try {
    const out = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.startsWith(PTY_SESSION_PREFIX))
  } catch {
    return []
  }
}

/** Kill a namespaced tmux session (idempotent). */
export function killTmuxSession(name: string): void {
  const fullName = sanitizeTmuxSession(name)
  if (!hasTmuxSession(fullName)) return
  execFileSync('tmux', ['kill-session', '-t', fullName], { stdio: 'ignore' })
}