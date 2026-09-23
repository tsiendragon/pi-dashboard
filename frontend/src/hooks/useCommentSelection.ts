import { useCallback, useEffect, useState } from 'react'
import { normalizeQuote, resolveSelectionToLines } from '../utils/reviewComments'

export interface CommentTarget {
  start: number
  end: number
  quote?: string
}

export interface CommentContextMenu {
  x: number
  y: number
  target: CommentTarget
}

/**
 * Selection → comment target plumbing shared by the side panel and the
 * full-screen preview: right-click on a selection opens a menu whose target is
 * the source line range plus the quoted sentence. Callers own the pending
 * comment input state; the hook only resolves what the user selected.
 */
export function useCommentSelection(content: string) {
  const [contextMenu, setContextMenu] = useState<CommentContextMenu | null>(null)

  /** Absolute-positioned menu must not overflow the viewport. */
  const clampedMenuStyle = contextMenu
    ? { top: Math.min(contextMenu.y, window.innerHeight - 60), left: Math.min(contextMenu.x, window.innerWidth - 180) }
    : undefined

  /** Resolve a rendered selection text (HTML preview iframe bridge) to a target. */
  const targetFromText = useCallback((text: string): CommentTarget => {
    const { startLine, endLine } = resolveSelectionToLines(content, text)
    return { start: startLine, end: endLine, quote: normalizeQuote(text) }
  }, [content])

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return // no selection → default browser menu
    event.preventDefault()
    const textarea = (event.currentTarget as HTMLElement).querySelector('textarea')
    if (textarea && textarea.selectionStart !== textarea.selectionEnd) {
      // Edit mode: exact lines from the textarea selection
      const start = content.slice(0, textarea.selectionStart).split('\n').length
      const end = content.slice(0, textarea.selectionEnd).split('\n').length
      setContextMenu({ x: event.clientX, y: event.clientY, target: { start, end, quote: normalizeQuote(selection.toString()) } })
      return
    }
    setContextMenu({ x: event.clientX, y: event.clientY, target: targetFromText(selection.toString()) })
  }, [content, targetFromText])

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  useEffect(() => {
    if (!contextMenu) return
    const onClick = () => closeContextMenu()
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') closeContextMenu() }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [contextMenu, closeContextMenu])

  return { contextMenu, clampedMenuStyle, targetFromText, handleContextMenu, closeContextMenu }
}