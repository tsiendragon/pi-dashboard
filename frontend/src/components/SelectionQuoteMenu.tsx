import { memo, useEffect, useRef, useState } from 'react'
import { QUOTE_UI_ATTR, type SelectionTarget } from '../hooks/useChatQuoteSelection'
import { selectionLabel } from '../utils/reviewComments'

/** Anchor the floating card near the selection, flipping below when there is no room above. */
function menuStyle(target: SelectionTarget, estimatedHeight: number): React.CSSProperties {
  const { top, bottom, left, width } = target.rect
  const center = left + width / 2
  const clampedLeft = Math.max(120, Math.min(center, window.innerWidth - 120))
  if (top < estimatedHeight + 16) {
    return { position: 'fixed', left: clampedLeft, top: bottom + 8, transform: 'translateX(-50%)' }
  }
  return { position: 'fixed', left: clampedLeft, top: top - 8, transform: 'translate(-50%, -100%)' }
}

interface SelectionQuoteMenuProps {
  target: SelectionTarget
  /** A: keep the quote as a chip above the composer. */
  onQuote: (target: SelectionTarget) => void
  /** B: open a comment box for this quote. */
  onComment: (target: SelectionTarget) => void
}

/** Floating actions that appear next to a selection inside a message. */
export const SelectionQuoteMenu = memo(function SelectionQuoteMenu({ target, onQuote, onComment }: SelectionQuoteMenuProps) {
  return (
    <div
      {...{ [QUOTE_UI_ATTR]: '' }}
      role="menu"
      aria-label="引用选中内容"
      style={menuStyle(target, 40)}
      // Keeping focus off the buttons preserves the document selection.
      onMouseDown={event => event.preventDefault()}
      className="z-[75] flex items-center gap-1 rounded-full border border-border bg-bg-elevated px-1 py-1 shadow-lg"
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => onQuote(target)}
        className="cursor-pointer rounded-full border-none bg-transparent px-2.5 py-1 text-2xs text-text hover:bg-bg-hover"
      >💬 引用回复</button>
      <button
        type="button"
        role="menuitem"
        onClick={() => onComment(target)}
        className="cursor-pointer rounded-full border-none bg-transparent px-2.5 py-1 text-2xs text-text hover:bg-bg-hover"
      >📝 批注</button>
    </div>
  )
})

interface QuoteCommentPopoverProps {
  target: SelectionTarget
  onSave: (content: string) => void
  onCancel: () => void
}

/** Comment box for one quoted sentence (the conversation comment box). */
export const QuoteCommentPopover = memo(function QuoteCommentPopover({ target, onSave, onCancel }: QuoteCommentPopoverProps) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { ref.current?.focus() }, [])

  const save = () => { if (value.trim()) onSave(value.trim()) }

  return (
    <div
      {...{ [QUOTE_UI_ATTR]: '' }}
      role="dialog"
      aria-label="批注选中的内容"
      style={menuStyle(target, 150)}
      className="z-[76] w-[min(360px,calc(100vw-24px))] rounded-lg border border-border bg-bg-elevated p-2 shadow-xl"
    >
      <div className="mb-1 text-2xs text-muted">
        {selectionLabel(target.role)} · 引用
        <div className="mt-0.5 max-h-16 overflow-auto break-words text-2xs text-text" title={target.text}>“{target.text}”</div>
      </div>
      <textarea
        ref={ref}
        rows={2}
        aria-label="批注内容"
        placeholder="这条引用的意见…"
        className="w-full resize-none rounded border border-border bg-bg px-2 py-1 text-meta text-text outline-none focus:border-accent"
        value={value}
        onChange={event => setValue(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); save() }
          if (event.key === 'Escape') { event.stopPropagation(); onCancel() }
        }}
      />
      <div className="mt-1 flex gap-1">
        <button type="button" className="cursor-pointer rounded border border-accent px-2 py-0.5 text-2xs text-accent disabled:opacity-40" disabled={!value.trim()} onClick={save}>添加批注</button>
        <button type="button" className="cursor-pointer rounded border border-border px-2 py-0.5 text-2xs text-muted" onClick={onCancel}>取消</button>
      </div>
    </div>
  )
})