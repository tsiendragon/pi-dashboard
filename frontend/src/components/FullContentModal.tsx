import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import MarkdownRenderer from './MarkdownRenderer'

export interface FullContentModalProps {
  /** Header label of the window, e.g. 「完整内容」. */
  title?: string
  /** Small muted context next to the title, e.g. 「32 行」. */
  meta?: string
  content: string
  /** Keeps transcript file links working inside the window. */
  onFileOpen?: (path: string) => void
  /** Mirrors the transcript's raw toggle, so the window reads like the message it came from. */
  showRaw?: boolean
  /** Role of the message being read, so a sentence quoted from the window names its source. */
  anchorRole?: string
  onClose: () => void
}

/**
 * Reader window for one long transcript block.
 *
 * A long answer keeps a fixed-height preview inside the transcript; reading the
 * rest here means the transcript never grows, so nothing below the reader moves
 * and the answer cannot collapse out from under them mid-read.
 */
export default function FullContentModal({ title = '完整内容', meta, content, onFileOpen, showRaw = true, anchorRole, onClose }: FullContentModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null)

  // Focus moves into the window and back to whatever opened it, so a reader can
  // close with the keyboard without hunting for the trigger again.
  useEffect(() => {
    const previous = document.activeElement
    closeRef.current?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  useEffect(() => {
    // Capture phase: Escape belongs to this window while it is open. The global
    // shortcut listener (and every other Escape handler) sits on the bubble phase
    // on `document`, so stopping the event here keeps reading from also firing
    // 「关闭 / 停止」 at the session behind the window.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  return createPortal(
    // z-[70] sits below the selection quote menu (z-[75]/[76]) so a sentence picked
    // inside this window still gets its actions on top of it.
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/35 p-4" role="presentation" onClick={onClose}>
      <section
        className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={event => event.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-border bg-bg-elevated px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-text-strong">{title}</div>
            {meta && <div className="mt-0.5 text-2xs text-muted">{meta}</div>}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="shrink-0 cursor-pointer rounded border border-border bg-bg px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent"
          >关闭</button>
        </header>
        <div
          className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
          // The window lives outside the transcript, so it carries the message anchor
          // itself: text selected here can still be quoted or commented on.
          data-msg-anchor=""
          {...(anchorRole ? { 'data-msg-role': anchorRole } : {})}
        >
          <MarkdownRenderer content={content} onFileOpen={onFileOpen} showRaw={showRaw} />
        </div>
      </section>
    </div>,
    document.body,
  )
}