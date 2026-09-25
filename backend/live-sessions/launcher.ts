import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { LiveSessionSummary } from '../../shared/src/live-sessions.js'
import type { PiManager } from '../pi-manager.js'
import {
  createTmuxSession,
  hasTmuxSession,
  killTmuxSession,
  resolvePiCommand,
  tmuxPanePid,
  captureTmuxPane,
  type CreateTmuxSessionOptions,
} from '../tmux-sessions.js'
import { LiveSessionPathPolicy } from './path-policy.js'
import type { LivePiLaunchConfig } from './config.js'

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/**
 * How long to wait for the freshly launched Pi to register over the broker.
 *
 * Measured on this machine (34 real starts): median 6.6s, but a cold Pi start
 * under load has been seen at 28–34s, i.e. just past the old 30s limit — the
 * launch then "failed" although the Pi was about to be ready. The timeout is a
 * safety net, not a performance budget, so it is generous and overridable.
 */
const DEFAULT_REGISTRATION_TIMEOUT_MS = 120_000
const REGISTRATION_TIMEOUT_ENV = 'PI_DASH_LIVE_START_TIMEOUT_MS'
const REGISTRATION_POLL_MS = 400

/** Pane rows attached to a timeout error so a slow/crashed Pi is diagnosable. */
const PANE_TAIL_LINES = 12

function registrationTimeoutFromEnv(): number | undefined {
  const raw = Number.parseInt(process.env[REGISTRATION_TIMEOUT_ENV] ?? '', 10)
  return Number.isFinite(raw) && raw >= 1_000 ? raw : undefined
}

export interface LivePiStartOptions {
  cwd: string
  modelProvider?: string
  modelId?: string
  thinkingLevel?: string
  title?: string
  /**
   * Absolute path of a session file to fork (`pi --fork <path>`). The pane still
   * starts a brand-new Pi, so the source session keeps running untouched and
   * the fork lives on as its own session file.
   */
  forkFrom?: string
  /**
   * Absolute path of an existing session file to resume (`pi --session <path>`).
   * Used for entry-level forks: the dashboard first extracts the root→entry
   * branch into a new file, then starts a Pi on it. Mutually exclusive with
   * `forkFrom` (pi rejects both flags together).
   */
  sessionFile?: string
}

export interface LivePiStartResult {
  /** Namespaced tmux session name (`pi-dash-live-xxxxxxxx`). */
  tmuxSession: string
  cwd: string
  title: string
  /** Present once the Pi has registered; the live session the UI should open. */
  processInstanceId?: string
  sessionId?: string
}

/** Narrow structural view of the live registry, so tests need no real broker. */
export interface LiveSessionLister {
  list(): Pick<LiveSessionSummary, 'processInstanceId' | 'sessionId' | 'canonicalCwd' | 'startedAt' | 'pid'>[]
}

export interface LivePiLauncherOptions {
  registry: LiveSessionLister
  roots: readonly string[]
  /**
   * Legacy only: RPC live slots created before tmux-first still sit in the
   * manager and get a graceful shutdown. Nothing creates new ones.
   */
  manager?: Pick<PiManager, 'gracefulShutdown'>
  createSession?: (name: string, options: CreateTmuxSessionOptions) => string
  killSession?: (name: string) => void
  panePid?: (fullName: string) => number | undefined
  /** Pane text for failure diagnostics (`tmux capture-pane`). */
  capturePane?: (fullName: string) => string
  sessionExists?: (fullName: string) => boolean
  /** Wrapper/args/unset list, so a pane can mirror the user's terminal launcher. */
  launch?: LivePiLaunchConfig
  piCommand?: string
  registrationTimeoutMs?: number
  pollIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Starts live Pi sessions **inside tmux**, so web and terminal are the same
 * process.
 *
 * The dashboard used to spawn `pi --mode rpc` as its own child: the session died
 * with the dashboard, and the terminal had no way in. Now the Pi TUI lives in a
 * detached `pi-dash-live-*` tmux session, registers itself through the existing
 * live-session bridge (that path is launcher-agnostic: any Pi whose extension
 * loads and which is not `PI_RUNTIME=dashboard` shows up in the sidebar), and the
 * dashboard is only a client. `tmux attach -t <name>` reaches the same session,
 * and a dashboard restart no longer touches it.
 */
export class LivePiLauncher {
  private readonly pathPolicy: LiveSessionPathPolicy
  private readonly registry: LiveSessionLister
  private readonly createSession: (name: string, options: CreateTmuxSessionOptions) => string
  private readonly killSession: (name: string) => void
  private readonly panePid: (fullName: string) => number | undefined
  private readonly capturePane: (fullName: string) => string
  private readonly sessionExists: (fullName: string) => boolean
  private readonly registrationTimeoutMs: number
  private readonly pollIntervalMs: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: LivePiLauncherOptions) {
    this.pathPolicy = new LiveSessionPathPolicy(options.roots)
    this.registry = options.registry
    this.createSession = options.createSession ?? createTmuxSession
    this.killSession = options.killSession ?? killTmuxSession
    this.panePid = options.panePid ?? tmuxPanePid
    this.capturePane = options.capturePane ?? captureTmuxPane
    this.sessionExists = options.sessionExists ?? hasTmuxSession
    this.registrationTimeoutMs = options.registrationTimeoutMs ?? registrationTimeoutFromEnv() ?? DEFAULT_REGISTRATION_TIMEOUT_MS
    this.pollIntervalMs = options.pollIntervalMs ?? REGISTRATION_POLL_MS
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  async start(options: LivePiStartOptions): Promise<LivePiStartResult> {
    const rawCwd = options.cwd === '~'
      ? os.homedir()
      : options.cwd.startsWith('~/') ? path.join(os.homedir(), options.cwd.slice(2)) : options.cwd
    const decision = await this.pathPolicy.authorize(rawCwd)
    if (!decision.allowed || !decision.canonicalCwd) throw new Error(decision.message || 'cwd is outside configured live session roots')
    if (options.thinkingLevel && !THINKING_LEVELS.has(options.thinkingLevel)) throw new Error('invalid_thinking_level')
    if (options.modelProvider && !options.modelId) throw new Error('model_id_required')
    if (options.modelId && !options.modelProvider) throw new Error('model_provider_required')
    if (options.forkFrom && !path.isAbsolute(options.forkFrom)) throw new Error('invalid_fork_from')
    if (options.sessionFile && !path.isAbsolute(options.sessionFile)) throw new Error('invalid_session_file')

    const cwd = decision.canonicalCwd
    const title = options.title?.trim().slice(0, 120) || `Live · ${path.basename(cwd)}`
    const startedAt = Date.now()
    const before = new Set(this.registry.list().map(session => session.processInstanceId))
    const tmuxSession = this.createFreshSession(cwd, title, options)

    const registered = await this.awaitRegistration(before, cwd, tmuxSession)
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)

    if (!registered) {
      // Never leave a half-started pane behind: without registration the UI
      // cannot reach it, and an orphan Pi would keep burning tokens. The pane
      // tail is attached because a start failure is otherwise undiagnosable
      // ("did not register" says nothing about why).
      const detail = this.paneTail(tmuxSession)
      try { this.killSession(tmuxSession) } catch { /* best effort */ }
      console.error(`[live-launcher] start failed after ${elapsed}s cwd=${cwd} tmux=${tmuxSession}`)
      throw new Error(`live_pi_registration_timeout: tmux session ${tmuxSession} was killed after ${this.registrationTimeoutMs}ms without registering${detail}`)
    }
    // Start latency is tracked because the registration timeout is a safety net:
    // a slow trend here (or a cluster of 30s+ starts) is the signal to act on.
    console.log(`[live-launcher] started ${tmuxSession} in ${elapsed}s cwd=${cwd} pid=${registered.pid ?? '?'}`)
    return {
      tmuxSession,
      cwd,
      title,
      processInstanceId: registered.processInstanceId,
      sessionId: registered.sessionId,
    }
  }

  /** Called on dashboard shutdown: tmux sessions deliberately survive it. */
  async stop(): Promise<void> {
    await this.options.manager?.gracefulShutdown()
    await this.pathPolicy.stop()
  }

  /**
   * Build the pane's argv.
   *
   * `unsetEnv` is applied with `env -u` instead of `tmux -e VAR=`: an empty value
   * is not the same thing as an absent one, and provider detection can treat
   * "defined but blank" differently from "missing".
   */
  private createFreshSession(cwd: string, title: string, options: LivePiStartOptions): string {
    const args = [
      ...(this.options.launch?.args ?? []),
      ...(options.forkFrom ? ['--fork', options.forkFrom] : []),
      ...(options.sessionFile ? ['--session', options.sessionFile] : []),
      ...(options.modelProvider && options.modelId ? ['--model', `${options.modelProvider}/${options.modelId}`] : []),
      ...(options.thinkingLevel ? ['--thinking', options.thinkingLevel] : []),
      '--name', title,
    ]
    const env = paneEnvironment()
    const command = this.options.launch?.command || this.options.piCommand || resolvePiCommand()
    const unset = this.options.launch?.unsetEnv ?? []
    const launch = paneLaunchArgv({ command, args, unsetEnv: unset })
    let lastError: unknown
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const name = `live-${randomUUID().slice(0, 8)}`
      const fullName = `pi-dash-${name}`
      if (this.sessionExists(fullName)) continue
      try {
        return this.createSession(name, { ...launch, cwd, env })
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        if (code === 'ENOENT') throw new Error('tmux_unavailable: tmux is not installed or not on PATH')
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('live_pi_start_failed: could not create a tmux session')
  }

  /**
   * Wait for a *new* registration in the same directory. The pane pid is the Pi
   * pid (`pi` `exec`s its real process), so it is used as the strong match when
   * tmux can report it; the cwd stays as the fallback.
   */
  private async awaitRegistration(
    before: ReadonlySet<string>,
    cwd: string,
    tmuxSession: string,
  ): Promise<Pick<LiveSessionSummary, 'processInstanceId' | 'sessionId' | 'pid'> | undefined> {
    const deadline = Date.now() + this.registrationTimeoutMs
    /** A pane can read as gone for one poll while tmux settles; require two. */
    let missingPolls = 0
    for (;;) {
      const panePid = this.panePid(tmuxSession)
      const candidates = this.registry.list()
        .filter(session => !before.has(session.processInstanceId) && session.canonicalCwd === cwd)
        .sort((left, right) => right.startedAt - left.startedAt)
      const match = (panePid === undefined ? undefined : candidates.find(session => session.pid === panePid)) ?? candidates[0]
      if (match) return match
      // The pane is gone: the Pi exited (bad flags, crash, missing provider) and
      // no amount of waiting will register it. Fail now instead of burning the
      // whole timeout, and let the caller report the pane output.
      if (panePid === undefined) {
        missingPolls += 1
        if (missingPolls >= 2) return undefined
      } else {
        missingPolls = 0
      }
      if (Date.now() >= deadline) return undefined
      await this.sleep(this.pollIntervalMs)
    }
  }

  /** Last visible pane rows, for the timeout error message. */
  private paneTail(tmuxSession: string): string {
    try {
      const lines = this.capturePane(tmuxSession).split('\n').map(line => line.trimEnd()).filter(line => line.trim()).slice(-PANE_TAIL_LINES)
      return lines.length ? `\n--- Pi 启动输出（最后 ${lines.length} 行）---\n${lines.join('\n')}` : ''
    } catch {
      return ''
    }
  }
}

/**
 * The environment for the pane. Explicit rather than inherited: the dashboard
 * exports `PI_RUNTIME=dashboard`, and the live-session extension skips
 * registration for exactly that value — and when tmux already has a server, a
 * new session would otherwise inherit *its* environment, not ours.
 */
export function paneEnvironment(): Record<string, string> {
  return {
    PI_RUNTIME: 'live',
    TERM: 'xterm-256color',
    // Never inherit a dashboard slot identity into a pane.
    PI_SLOT_KEY: '',
    PI_DASH_BRIDGE_SOCKET: '',
    PI_DASH_BRIDGE_TOKEN: '',
  }
}

/**
 * Pane argv for the configured launcher, applying `env -u` for every variable
 * that must be absent rather than blank.
 */
export function paneLaunchArgv(input: { command: string; args: readonly string[]; unsetEnv: readonly string[] }): { command: string; args: string[] } {
  if (!input.unsetEnv.length) return { command: input.command, args: [...input.args] }
  const unset = input.unsetEnv.flatMap(name => ['-u', name])
  return { command: 'env', args: [...unset, input.command, ...input.args] }
}
