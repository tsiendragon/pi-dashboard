/**
 * PTY Manager — bridges browser WebSocket clients to tmux sessions over
 * node-pty.
 *
 * The tmux session (and the Pi TUI / shell running inside it) is the single
 * source of truth. This module spawns a `tmux attach` process per client and
 * forwards raw terminal bytes both ways. Killing that attach process detaches
 * the client but NEVER kills the tmux session itself.
 */
import * as pty from 'node-pty'
import WebSocket from 'ws'
import { IncomingMessage } from 'http'
import { sanitizeTmuxSession } from './tmux-sessions.js'

const clients = new Map<WebSocket, pty.IPty>()

export function handlePtyConnection(ws: WebSocket, req: IncomingMessage): void {
  let url: URL
  try {
    url = new URL(req.url || '/', 'http://localhost')
  } catch {
    if (ws.readyState === WebSocket.OPEN) ws.close(1008, 'bad url')
    return
  }

  let session: string
  try {
    session = sanitizeTmuxSession(url.searchParams.get('session') || '')
  } catch (err) {
    console.error('[pty] Invalid session requested:', (err as Error).message)
    if (ws.readyState === WebSocket.OPEN) ws.close(1008, 'invalid session')
    return
  }

  const cols = parseInt(url.searchParams.get('cols') || '120', 10) || 120
  const rows = parseInt(url.searchParams.get('rows') || '30', 10) || 30

  let proc: pty.IPty
  try {
    proc = pty.spawn('tmux', ['attach', '-t', session], {
      name: 'xterm-256color',
      cols,
      rows,
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    })
  } catch (err) {
    console.error('[pty] tmux attach failed (non-fatal):', session, (err as Error).message)
    if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'tmux attach failed')
    return
  }

  clients.set(ws, proc)

  proc.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data)
  })

  proc.onExit(() => {
    clients.delete(ws)
    if (ws.readyState === WebSocket.OPEN) ws.close()
  })

  ws.on('message', (raw: WebSocket.RawData) => {
    const msg = typeof raw === 'string' ? raw : raw.toString()
    if (msg[0] === '{') {
      try {
        const cmd = JSON.parse(msg)
        if (cmd.type === 'resize') proc.resize(Number(cmd.cols) || cols, Number(cmd.rows) || rows)
        return
      } catch { /* not JSON, pass through as terminal input */ }
    }
    proc.write(msg)
  })

  ws.on('close', () => {
    // Killing the `tmux attach` process detaches this client only.
    try { proc.kill() } catch { /* already exited */ }
    clients.delete(ws)
  })
}

/** Detach all clients (kill their attach processes) — never kills tmux sessions. */
export function shutdownPtyClients(): void {
  for (const proc of clients.values()) {
    try { proc.kill() } catch { /* already exited */ }
  }
  clients.clear()
}