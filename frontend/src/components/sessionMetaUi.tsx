import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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

export type RowMenuAction = {
  label: string
  onClick: () => void
  danger?: boolean
  /** Ask for a second click before running. */
  confirmLabel?: string
  hint?: string
  /** Short display text for compact rows; the full label remains accessible. */
  shortLabel?: string
  /** Show the hint at the end of the action row instead of below it. */
  inlineHint?: boolean
}
/** Read-only context block inside the menu, e.g. the tmux session hosting this Pi. */
export type RowMenuInfo = {
  /** Small uppercase caption above the value. */
  label: string
  /** The value itself (mono), e.g. the tmux session name. */
  value: string
  /** Trailing affordance; clicking the value row runs it (and closes the menu). */
  actionLabel?: string
  onAction?: () => void
  /** Whole-block hover text. */
  title?: string
}
export type RowMenuItem =
  | RowMenuAction
  | { actions: RowMenuAction[] }
  | { label: string; submenu: RowMenuAction[]; hint?: string }
  | { info: RowMenuInfo }
  | { separator: true }

export function isSeparator(item: RowMenuItem): item is { separator: true } {
  return (item as { separator?: boolean }).separator === true
}

/**
 * Compact overflow (`⋯`) menu.
 *
 * Rendered in a portal with viewport-fixed coordinates. Anchoring it to the
 * row (the old `absolute` version) clipped it whenever the row sat near the
 * top or bottom edge of the scrollable sidebar. The position is measured from
 * the row at open time, the menu flips up when it does not fit below, and any
 * scroll outside the menu closes it — a floating menu cannot follow its
 * scrolled-away anchor.
 */
export function RowMenu({ items, up = false, ariaLabel = 'Session actions', onClose }: {
  items: RowMenuItem[]
  /** Prefer opening above the row; it still opens below when that side fits better. */
  up?: boolean
  ariaLabel?: string
  onClose: () => void
}) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const ref = useRef<HTMLDivElement>(null)
  const [armed, setArmed] = useState<string | null>(null)
  const [activeSubmenu, setActiveSubmenu] = useState<Extract<RowMenuItem, { submenu: unknown }> | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | undefined>()
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (activeSubmenu) setActiveSubmenu(null)
      else onClose()
    }
    // Deferred so the click that opened the menu does not close it immediately.
    const id = setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    document.addEventListener('keydown', onKey)
    return () => { clearTimeout(id); document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [activeSubmenu, onClose])

  useLayoutEffect(() => {
    const row = anchorRef.current?.parentElement
    const menu = ref.current
    if (!row || !menu) return
    const rect = row.getBoundingClientRect()
    const box = menu.getBoundingClientRect()
    const margin = 8
    const gap = 4
    const width = box.width || 208
    const height = box.height || 0
    // Right-align the menu to the row, then clamp both edges into the viewport.
    const left = Math.min(Math.max(margin, rect.right - gap - width), Math.max(margin, window.innerWidth - margin - width))
    const spaceBelow = window.innerHeight - rect.bottom - gap - margin
    const spaceAbove = rect.top - gap - margin
    const fitsBelow = spaceBelow >= height
    const fitsAbove = spaceAbove >= height
    const flipUp = (up && fitsAbove) || (!fitsBelow && spaceAbove > spaceBelow)
    const rawTop = flipUp ? rect.top - gap - height : rect.bottom + gap
    const top = Math.min(Math.max(margin, rawTop), Math.max(margin, window.innerHeight - margin - height))
    setPos(previous => (previous && previous.left === left && previous.top === top ? previous : { left, top }))
  }, [activeSubmenu, up])

  useEffect(() => {
    const onViewportChange = (event: Event) => {
      if (ref.current && event.target instanceof Node && ref.current.contains(event.target)) return
      onClose()
    }
    window.addEventListener('scroll', onViewportChange, true)
    window.addEventListener('resize', onViewportChange)
    return () => {
      window.removeEventListener('scroll', onViewportChange, true)
      window.removeEventListener('resize', onViewportChange)
    }
  }, [onClose])

  const renderMenuAction = (item: RowMenuAction, key: string, compact = false) => {
    const armedHere = armed === item.label
    const title = [item.label, item.hint].filter(Boolean).join(' · ')
    return (
      <div key={key} className={compact ? 'min-w-0 flex-1' : undefined}>
        <button
          type="button"
          role="menuitem"
          aria-label={armedHere ? item.confirmLabel : item.label}
          title={title}
          className={`flex w-full min-w-0 items-center gap-2 rounded-lg transition-colors hover:bg-bg-hover ${compact ? 'justify-center px-1.5 py-1.5 text-xs' : 'px-2.5 py-1 text-left text-meta leading-5'} ${armedHere ? 'bg-danger-subtle font-semibold text-danger' : item.danger ? 'text-danger' : 'text-text'}`}
          onClick={() => {
            if (item.confirmLabel && !armedHere) { setArmed(item.label); return }
            setArmed(null)
            onClose()
            item.onClick()
          }}
        >
          <span className={`${compact ? 'truncate text-center' : 'min-w-0 flex-1 truncate'}`}>
            {armedHere ? item.confirmLabel : item.shortLabel || item.label}
          </span>
          {!compact && item.inlineHint && item.hint && (
            <span className="max-w-[48%] shrink truncate font-mono text-2xs text-muted-strong">{item.hint}</span>
          )}
        </button>
        {!compact && item.hint && !item.inlineHint && <MenuHint text={item.hint} title={item.hint} />}
      </div>
    )
  }

  return (
    <>
      {/* In-flow anchor: the menu itself lives in `document.body`, so this
          zero-size placeholder keeps a handle on the row wrapper to measure. */}
      <span ref={anchorRef} aria-hidden="true" className="pointer-events-none absolute right-1 h-px w-px" />
      {createPortal((
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      className="fixed z-40 max-h-[calc(100vh-16px)] w-[208px] overflow-y-auto rounded-xl border border-border-strong bg-bg-elevated p-1.5 shadow-xl"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {activeSubmenu ? (
        <>
          <button
            type="button"
            role="menuitem"
            className="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-meta font-semibold text-muted-strong transition-colors hover:bg-bg-hover hover:text-text-strong"
            onClick={() => { setArmed(null); setActiveSubmenu(null) }}
          >
            <span aria-hidden="true" className="text-base leading-none">‹</span>
            <span className="min-w-0 flex-1 truncate">{activeSubmenu.label}</span>
          </button>
          <div className="mb-1 h-px bg-border" />
          {activeSubmenu.submenu.map((item, i) => renderMenuAction(item, `submenu-${i}`))}
        </>
      ) : items.map((item, i) => {
        if (isSeparator(item)) return <div key={`sep-${i}`} className="my-1.5 h-px bg-border" />
        if ('info' in item) {
          const info = item.info
          const body = (
            <>
              <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3 w-3 shrink-0"><path d="M4 17l6-5-6-5M12 19h8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <span className="min-w-0 flex-1 truncate font-mono text-2xs text-text-strong">{info.value}</span>
              {info.actionLabel && <span className="shrink-0 text-2xs text-accent">{info.actionLabel}</span>}
            </>
          )
          return (
            <div key={`info-${i}`} className="px-1 pb-1 pt-0.5" title={info.title}>
              <div className="px-1 pb-0.5 text-2xs uppercase tracking-[.05em] text-muted">{info.label}</div>
              {info.onAction ? (
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full min-w-0 items-center gap-1.5 rounded-lg px-1 py-1 text-left transition-colors hover:bg-bg-hover"
                  onClick={() => { onClose(); info.onAction?.() }}
                >{body}</button>
              ) : (
                <div className="flex w-full min-w-0 items-center gap-1.5 px-1 py-1">{body}</div>
              )}
            </div>
          )
        }
        if ('actions' in item) {
          return (
            <div key={`actions-${i}`} className="flex items-center gap-1 px-0.5">
              {item.actions.map((action, actionIndex) => renderMenuAction(action, `action-${i}-${actionIndex}`, true))}
            </div>
          )
        }
        if ('submenu' in item) {
          return (
            <div key={`submenu-${i}`}>
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded="false"
                title={item.hint}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-meta text-text transition-colors hover:bg-bg-hover"
                onClick={() => { setArmed(null); setActiveSubmenu(item) }}
              >
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                <span aria-hidden="true" className="text-base leading-none text-muted-strong">›</span>
              </button>
            </div>
          )
        }
        return renderMenuAction(item, `main-${i}`)
      })}
    </div>
      ), document.body)}
    </>
  )
}

/** Muted single-line hint row (e.g. a cwd) to place under a menu. */
export function MenuHint({ text, title }: { text: string; title?: string }) {
  return <div className="truncate px-2 pb-1 pt-0.5 font-mono text-2xs text-muted-strong" title={title || text}>{text}</div>
}
