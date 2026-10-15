import { access } from 'node:fs/promises'
import { constants, readFileSync } from 'node:fs'
import path from 'node:path'
import type { LiveSessionSummary } from '../../shared/src/live-sessions.js'
import type { LivePiLauncher } from './launcher.js'
import type { LiveSessionMetaStore } from './meta.js'
import type { LiveSessionRegistry } from './registry.js'
import { defaultIsProcessAlive } from './session-close.js'
import { hasTmuxSession, PTY_SESSION_PREFIX, tmuxPanePid, quitTmuxPi } from '../tmux-sessions.js'

const DEFAULT_EXIT_TIMEOUT_MS = 30_000
const LIVE_TMUX_NAME_RE = new RegExp(`^${PTY_SESSION_PREFIX}live-[A-Za-z0-9_-]{1,51}$`)

/** A zombie has already exited even though kill(pid, 0) still succeeds. */
export function isRestartProcessAlive(pid: number, readStat = (file: string) => readFileSync(file, 'utf8')): boolean {
  if (!defaultIsProcessAlive(pid)) return false
  if (process.platform !== 'linux') return true
  try {
    const stat = readStat(`/proc/${pid}/stat`)
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
    return state !== 'Z' && state !== 'X'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export class LiveSessionRestartError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'LiveSessionRestartError'
  }
}

export interface LiveSessionRestartDeps {
  registry: Pick<LiveSessionRegistry, 'get' | 'list'>
  metaStore: Pick<LiveSessionMetaStore, 'list'>
  launcher?: Pick<LivePiLauncher, 'start'>
  hasTmuxSession?: typeof hasTmuxSession
  tmuxPanePid?: typeof tmuxPanePid
  isProcessAlive?: typeof defaultIsProcessAlive
  quitPi?: typeof quitTmuxPi
  fileExists?: (filePath: string) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
  exitTimeoutMs?: number
}

/** Restarts an idle dashboard-owned TUI via /quit, then pi --session after verified exit. */
export class LiveSessionRestarter {
  private readonly registry: LiveSessionRestartDeps['registry']
  private readonly metaStore: LiveSessionRestartDeps['metaStore']
  private readonly launcher?: LiveSessionRestartDeps['launcher']
  private readonly hasTmux: typeof hasTmuxSession
  private readonly panePid: typeof tmuxPanePid
  private readonly isProcessAlive: typeof defaultIsProcessAlive
  private readonly quitPi: typeof quitTmuxPi
  private readonly fileExists: (filePath: string) => Promise<boolean>
  private readonly sleep: (ms: number) => Promise<void>
  private readonly exitTimeoutMs: number
  private readonly inFlightProcessIds = new Set<string>()

  constructor(deps: LiveSessionRestartDeps) {
    this.registry = deps.registry
    this.metaStore = deps.metaStore
    this.launcher = deps.launcher
    this.hasTmux = deps.hasTmuxSession ?? hasTmuxSession
    this.panePid = deps.tmuxPanePid ?? tmuxPanePid
    this.isProcessAlive = deps.isProcessAlive ?? isRestartProcessAlive
    this.quitPi = deps.quitPi ?? quitTmuxPi
    this.fileExists = deps.fileExists ?? (async filePath => {
      try {
        await access(filePath, constants.R_OK)
        return true
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') return false
        throw error
      }
    })
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.exitTimeoutMs = deps.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS
  }

  async restart(processInstanceId: string, expectedSessionId?: string, afterPiStopped?: (sessionFile: string) => void | Promise<void>) {
    const detail = this.registry.get(processInstanceId)
    if (!detail) throw new LiveSessionRestartError('live_session_not_found', 'live session is not available')
    const summary = detail.summary
    if (expectedSessionId && summary.sessionId !== expectedSessionId) {
      throw new LiveSessionRestartError('session_changed', 'the Pi session changed before restart began; retry with the current session')
    }
    this.assertRestartable(summary)
    if (!this.launcher) throw new LiveSessionRestartError('live_launcher_unavailable', 'live Pi launcher is unavailable')
    if (this.inFlightProcessIds.has(processInstanceId)) {
      throw new LiveSessionRestartError('restart_in_progress', 'this session is already restarting')
    }

    this.inFlightProcessIds.add(processInstanceId)
    try {
      const meta = (await this.metaStore.list())[summary.sessionId]
      const tmuxSession = meta?.tmux
      if (!tmuxSession || !LIVE_TMUX_NAME_RE.test(tmuxSession)) {
        throw new LiveSessionRestartError('session_not_dashboard_managed', 'only dashboard-managed live tmux sessions can be restarted')
      }
      if (!this.hasTmux(tmuxSession) || this.panePid(tmuxSession) !== summary.pid) {
        throw new LiveSessionRestartError('session_process_identity_mismatch', 'the tmux pane no longer matches this Pi process')
      }
      const sessionFile = summary.sessionFile
      if (!sessionFile || !path.isAbsolute(sessionFile) || !(await this.fileExists(sessionFile))) {
        throw new LiveSessionRestartError('session_file_unavailable', 'the session file is missing or unreadable')
      }
      if (this.registry.list().some(session => session.role === 'subagent' && session.parentSessionId === summary.sessionId)) {
        throw new LiveSessionRestartError('session_has_live_subagents', 'stop or finish this session’s subagents before restarting the parent')
      }
      const current = this.registry.get(processInstanceId)?.summary
      if (!current || current.sessionId !== summary.sessionId || current.sessionFile !== sessionFile || current.pid !== summary.pid) {
        throw new LiveSessionRestartError('session_changed', 'the Pi session changed during restart checks; no shutdown was sent')
      }

      this.quitPi(tmuxSession)
      await this.waitForExit(processInstanceId, summary.pid, tmuxSession)

      let afterPiStoppedError: Error | undefined
      if (afterPiStopped) {
        try {
          await afterPiStopped(sessionFile)
        } catch (error) {
          afterPiStoppedError = error instanceof Error ? error : new Error(String(error))
        }
      }

      const result = await this.launcher.start({
        cwd: summary.canonicalCwd || summary.cwd,
        ...(summary.model ? { modelProvider: summary.model.provider, modelId: summary.model.id } : {}),
        ...(summary.thinkingLevel ? { thinkingLevel: summary.thinkingLevel } : {}),
        title: summary.sessionName || `Pi ${summary.pid}`,
        sessionFile,
      })
      if (!result.processInstanceId || !result.sessionId) {
        throw new LiveSessionRestartError('restart_registration_failed', 'the resumed Pi did not register with the dashboard')
      }
      return afterPiStoppedError ? { ...result, afterPiStoppedError } : result
    } finally {
      this.inFlightProcessIds.delete(processInstanceId)
    }
  }

  private assertRestartable(summary: LiveSessionSummary): void {
    if (summary.role === 'subagent') {
      throw new LiveSessionRestartError('session_not_restartable', 'subagent sessions cannot be restarted individually')
    }
    if (summary.mode !== 'tui') {
      throw new LiveSessionRestartError('session_not_restartable', 'only TUI live sessions can be restarted with the dashboard launcher')
    }
    if (summary.status === 'running') {
      throw new LiveSessionRestartError('session_not_restartable', 'wait until Pi is idle before sending /quit')
    }
    if (summary.status === 'reconnecting') {
      throw new LiveSessionRestartError('session_not_restartable', 'the session is reconnecting; wait until it is stable before restarting')
    }
  }

  private async waitForExit(processInstanceId: string, pid: number, tmuxSession: string): Promise<void> {
    const deadline = Date.now() + this.exitTimeoutMs
    while (Date.now() < deadline) {
      if (!this.isProcessAlive(pid) && !this.hasTmux(tmuxSession) && !this.registry.get(processInstanceId)) return
      await this.sleep(100)
    }
    throw new LiveSessionRestartError('restart_exit_timeout', 'Pi did not exit in time; no replacement session was started')
  }
}
