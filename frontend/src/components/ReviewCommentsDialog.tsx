import { useEffect, useMemo, useState } from 'react'
import type { Comment } from '../hooks/usePanelState'
import { buildReviewMessage, formatLineRef } from '../utils/reviewComments'

export interface ReviewCommentsDialogProps {
  filePath: string
  comments: Comment[]
  onCancel: () => void
  /** `sentIds` lets the caller clear exactly the comments that left the dashboard. */
  onSend: (message: string, sentIds: string[]) => void
}

/**
 * Last stop before comments reach the agent: shows every pending comment with
 * its line reference and quoted sentence, lets you drop individual ones, and
 * lets you edit the exact message that will be sent.
 */
export default function ReviewCommentsDialog({ filePath, comments, onCancel, onSend }: ReviewCommentsDialogProps) {
  const [pending, setPending] = useState<Comment[]>(comments)
  const [message, setMessage] = useState(() => buildReviewMessage(filePath, comments))
  const [edited, setEdited] = useState(false)

  const canSend = pending.length > 0 && message.trim().length > 0

  const removeComment = (id: string) => {
    const next = pending.filter(c => c.id !== id)
    setPending(next)
    // Keep manual edits; only regenerate the draft while it is untouched.
    if (!edited) setMessage(buildReviewMessage(filePath, next))
  }

  useEffect(() => {
    // Capture phase + stopPropagation: the document panel/modal below also closes
    // on Escape (and would prompt to discard unsaved edits), so it must not see it.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      onCancel()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onCancel])

  const submit = () => {
    if (!canSend) return
    onSend(message.trim(), pending.map(c => c.id))
  }

  const count = useMemo(() => `${pending.length} comment${pending.length === 1 ? '' : 's'}`, [pending.length])

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-3 md:p-8" role="dialog" aria-modal="true" aria-label="Review comments">
      <button type="button" aria-label="Close review dialog" className="absolute inset-0 border-none bg-black/60 cursor-default" onClick={onCancel} />
      <section className="relative z-10 flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-bg shadow-2xl">
        <header className="flex min-w-0 items-center gap-2 border-b border-border bg-chrome px-3 py-2">
          <span className="shrink-0 text-sm">💬</span>
          <span className="text-body-s font-semibold text-text">Send {count} to the agent</span>
          <span className="min-w-0 flex-1 truncate text-2xs font-mono text-muted" title={filePath}>{filePath}</span>
          <button type="button" aria-label="Cancel review" className="shrink-0 rounded border border-border px-2 py-1 text-meta text-muted cursor-pointer hover:border-danger hover:text-danger" onClick={onCancel}>✕</button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {pending.map(comment => (
              <li key={comment.id} data-review-comment-id={comment.id} className="rounded border border-border bg-bg-elevated px-2 py-1">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <span className="mr-1.5 font-mono text-2xs text-cyan-400">{formatLineRef(comment)}</span>
                    <span className="text-body-s text-text">{comment.content}</span>
                    {comment.quote && <div className="mt-0.5 truncate text-2xs text-muted" title={comment.quote}>“{comment.quote}”</div>}
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove comment on ${formatLineRef(comment)}`}
                    className="shrink-0 cursor-pointer text-2xs text-muted hover:text-danger"
                    onClick={() => removeComment(comment.id)}
                  >✕</button>
                </div>
              </li>
            ))}
          </ul>
          {pending.length === 0 && <div className="py-2 text-sm text-muted">No comments left — cancel to close.</div>}
          <label className="mt-2 block text-2xs font-semibold uppercase tracking-wide text-muted" htmlFor="review-message">Message</label>
          <textarea
            id="review-message"
            aria-label="Review message"
            className="mt-1 h-48 w-full resize-none rounded border border-border bg-bg px-2 py-1 font-mono text-2xs leading-relaxed text-text outline-none focus:border-accent"
            value={message}
            onChange={event => { setMessage(event.target.value); setEdited(true) }}
            onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); submit() } }}
          />
        </div>

        <footer className="flex items-center gap-2 border-t border-border bg-chrome px-3 py-2 text-2xs text-muted">
          <span>Sent comments are cleared from the dashboard after sending.</span>
          <div className="ml-auto flex gap-1">
            <button type="button" className="cursor-pointer rounded border border-border px-3 py-1 text-meta text-muted hover:border-accent hover:text-accent" onClick={onCancel}>Cancel</button>
            <button type="button" className="cursor-pointer rounded border border-accent px-3 py-1 text-meta text-accent hover:bg-accent-subtle disabled:cursor-default disabled:opacity-40" disabled={!canSend} onClick={submit}>Send</button>
          </div>
        </footer>
      </section>
    </div>
  )
}