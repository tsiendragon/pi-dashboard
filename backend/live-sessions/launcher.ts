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
  type CreateTmuxSessionOptions,
} from '../tmux-sessions.js'
import { LiveSessionPathPolicy } from './path-policy.js'

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** How long to wait for the freshly launched Pi to register over the broker. */
const DEFAULT_REGISTRATION_TIMEOUT_MS = 30_000
const REGISTRATION_POLL_MS = 400

export interface LivePiStartOptions {
  cwd: string
  modelProvider?: string
  modelId?: string
  thinkingLevel?: string
  title?: string
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
  sessionExists?: (fullName: string) => boolean
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
    this.sessionExists = options.sessionExists ?? hasTmuxSession
    this.registrationTimeoutMs = options.registrationTimeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS
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

    const cwd = decision.canonicalCwd
    const title = options.title?.trim().slice(0, 120) || `Live · ${path.basename(cwd)}`
    const before = new Set(this.registry.list().map(session => session.processInstanceId))
    const tmuxSession = this.createFreshSession(cwd, title, options)

    const registered = await this.awaitRegistration(before, cwd, tmuxSession)

    if (!registered) {
      // Never leave a half-started pane behind: without registration the UI
      // cannot reach it, and an orphan Pi would keep burning tokens.
      try { this.killSession(tmuxSession) } catch { /* best effort */ }
      throw new Error(`live_pi_registration_timeout: tmux session ${tmuxSession} was killed after ${this.registrationTimeoutMs}ms without registering`)
    }
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
   * Create the pane under a name that is definitely unused. Reusing an existing
   * `pi-dash-*` name would attach the live row to somebody else's Pi and — on
   * the registration timeout — kill it.
   */
  private createFreshSession(cwd: string, title: string, options: LivePiStartOptions): string {
    const args = [
      ...(options.modelProvider && options.modelId ? ['--model', `${options.modelProvider}/${options.modelId}`] : []),
      ...(options.thinkingLevel ? ['--thinking', options.thinkingLevel] : []),
      '--name', title,
    ]
    const env = paneEnvironment()
    const command = this.options.piCommand ?? resolvePiCommand()
    let lastError: unknown
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const name = `live-${randomUUID().slice(0, 8)}`
      const fullName = `pi-dash-${name}`
      if (this.sessionExists(fullName)) continue
      try {
        return this.createSession(name, { command, cwd, args, env })
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
  ): Promise<Pick<LiveSessionSummary, 'processInstanceId' | 'sessionId'> | undefined> {
    const deadline = Date.now() + this.registrationTimeoutMs
    for (;;) {
      const panePid = this.panePid(tmuxSession)
      const candidates = this.registry.list()
        .filter(session => !before.has(session.processInstanceId) && session.canonicalCwd === cwd)
        .sort((left, right) => right.startedAt - left.startedAt)
      const match = (panePid === undefined ? undefined : candidates.find(session => session.pid === panePid)) ?? candidates[0]
      if (match) return match
      if (Date.now() >= deadline) return undefined
      await this.sleep(this.pollIntervalMs)
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
