import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { usePtySocket } from './usePtySocket'
import { createPtySession, listPtySessions, ptyAuth } from './api'

const PTY_PREFIX = 'pi-dash-'

function stripPrefix(name: string): string {
  return name.startsWith(PTY_PREFIX) ? name.slice(PTY_PREFIX.length) : name
}

export default function TerminalPanel({ onClose }: { onClose: () => void }) {
  const [authState, setAuthState] = useState<'checking' | 'authed' | 'unauthed'>('checking')
  const [token, setToken] = useState('')
  const [authError, setAuthError] = useState('')
  const [sessions, setSessions] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const writeRef = useRef<(data: string) => void>(() => {})

  const onSocketData = useCallback((data: string) => {
    termRef.current?.write(data)
  }, [])

  const { status, write, resize } = usePtySocket(selected, onSocketData)

  useEffect(() => { writeRef.current = write }, [write])

  // Create the xterm instance once.
  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
      scrollback: 5000,
      allowProposedApi: true,
      theme: { background: '#0b0d10' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new Unicode11Addon())
    term.loadAddon(new WebLinksAddon())
    termRef.current = term
    fitRef.current = fit
    if (containerRef.current) {
      term.open(containerRef.current)
      try { fit.fit() } catch { /* container not sized yet */ }
    }
    term.onData(d => writeRef.current(d))
    return () => {
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  // When the socket connects, fit the terminal and push its size to the PTY.
  useEffect(() => {
    if (status !== 'connected') return
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    try { fit.fit() } catch { /* ignore */ }
    resize(term.cols, term.rows)
  }, [status, resize])

  const refresh = useCallback(async () => {
    setAuthState('checking')
    try {
      const res = await listPtySessions()
      setSessions(res.sessions)
      setAuthState('authed')
      setSelected(prev => prev ?? res.sessions[0] ?? null)
    } catch (e: any) {
      if (e?.status === 401) setAuthState('unauthed')
      else {
        setAuthState('authed')
        setAuthError(e?.message || 'Failed to list sessions')
      }
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const submitAuth = async () => {
    setBusy(true)
    setAuthError('')
    try {
      await ptyAuth(token.trim())
      setToken('')
      await refresh()
    } catch (e: any) {
      setAuthError(e?.message || 'Authentication failed')
    } finally {
      setBusy(false)
    }
  }

  const create = async () => {
    if (!newName.trim()) return
    setBusy(true)
    setAuthError('')
    try {
      const res = await createPtySession(newName.trim())
      setNewName('')
      setSessions(prev => (prev.includes(res.name) ? prev : [...prev, res.name]))
      setSelected(res.name)
    } catch (e: any) {
      setAuthError(e?.message || 'Failed to create session')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col h-full bg-bg text-text">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <span className="text-sm font-semibold">🖥️ Terminal</span>
        {selected && <span className="text-[11px] text-muted font-mono">{status === 'connected' ? `connected · ${stripPrefix(selected)}` : status}</span>}
        <button className="ml-auto text-muted hover:text-text" onClick={onClose} aria-label="Close terminal">✕</button>
      </div>

      {authState === 'checking' && (
        <div className="p-4 text-sm text-muted">Checking terminal access…</div>
      )}

      {authState === 'unauthed' && (
        <div className="p-4 flex flex-col gap-2">
          <p className="text-sm">终端需要控制权认证。读取 <code className="text-accent">live-control-token</code> 文件的内容（路径见 Dashboard 启动日志）后粘贴：</p>
          <div className="flex gap-2">
            <input
              className="flex-1 bg-bg-elevated border border-border rounded px-2 py-1.5 text-sm font-mono"
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void submitAuth() }}
              placeholder="control token"
            />
            <button className="px-3 py-1.5 rounded bg-accent text-white text-sm disabled:opacity-50" onClick={() => void submitAuth()} disabled={busy || !token.trim()}>认证</button>
          </div>
          {authError && <p className="text-xs text-danger">{authError}</p>}
        </div>
      )}

      {authState === 'authed' && (
        <>
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0 text-[13px]">
            <select
              className="flex-1 bg-bg-elevated border border-border rounded px-2 py-1.5 text-sm font-mono"
              value={selected ?? ''}
              onChange={e => setSelected(e.target.value)}
            >
              <option value="" disabled>选择会话</option>
              {sessions.map(s => <option key={s} value={s}>{stripPrefix(s)}</option>)}
            </select>
            <button className="text-xs text-muted hover:text-accent" onClick={() => void refresh()} title="刷新">↻</button>
            <input
              className="w-40 bg-bg-elevated border border-border rounded px-2 py-1.5 text-sm font-mono"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void create() }}
              placeholder="新会话名"
            />
            <button className="px-2 py-1.5 rounded bg-accent text-white text-xs disabled:opacity-50" onClick={() => void create()} disabled={busy || !newName.trim()}>新建</button>
          </div>

          {authError && <div className="px-3 py-1 text-xs text-danger border-b border-border">{authError}</div>}

          <div className="flex-1 min-h-0 bg-[#0b0d10] px-2 py-1">
            <div ref={containerRef} className="h-full w-full" />
          </div>
        </>
      )}
    </div>
  )
}