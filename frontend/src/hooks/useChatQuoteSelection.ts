import { useCallback, useEffect, useState } from 'react'
import { normalizeQuote } from '../utils/reviewComments'

/** Message rows mark themselves with this attribute so quotes can name their source. */
export const MESSAGE_ANCHOR_ATTR = 'data-msg-anchor'
/** Anything rendered by this feature marks itself so its own clicks are not re-quoted. */
export const QUOTE_UI_ATTR = 'data-quote-ui'

export interface SelectionTarget {
  id: string
  /** Whitespace-collapsed, length-capped quote. */
  text: string
  role?: string
  entryId?: string
  /** Viewport geometry of the selection, used to anchor the floating UI. */
  rect: { top: number; bottom: number; left: number; width: number }
}

function closestQuoteUi(node: Node | null): HTMLElement | null {
  const element = node?.nodeType === 1 ? (node as Element) : node?.parentElement ?? null
  return element?.closest(`[${QUOTE_UI_ATTR}]`) as HTMLElement | null ?? null
}

function anchorOf(node: Node | null): HTMLElement | null {
  const element = node?.nodeType === 1 ? (node as Element) : node?.parentElement ?? null
  return (element?.closest(`[${MESSAGE_ANCHOR_ATTR}]`) as HTMLElement | null) ?? null
}

/**
 * Read the current text selection as a quote target. Returns null when nothing
 * usable is selected, when the selection is outside a message row, or when it
 * belongs to this feature's own floating UI.
 */
export function targetFromSelection(): SelectionTarget | null {
  const selection = typeof window !== 'undefined' ? window.getSelection() : null
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  if (closestQuoteUi(selection.anchorNode) || closestQuoteUi(selection.focusNode)) return null
  const text = normalizeQuote(selection.toString())
  if (!text) return null
  const range = selection.getRangeAt(0)
  const anchor = anchorOf(range.startContainer) ?? anchorOf(range.commonAncestorContainer)
  if (!anchor) return null
  let rect = { top: 0, bottom: 0, left: 0, width: 0 }
  try {
    const box = range.getBoundingClientRect()
    rect = { top: box.top, bottom: box.bottom, left: box.left, width: box.width }
  } catch {
    // jsdom (and some embedded webviews) do not implement range geometry.
  }
  return {
    id: crypto.randomUUID(),
    text,
    role: anchor.getAttribute('data-msg-role') ?? undefined,
    entryId: anchor.getAttribute('data-msg-id') ?? undefined,
    rect,
  }
}

/**
 * Watches for a selection inside a chat message and exposes it as a quote
 * target, so a sentence can be quoted or commented on without copy-pasting.
 */
export function useChatQuoteSelection() {
  const [selection, setSelection] = useState<SelectionTarget | null>(null)

  const capture = useCallback(() => {
    const next = targetFromSelection()
    setSelection(previous => {
      // Keep the floating UI alive while the user interacts with it.
      if (!next && previous && closestQuoteUi(document.activeElement)) return previous
      return next
    })
  }, [])

  const clear = useCallback(() => setSelection(null), [])

  useEffect(() => {
    const onSelectionChange = () => {
      const current = window.getSelection()
      if (current && !current.isCollapsed) return
      if (closestQuoteUi(document.activeElement)) return
      setSelection(null)
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelection(null) }
    const onScroll = () => setSelection(null)

    document.addEventListener('mouseup', capture)
    document.addEventListener('touchend', capture)
    document.addEventListener('keyup', capture)
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mouseup', capture)
      document.removeEventListener('touchend', capture)
      document.removeEventListener('keyup', capture)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [capture])

  return { selection, clear }
}