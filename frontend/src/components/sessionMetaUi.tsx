import { useEffect, useRef, useState } from 'react'
import { tagColorClass, visibleTags } from '../pages/chat/sessionMeta'

/**
 * Shared row chrome for session lists — used by both the chat-slot sidebar
 * (`pages/ChatSidebar.tsx`) and the live-Pi sidebar
 * (`features/live-sessions/LiveSessionsList.tsx`), so tags, the overflow menu
 * and the two-step destructive confirm behave identically in both places.
 */

export function TagChip({ tag, active, onClick, title }: {
  tag: string
  active?: boolean
  /** Omit to render a non-interactive chip. */
  onClick?: (tag: string) => void
  title?: string
}) {
  const cls = `shrink-0 max-w-[78px] truncate rounded-full border px-1.5 py-px text-2xs font-semibold leading-[14px] ${tagColorClass(tag)} ${active ? 'ring-1 ring-accent opacity-100' : 'opacity-90'}`
  if (!onClick) return <span className={cls} title={title || `#${tag}`}>{tag}</span>
  return (
    <button
      type="button"
      title={title || `#${tag}`}
      onClick={e => { e.stopPropagation(); e.preventDefault(); onClick(tag) }}
      onMouseDown={e => e.stopPropagation()}
      className={`${cls} hover:opacity-100`}
    >{tag}</button>
  )
}

/** Inline tag editor with completion over already-used tags. */
export function TagEditor({ tags: rawTags, allTags, onTags, onClose }: {
  tags: string[] | undefined
  allTags: string[]
  onTags: (tags: string[]) => void
  onClose: () => void
}) {
  const tags = visibleTags(rawTags)
  const [draft, setDraft] = useState('')
  const [pick, setPick] = useState(0)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { const id = setTimeout(() => ref.current?.focus(), 30); return () => clearTimeout(id) }, [])

  const typed = draft.trim().toLowerCase()
  const matches = allTags.filter(t => !tags.includes(t) && (typed ? t.startsWith(typed) : true)).slice(0, 4)

  const commit = (value: string) => {
    const t = value.trim().toLowerCase()
    setDraft('')
    if (!t || tags.includes(t)) return
    onTags([...tags, t])
  }

  return (
    <div className="mx-1 mb-1.5 rounded-md border border-accent bg-bg p-1.5" onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-1">
        {tags.map(t => (
          <span key={t} className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-2xs font-semibold ${tagColorClass(t)}`}>
            {t}
            <button type="button" aria-label={`remove tag ${t}`} className="opacity-60 hover:text-danger hover:opacity-100" onMouseDown={e => { e.preventDefault(); onTags(tags.filter(x => x !== t)) }}>×</button>
          </span>
        ))}
        <input
          ref={ref}
          value={draft}
          aria-label="Add tag"
          placeholder="add tag…"
          onChange={e => { setDraft(e.target.value); setPick(0) }}
          onBlur={onClose}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commit(!typed && matches[0] ? matches[0] : draft) }
            else if (e.key === 'Escape') { e.preventDefault(); onClose() }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setPick(i => Math.min(i + 1, Math.max(0, matches.length - 1))) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setPick(i => Math.max(0, i - 1)) }
            else if (e.key === 'Backspace' && !draft && tags.length) { onTags(tags.slice(0, -1)) }
          }}
          className="min-w-[80px] flex-1 bg-transparent px-1 text-2xs text-text outline-none placeholder:text-muted-strong"
        />
      </div>
      {matches.length > 0 && (
        <div className="mt-1 overflow-hidden rounded border border-border-strong bg-bg-elevated">
          {matches.map((t, i) => (
            <button
              key={t}
              type="button"
              className={`flex w-full items-center gap-2 px-2 py-1 text-left text-2xs ${i === pick ? 'bg-bg-hover text-text-strong' : 'text-muted hover:bg-bg-hover'}`}
              onMouseEnter={() => setPick(i)}
              // mousedown + preventDefault: the input's onBlur closes this editor,
              // which would swallow a plain click on the suggestion.
              onMouseDown={e => { e.preventDefault(); commit(t) }}
              onClick={e => e.stopPropagation()}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${tagColorClass(t).split(' ')[1]}`} />{t}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export type RowMenuItem =
  | { label: string; onClick: () => void; danger?: boolean; /** Ask for a second click before running. */ confirmLabel?: string; hint?: string }
  | { separator: true }

export function isSeparator(item: RowMenuItem): item is { separator: true } {
  return (item as { separator?: boolean }).separator === true
}

/** Compact overflow (`⋯`) menu. Anchored to the nearest positioned ancestor. */
export function RowMenu({ items, up = false, ariaLabel = 'Session actions', onClose }: {
  items: RowMenuItem[]
  up?: boolean
  ariaLabel?: string
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [armed, setArmed] = useState<string | null>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    // Deferred so the click that opened the menu does not close it immediately.
    const id = setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    document.addEventListener('keydown', onKey)
    return () => { clearTimeout(id); document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      className={`absolute right-1 z-30 w-[184px] rounded-lg border border-border-strong bg-bg-elevated p-1 shadow-lg ${up ? 'bottom-full mb-1' : 'top-full mt-1'}`}
    >
      {items.map((item, i) => {
        if (isSeparator(item)) return <div key={`sep-${i}`} className="my-1 h-px bg-border" />
        const armedHere = armed === item.label
        return (
          <div key={item.label}>
            <button
              type="button"
              role="menuitem"
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-meta hover:bg-bg-hover ${armedHere ? 'bg-danger-subtle font-semibold text-danger' : item.danger ? 'text-danger' : 'text-text'}`}
              onClick={() => {
                if (item.confirmLabel && !armedHere) { setArmed(item.label); return }
                setArmed(null)
                onClose()
                item.onClick()
              }}
            >{armedHere ? item.confirmLabel : item.label}</button>
            {item.hint && <MenuHint text={item.hint} title={item.hint} />}
          </div>
        )
      })}
    </div>
  )
}

/** Muted single-line hint row (e.g. a cwd) to place under a menu. */
export function MenuHint({ text, title }: { text: string; title?: string }) {
  return <div className="truncate px-2 pb-1 pt-0.5 font-mono text-2xs text-muted-strong" title={title || text}>{text}</div>
}
