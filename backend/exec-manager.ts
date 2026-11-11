import * as pty from 'node-pty'
import WebSocket from 'ws'
import type { IncomingMessage } from 'node:http'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/**
 * One interactive command per WebSocket, run in a real PTY.
 *
 * Why this exists: every now and then an agent has to hand a command back to the
 * human — a script that reads a password with `getpass`, an SSH prompt, a REPL — and
 * the phone cannot open a terminal. This runs exactly the command the user confirmed,
 * forwards keystrokes (including a hidden password prompt), and prints the output.
 *
 * Safety the caller can rely on:
 * - nothing is written to disk or logged (not the command, not the output, not input);
 * - the process is killed when the socket closes or goes idle, and the tmux/Pi TUI is
 *   never touched, so this cannot wedge a session;
 * - the command is validated but *not* sandboxed: it runs as the dashboard user, the
 *   same privilege the WebUI terminal already has. The client must confirm it.
 */
export const EXEC_MAX_COMMAND_BYTES = 8 * 1024
export const EXEC_START_TIMEOUT_MS = 10_000
export const EXEC_IDLE_TIMEOUT_MS = 15 * 60_000
export const EXEC_MAX_LIFETIME_MS = 60 * 60_000
export const EXEC_MAX_PER_CLIENT = 3
/** Stop reading from the PTY above this much unflushed socket data (the command floods output). */
const EXEC_MAX_BUFFERED_BYTES = 4 * 1024 * 1024

const activeByClient = new Map<string, number>()

export type ExecStart = { type: 'start'; command: string; cwd: string; cols: number; rows: number }
export type ExecControl =
  | ExecStart
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'signal'; name: 'SIGINT' | 'SIGTERM' }

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function onlyKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => key in value) && Object.keys(value).every(key => allowed.has(key))
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(1, Math.min(Math.floor(number), max))
}

/** Validates one client frame. Unknown fields are rejected so a typo cannot look like input. */
export function parseExecControl(value: unknown): ExecControl | undefined {
  const frame = record(value)
  if (!frame || typeof frame.type !== 'string') return undefined
  if (frame.type === 'start') {
    if (!onlyKeys(frame, ['type', 'command', 'cwd'], ['cols', 'rows'])) return undefined
    const command = typeof frame.command === 'string' ? frame.command.trim() : ''
    const cwd = typeof frame.cwd === 'string' ? frame.cwd.trim() : ''
    if (!command || Buffer.byteLength(command, 'utf8') > EXEC_MAX_COMMAND_BYTES) return undefined
    if (!cwd || !isAbsolute(cwd)) return undefined
    return { type: 'start', command, cwd, cols: positiveInt(frame.cols, 120, 500), rows: positiveInt(frame.rows, 30, 300) }
  }
  if (frame.type === 'input') {
    if (!onlyKeys(frame, ['type', 'data'])) return undefined
    if (typeof frame.data !== 'string' || frame.data.length > 16 * 1024) return undefined
    return { type: 'input', data: frame.data }
  }
  if (frame.type === 'resize') {
    if (!onlyKeys(frame, ['type', 'cols', 'rows'])) return undefined
    return { type: 'resize', cols: positiveInt(frame.cols, 120, 500), rows: positiveInt(frame.rows, 30, 300) }
  }
  if (frame.type === 'signal') {
    if (!onlyKeys(frame, ['type', 'name'])) return undefined
    if (frame.name !== 'SIGINT' && frame.name !== 'SIGTERM') return undefined
    return { type: 'signal', name: frame.name }
  }
  return undefined
}

export function execCwdAvailable(cwd: string): boolean {
  try {
    return statSync(cwd).isDirectory()
  } catch {
    return false
  }
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
}

export function handleExecConnection(ws: WebSocket, _req: IncomingMessage, identity: { browserClientId: string }): void {
  const clientKey = identity.browserClientId
  const running = activeByClient.get(clientKey) ?? 0
  if (running >= EXEC_MAX_PER_CLIENT) {
    send(ws, { type: 'error', code: 'too_many_sessions', message: `同时最多运行 ${EXEC_MAX_PER_CLIENT} 条交互式命令` })
    ws.close()
    return
  }
  activeByClient.set(clientKey, running + 1)
  let released = false
  const release = () => {
    if (released) return
    released = true
    const next = (activeByClient.get(clientKey) ?? 1) - 1
    if (next <= 0) activeByClient.delete(clientKey)
    else activeByClient.set(clientKey, next)
  }

  let proc: pty.IPty | undefined
  let idleTimer: NodeJS.Timeout | undefined
  let lifetimeTimer: NodeJS.Timeout | undefined
  let outputDropped = false

  // forkpty makes the shell a session leader, so its PID is also the process-group id.
  // Killing only the shell leaves `sleep`, `ssh`, `tail -f` … running as orphans: close
  // the page and the phone looks done while the server keeps working. Signal the group,
  // then insist.
  const stop = () => {
    if (idleTimer) clearTimeout(idleTimer)
    if (lifetimeTimer) clearTimeout(lifetimeTimer)
    idleTimer = undefined
    lifetimeTimer = undefined
    const current = proc
    proc = undefined
    if (!current) return
    const pid = current.pid
    try { process.kill(-pid, 'SIGHUP') } catch { try { current.kill('SIGHUP') } catch { /* gone */ } }
    const force = setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL') } catch { /* group gone */ }
      try { current.kill('SIGKILL') } catch { /* process gone */ }
    }, 2_000)
    force.unref?.()
  }
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      send(ws, { type: 'error', code: 'idle_timeout', message: '命令长时间没有输入或输出，已结束' })
      stop()
      ws.close()
    }, EXEC_IDLE_TIMEOUT_MS)
    idleTimer.unref?.()
  }

  const startTimer = setTimeout(() => {
    send(ws, { type: 'error', code: 'start_timeout', message: '没有收到要运行的命令' })
    ws.close()
  }, EXEC_START_TIMEOUT_MS)
  startTimer.unref?.()

  ws.on('message', raw => {
    let frame: ExecControl | undefined
    try {
      frame = parseExecControl(JSON.parse(typeof raw === 'string' ? raw : raw.toString()))
    } catch {
      frame = undefined
    }
    if (!frame) {
      send(ws, { type: 'error', code: 'invalid_frame', message: '无法识别的控制消息' })
      return
    }
    if (frame.type === 'start') {
      if (proc) {
        send(ws, { type: 'error', code: 'already_started', message: '这条连接已经在运行一条命令' })
        return
      }
      clearTimeout(startTimer)
      if (!execCwdAvailable(frame.cwd)) {
        send(ws, { type: 'error', code: 'invalid_cwd', message: '目录不存在或不可访问' })
        ws.close()
        return
      }
      try {
        proc = pty.spawn('/bin/bash', ['-lc', frame.command], {
          name: 'xterm-256color',
          cwd: frame.cwd,
          cols: frame.cols,
          rows: frame.rows,
          env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
        })
      } catch (error) {
        send(ws, { type: 'error', code: 'spawn_failed', message: (error as Error).message })
        ws.close()
        return
      }
      send(ws, { type: 'started', pid: proc.pid })
      proc.onData(data => {
        touch()
        if (ws.bufferedAmount > EXEC_MAX_BUFFERED_BYTES) {
          if (!outputDropped) {
            outputDropped = true
            send(ws, { type: 'output', data: '\n…输出太快，网络跟不上，省略了部分内容…\n' })
          }
          return
        }
        send(ws, { type: 'output', data })
      })
      proc.onExit(({ exitCode, signal }) => {
        send(ws, { type: 'exit', code: exitCode, ...(signal ? { signal } : {}) })
        // The command finished by itself: do not group-signal a PID that may be reused.
        proc = undefined
        stop()
        ws.close()
      })
      touch()
      lifetimeTimer = setTimeout(() => {
        send(ws, { type: 'error', code: 'lifetime_exceeded', message: '命令达到最长运行时间，已结束' })
        stop()
        ws.close()
      }, EXEC_MAX_LIFETIME_MS)
      lifetimeTimer.unref?.()
      return
    }
    if (!proc) {
      send(ws, { type: 'error', code: 'not_started', message: '请先发送要运行的命令' })
      return
    }
    touch()
    if (frame.type === 'input') proc.write(frame.data)
    else if (frame.type === 'resize') proc.resize(frame.cols, frame.rows)
    else if (frame.type === 'signal') {
      // node-pty has no portable signal API: SIGINT is sent as Ctrl-C (what a terminal
      // sends), SIGTERM ends the PTY from our side.
      if (frame.name === 'SIGINT') proc.write('\u0003')
      else stop()
    }
  })

  ws.on('close', () => {
    clearTimeout(startTimer)
    stop()
    release()
  })
  ws.on('error', () => {
    clearTimeout(startTimer)
    stop()
    release()
  })
}

/** Test hook: how many commands one browser identity currently runs. */
export function activeExecCount(browserClientId: string): number {
  return activeByClient.get(browserClientId) ?? 0
}