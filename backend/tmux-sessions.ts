/**
 * Thin tmux session helpers for the web shared terminal and for tmux-first live
 * sessions.
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

/**
 * Command used to start an interactive Pi inside a tmux pane.
 *
 * Deliberately prefers the `pi` launcher on PATH over `PI_SCRIPT`: that variable
 * is the dashboard's own entry point (a `.js` file, spawned through `node`), not
 * something a pane shell can execute directly.
 */
export function resolvePiCommand(): string {
  try {
    const found = execSync('which pi', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (found) return found
  } catch { /* fall through */ }
  return resolvePiBin()
}

export function hasTmuxSession(fullName: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', fullName], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export interface CreateTmuxSessionOptions {
  /** Defaults to the `pi` launcher on PATH. */
  command?: string
  /** Passed as separate argv entries — tmux does not run them through a shell. */
  args?: readonly string[]
  cwd?: string
  /** Explicit `-e KEY=VALUE` overrides, so callers never depend on the tmux
   *  server's inherited environment (the dashboard exports PI_RUNTIME=dashboard,
   *  which would make a pane's Pi silently skip live-session registration). */
  env?: Record<string, string>
}

/** Create (if absent) a detached tmux session and return its full name. */
export function createTmuxSession(name: string, options: CreateTmuxSessionOptions = {}): string {
  const fullName = sanitizeTmuxSession(name)
  if (hasTmuxSession(fullName)) return fullName
  const argv = ['new-session', '-d', '-s', fullName]
  if (options.cwd) argv.push('-c', options.cwd)
  for (const [key, value] of Object.entries(options.env || {})) argv.push('-e', `${key}=${value}`)
  // Command and args go in as separate argv entries: tmux was verified to hand
  // them to the pane verbatim, so titles with spaces need no quoting and never
  // become a shell command.
  argv.push(options.command ?? resolvePiBin(), ...(options.args ? [...options.args] : []))
  execFileSync('tmux', argv, { stdio: ['ignore', 'ignore', 'pipe'] })
  return fullName
}

/**
 * PID of a session's first pane, or undefined when it cannot be read.
 * Used to confirm that a fresh live session is the Pi we just started (the `pi`
 * launcher `exec`s its real process, so the pane pid is the Pi pid).
 */
export function tmuxPanePid(fullName: string): number | undefined {
  try {
    const out = execFileSync('tmux', ['list-panes', '-t', fullName, '-F', '#{pane_pid}'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const pid = parseInt(out.split('\n')[0]?.trim() || '', 10)
    return Number.isFinite(pid) ? pid : undefined
  } catch {
    return undefined
  }
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