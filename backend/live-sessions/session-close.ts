/**
 * Ending a live session from the dashboard.
 *
 * Two shapes exist and they need different close handles:
 *
 * - **tmux-first session** (a live Pi started from the dashboard, or a fork):
 *   the tmux session IS the close handle — killing it ends the Pi. Same path as
 *   `DELETE /api/pty/sessions/:name`.
 * - **subagent child process** (spawned by the subagent workbench, shown in the
 *   subagent strip of a live-session page): a plain child process with no tmux
 *   session, so it is signalled directly. No bookkeeping is needed here — the
 *   registry drops the session on its own once the process exits.
 *
 * Safety: the PID arrives from the browser, so it is re-verified against the
 * process environment ({@link isSubagentChildProcess}) before any signal. A
 * recycled or unrelated PID never matches and is refused rather than signalled.
 */
import { killTmuxSession } from '../tmux-sessions.js'
import { isSubagentChildProcess } from './process-env.js'

export type LiveSessionCloseMethod = 'tmux' | 'signal'

export interface LiveSessionCloseTarget {
  pid: number
  /** tmux session hosting this live Pi, when it has one. */
  tmuxSession?: string
}

export interface LiveSessionCloseResult {
  method: LiveSessionCloseMethod
  pid: number
  /** True when the process had already exited by the time we looked. */
  alreadyGone: boolean
}

export type LiveSessionCloseErrorCode = 'live_session_pid_invalid' | 'live_session_pid_unverifiable'

export class LiveSessionCloseError extends Error {
  constructor(readonly code: LiveSessionCloseErrorCode, message: string) {
    super(message)
    this.name = 'LiveSessionCloseError'
  }
}

export interface LiveSessionCloseDeps {
  killTmuxSession?: (name: string) => void
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void
  isProcessAlive?: (pid: number) => boolean
  isSubagentProcess?: (pid: number) => boolean
  waitForExit?: (pid: number, timeoutMs: number) => Promise<boolean>
  /** Grace between SIGTERM and the SIGKILL escalation. */
  graceMs?: number
}

export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else; ESRCH means gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function defaultWaitForExit(pid: number, timeoutMs: number, isAlive = defaultIsProcessAlive): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return !isAlive(pid)
}

/**
 * Close one live session. Resolves once the close has been requested; a tmux
 * close is synchronous, a signal close waits at most `graceMs` for the process
 * to exit before escalating to SIGKILL.
 */
export async function closeLiveSession(
  target: LiveSessionCloseTarget,
  deps: LiveSessionCloseDeps = {},
): Promise<LiveSessionCloseResult> {
  const killTmux = deps.killTmuxSession ?? killTmuxSession

  if (target.tmuxSession) {
    killTmux(target.tmuxSession)
    return { method: 'tmux', pid: target.pid, alreadyGone: false }
  }

  if (!Number.isInteger(target.pid) || target.pid <= 0) {
    throw new LiveSessionCloseError('live_session_pid_invalid', 'live session has no usable pid')
  }

  const isSubagentProcess = deps.isSubagentProcess ?? isSubagentChildProcess
  if (!isSubagentProcess(target.pid)) {
    throw new LiveSessionCloseError('live_session_pid_unverifiable', 'pid does not belong to a subagent process')
  }

  const signalProcess = deps.signalProcess ?? ((pid, signal) => { process.kill(pid, signal) })
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive
  const waitForExit = deps.waitForExit ?? ((pid, timeoutMs) => defaultWaitForExit(pid, timeoutMs, isProcessAlive))
  const graceMs = deps.graceMs ?? 2_000

  if (!isProcessAlive(target.pid)) return { method: 'signal', pid: target.pid, alreadyGone: true }

  signalProcess(target.pid, 'SIGTERM')
  if (await waitForExit(target.pid, graceMs)) return { method: 'signal', pid: target.pid, alreadyGone: false }
  signalProcess(target.pid, 'SIGKILL')
  return { method: 'signal', pid: target.pid, alreadyGone: false }
}