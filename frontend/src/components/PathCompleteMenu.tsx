import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api/client'
import { matchStartPaths } from '../features/live-sessions/startPathHistory'

interface Entry {
  /** `history`/`repo` entries replace the whole field; `fs` entries complete one path token. */
  kind: 'history' | 'repo' | 'fs'
  name: string
  path: string
  isDir: boolean
}

interface Props {
  input: string
  cursorPos: number
  anchorRef: React.RefObject<HTMLElement | null>
  /** Directories used before, matched by keyword — see `startPathHistory`. */
  history?: readonly string[]
  /** Repos found under `liveSessions.repoRoots`, matched the same way. */
  repos?: readonly string[]
  onComplete: (before: string, completed: string, after: string) => void
  onClose: () => void
}

/** History rows shown above the repo and filesystem listings. */
const HISTORY_ROWS = 5

/** Extract the path token around the cursor position. */
function getPathToken(input: string, cursor: number): { token: string; start: number; end: number } | null {
  // Walk left from cursor to find token start (stop at whitespace or start)
  let start = cursor
  while (start > 0 && !/\s/.test(input[start - 1])) start--
  // Walk right from cursor to find token end
  let end = cursor
  while (end < input.length && !/\s/.test(input[end])) end++
  const token = input.slice(start, end)
  // Must look like a path: starts with / or ~ or ./ or ../
  if (/^[~./]/.test(token) && token.length >= 2) return { token, start, end }
  return null
}

export default function PathCompleteMenu({ input, cursorPos, anchorRef, history = [], repos = [], onComplete, onClose }: Props) {
  const [fsEntries, setFsEntries] = useState<{ name: string; path: string; isDir: boolean }[]>([])
  const [selected, setSelected] = useState(0)
  const [tokenInfo, setTokenInfo] = useState<{ token: string; start: number; end: number } | null>(null)
  const fetchRef = useRef(0)

  // Fetch completions when token changes
  useEffect(() => {
    const info = getPathToken(input, cursorPos)
    setTokenInfo(info)
    if (!info) {
      // A bare keyword has no directory to list: only history can answer it.
      fetchRef.current += 1
      setFsEntries([])
      return
    }

    const id = ++fetchRef.current
    api.pathComplete(info.token).then(data => {
      if (id !== fetchRef.current) return
      setFsEntries(Array.isArray(data.entries) ? data.entries : [])
    }).catch(() => { if (id === fetchRef.current) setFsEntries([]) })
  }, [input, cursorPos])

  // The same text drives both halves: the path token when one is being typed,
  // otherwise the whole field as a keyword.
  const query = tokenInfo ? tokenInfo.token : input.trim()
  const entries = useMemo<Entry[]>(() => {
    const known = new Set(history)
    return [
      ...matchStartPaths(history, query, HISTORY_ROWS).map(path => ({ kind: 'history' as const, name: path, path, isDir: true })),
      ...matchStartPaths(repos.filter(path => !known.has(path)), query, HISTORY_ROWS)
        .map(path => ({ kind: 'repo' as const, name: path, path, isDir: true })),
      ...fsEntries.map(entry => ({ kind: 'fs' as const, ...entry })),
    ]
  }, [history, repos, query, fsEntries])
  const active = entries.length ? Math.min(selected, entries.length - 1) : 0

  const applyCompletion = useCallback((entry: Entry) => {
    if (entry.kind === 'history' || entry.kind === 'repo') {
      // Both answer a keyword, not a path prefix, so they replace the field.
      onComplete('', entry.path + '/', '')
      return
    }
    if (!tokenInfo) return
    onComplete(
      input.slice(0, tokenInfo.start),
      entry.path + (entry.isDir ? '/' : ' '),
      input.slice(tokenInfo.end),
    )
    // A directory keeps the menu open for further drilling; a file ends it.
    if (!entry.isDir) onClose()
  }, [tokenInfo, input, onComplete, onClose])

  const onKey = useCallback((e: KeyboardEvent) => {
    if (entries.length === 0) return
    if (e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      applyCompletion(entries[active])
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      setSelected(i => (i + 1) % entries.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      setSelected(i => (i - 1 + entries.length) % entries.length)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }, [entries, active, applyCompletion, onClose])

  useEffect(() => {
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onKey])

  if (entries.length === 0 || !anchorRef.current) return null

  const rect = anchorRef.current.getBoundingClientRect()
  const menuH = Math.min(entries.length * 32 + 8, 320)
  const above = rect.top - menuH - 4
  const top = above > 0 ? above : rect.bottom + 4

  return createPortal(
    <div
      role="listbox"
      aria-label="目录补全"
      className="fixed z-[9999] bg-card border border-border rounded-lg shadow-lg overflow-y-auto py-1 animate-slide-up"
      style={{ top, left: rect.left, width: Math.min(rect.width, 480), maxHeight: 320 }}
    >
      {entries.map((entry, i) => (
        <button
          key={`${entry.kind}:${entry.path}`}
          role="option"
          aria-selected={i === active}
          className={`w-full text-left px-3 py-1.5 flex items-center gap-2 cursor-pointer transition-colors text-body-s font-mono ${i === active ? 'bg-accent-subtle text-text' : 'text-muted hover:bg-bg-hover hover:text-text'}`}
          onMouseEnter={() => setSelected(i)}
          onMouseDown={e => { e.preventDefault(); applyCompletion(entry) }}
        >
          <span className="shrink-0 w-4 text-center">{entry.kind === 'history' ? '🕘' : entry.kind === 'repo' ? '📦' : entry.isDir ? '📁' : '📄'}</span>
          <span className="truncate flex-1">{entry.kind === 'fs' ? `${entry.name}${entry.isDir ? '/' : ''}` : entry.path}</span>
          <span className="text-2xs text-muted opacity-50 shrink-0 ml-auto">{entry.kind === 'history' ? '用过的目录' : entry.kind === 'repo' ? '仓库目录' : entry.isDir ? 'dir' : 'file'}</span>
        </button>
      ))}
      <div className="px-3 py-1 border-t border-border text-2xs text-muted opacity-40 flex gap-3">
        <span>⇥ Tab complete</span>
        <span>↑↓ navigate</span>
        <span>Esc dismiss</span>
      </div>
    </div>,
    document.body,
  )
}
