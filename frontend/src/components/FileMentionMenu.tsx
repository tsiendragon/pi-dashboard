import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api/client'

interface Entry { name: string; path: string; isDir: boolean }

interface Props {
  input: string
  cursorPos: number
  cwd?: string
  anchorRef: React.RefObject<HTMLElement | null>
  onPick: (entry: Entry, token: { start: number; end: number }) => void
  onClose: () => void
}

/** Extract a `@mention` token around the cursor. Returns null unless the token starts with `@`. */
function getMentionToken(input: string, cursor: number): { query: string; start: number; end: number } | null {
  let start = cursor
  while (start > 0 && !/\s/.test(input[start - 1])) start--
  let end = cursor
  while (end < input.length && !/\s/.test(input[end])) end++
  const token = input.slice(start, end)
  if (!token.startsWith('@')) return null
  return { query: token.slice(1), start, end }
}

export default function FileMentionMenu({ input, cursorPos, cwd, anchorRef, onPick, onClose }: Props) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [selected, setSelected] = useState(0)
  const [visible, setVisible] = useState(false)
  const [tokenInfo, setTokenInfo] = useState<{ query: string; start: number; end: number } | null>(null)
  const fetchRef = useRef(0)

  useEffect(() => {
    const info = getMentionToken(input, cursorPos)
    setTokenInfo(info)
    if (!info) { setVisible(false); setEntries([]); return }

    const id = ++fetchRef.current
    api.fileSearch(info.query, cwd).then(data => {
      if (id !== fetchRef.current) return
      if (data.entries.length > 0) {
        setEntries(data.entries)
        setSelected(0)
        setVisible(true)
      } else {
        // keep the menu hidden but stay responsive while the user types
        setVisible(false)
        setEntries([])
      }
    }).catch(() => { setVisible(false) })
  }, [input, cursorPos, cwd])

  const applyPick = useCallback((entry: Entry) => {
    if (!tokenInfo) return
    onPick(entry, { start: tokenInfo.start, end: tokenInfo.end })
    setVisible(false)
  }, [tokenInfo, onPick])

  const onKey = useCallback((e: KeyboardEvent) => {
    if (!visible || entries.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault(); e.stopPropagation(); setSelected(i => (i + 1) % entries.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation(); setSelected(i => (i - 1 + entries.length) % entries.length)
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault(); e.stopPropagation(); applyPick(entries[selected < entries.length ? selected : 0])
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); setVisible(false); onClose()
    }
  }, [visible, entries, selected, applyPick, onClose])

  useEffect(() => {
    if (!visible) return
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [visible, onKey])

  if (!visible || entries.length === 0 || !anchorRef.current) return null

  const rect = anchorRef.current.getBoundingClientRect()
  const menuH = Math.min(entries.length * 32 + 8, 320)
  const above = rect.top - menuH - 4
  const top = above > 0 ? above : rect.bottom + 4

  return createPortal(
    <div
      className="fixed z-[9999] bg-card border border-border rounded-lg shadow-lg overflow-y-auto py-1 animate-slide-up"
      style={{ top, left: rect.left, width: Math.min(rect.width, 480), maxHeight: 320 }}
    >
      {entries.map((entry, i) => (
        <button
          key={entry.path}
          className={`w-full text-left px-3 py-1.5 flex items-center gap-2 cursor-pointer transition-colors text-[13px] font-mono ${i === selected ? 'bg-accent-subtle text-text' : 'text-muted hover:bg-bg-hover hover:text-text'}`}
          onMouseEnter={() => setSelected(i)}
          onMouseDown={e => { e.preventDefault(); applyPick(entry) }}
        >
          <span className="shrink-0 w-4 text-center">📄</span>
          <span className="truncate flex-1">{entry.name}</span>
          <span className="text-[11px] text-muted/50 shrink-0 ml-auto">{entry.path.replace(/^\/home\/[^/]+/, '~').replace(/^\/Users\/[^/]+/, '~')}</span>
        </button>
      ))}
      <div className="px-3 py-1 border-t border-border text-[11px] text-muted/40 flex gap-3">
        <span>⏎ pick</span>
        <span>↑↓ navigate</span>
        <span>Esc dismiss</span>
      </div>
    </div>,
    document.body,
  )
}