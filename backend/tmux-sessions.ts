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
  /** Extra names to carry over from this process's environment (see
   *  `panePassthroughEnv`). Pass `[]` to skip. */
  passthroughEnv?: readonly string[]
}

/**
 * Environment variables a dashboard-created pane must NOT inherit from the
 * dashboard process: they either describe the dashboard itself (slot wiring,
 * runtime flag) or would freeze client-side session details.
 */
const PASSTHROUGH_EXCLUSIONS = new Set([
  '_', 'PWD', 'OLDPWD', 'SHLVL', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TERM',
  'HOSTNAME', 'MAIL', 'LANG', 'LS_COLORS', 'EDITOR', 'INIT_CWD', 'LESSOPEN', 'LESSCLOSE', 'COLOR',
  'NODE', 'NODE_OPTIONS', 'NODE_ENV',
  'PI_RUNTIME', 'PI_SLOT_KEY', 'PI_SCRIPT', 'PI_DASH_PORT',
  // Per-session pi state: a brand-new pane must not resume somebody's session.
  'PI_SESSION_FILE', 'PI_SESSION_ID',
  'PI_DASH_BRIDGE_SOCKET', 'PI_DASH_BRIDGE_TOKEN',
])

/** Toolchain noise that says nothing about how the Pi should behave. */
const PASSTHROUGH_PREFIX_EXCLUSIONS = /^(TMUX|BASH_|PI_DASH_|npm_|CONDA|_CE_|_CONDA)/

/**
 * Env var names to copy from the dashboard process into a new pane.
 *
 * Why: tmux gives a pane the **tmux server's** environment, not the client's.
 * The dashboard therefore used to hand panes a stale environment (from whenever
 * the tmux server was started), which silently changed which providers/models a
 * Pi could reach — dashboard-created sessions showed a different model list than
 * terminal-started ones. Copying the dashboard's own environment makes a pane
 * behave like the dashboard slots, which are spawned with `...process.env`.
 */
export function panePassthroughEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env)
    .filter(key => !PASSTHROUGH_EXCLUSIONS.has(key))
    .filter(key => !PASSTHROUGH_PREFIX_EXCLUSIONS.test(key))
    .sort()
}

/** Read the names currently listed in tmux's global `update-environment`. */
export function readUpdateEnvironment(run: TmuxRunner = defaultRunner): string[] {
  try {
    const out = run(['show-options', '-g', 'update-environment'])
    return out
      .split('\n')
      .map(line => line.trim())
      .map(line => line.replace(/^update-environment(\[\d+\])?\s+/, ''))
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Make tmux copy `names` from the client environment into new sessions.
 *
 * `update-environment` is how the values travel: they go over the tmux client
 * socket, never through a command line, so secrets do not appear in `ps`. The
 * option is global, so the list is unioned with whatever is already there
 * (tmux's own defaults such as `SSH_AUTH_SOCK` must survive) and written only
 * when it actually changes.
 */
export function ensureUpdateEnvironment(names: readonly string[], run: TmuxRunner = defaultRunner): void {
  if (!names.length) return
  try {
    // A readable option means a server is already running; a server we start
    // ourselves hands our own environment to its panes anyway. (A tmux server
    // with no sessions exits immediately, so there is nothing to configure.)
    const current = readUpdateEnvironment(run)
    if (!current.length) return
    const merged = [...current]
    for (const name of names) if (!merged.includes(name)) merged.push(name)
    if (merged.length === current.length) return
    run(['set-option', '-g', 'update-environment', merged.join(' ')])
  } catch (error) {
    // Best effort by design: failing to pass the environment through must never
    // block session creation.
    console.warn('[tmux] Could not extend update-environment (pane keeps the tmux server env):', (error as Error).message)
  }
}

type TmuxRunner = (argv: string[]) => string

function defaultRunner(argv: string[]): string {
  return execFileSync('tmux', argv, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
}

/** Create (if absent) a detached tmux session and return its full name. */
export function createTmuxSession(name: string, options: CreateTmuxSessionOptions = {}): string {
  const fullName = sanitizeTmuxSession(name)
  if (hasTmuxSession(fullName)) return fullName
  ensureUpdateEnvironment(options.passthroughEnv ?? panePassthroughEnv())
  const argv = ['new-session', '-d', '-s', fullName]
  if (options.cwd) argv.push('-c', options.cwd)
  // Always pin the pane's runtime flags: when the dashboard happens to start the
  // tmux server itself, the pane would otherwise inherit PI_RUNTIME=dashboard and
  // the Pi inside would silently skip live-session registration.
  const env = { PI_RUNTIME: 'live', PI_SLOT_KEY: '', PI_DASH_BRIDGE_SOCKET: '', PI_DASH_BRIDGE_TOKEN: '', ...options.env }
  for (const [key, value] of Object.entries(env)) argv.push('-e', `${key}=${value}`)
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
/**
 * Last visible rows of a pane, for failure diagnostics.
 *
 * A launcher timeout only says "did not register"; the pane is where Pi wrote
 * the actual reason (crash, bad flag, provider refusal).
 */
export function captureTmuxPane(fullName: string, lines = 200): string {
  try {
    return execFileSync('tmux', ['capture-pane', '-p', '-t', sanitizeTmuxSession(fullName), '-S', `-${lines}`], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

export function killTmuxSession(name: string): void {
  const fullName = sanitizeTmuxSession(name)
  if (!hasTmuxSession(fullName)) return
  execFileSync('tmux', ['kill-session', '-t', fullName], { stdio: 'ignore' })
}