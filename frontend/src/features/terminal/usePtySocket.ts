import { useCallback, useEffect, useRef, useState } from 'react'

export type PtyStatus = 'idle' | 'connecting' | 'connected' | 'closed'

/**
 * Maintains a browser <-> backend WebSocket for one tmux session. Raw terminal
 * bytes arrive via `onData`; call `write` to send keystrokes and `resize` to
 * sync the terminal size.
 */
export function usePtySocket(session: string | null, onData: (data: string) => void) {
  const [status, setStatus] = useState<PtyStatus>('idle')
  const wsRef = useRef<WebSocket | null>(null)
  const onDataRef = useRef(onData)
  onDataRef.current = onData

  const connect = useCallback(() => {
    if (wsRef.current) {
      try { wsRef.current.close() } catch { /* ignore */ }
      wsRef.current = null
    }
    if (!session) {
      setStatus('idle')
      return
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/api/pty?session=${encodeURIComponent(session)}`)
    wsRef.current = ws
    setStatus('connecting')

    ws.onopen = () => setStatus('connected')
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') onDataRef.current(e.data)
    }
    ws.onerror = () => { /* onclose will follow */ }
    ws.onclose = () => {
      if (wsRef.current === ws) {
        wsRef.current = null
        setStatus('closed')
      }
    }
  }, [session])

  const write = useCallback((data: string) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data)
  }, [])

  const resize = useCallback((cols: number, rows: number) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }))
  }, [])

  useEffect(() => {
    connect()
    return () => {
      if (wsRef.current) {
        try { wsRef.current.close() } catch { /* ignore */ }
        wsRef.current = null
      }
    }
  }, [connect])

  return { status, write, resize }
}