import { useState } from 'react'
import type { LiveSessionStatus } from '@shared/live-sessions'

interface LiveSessionComposerProps {
  status: LiveSessionStatus
  disabled?: boolean
  onSubmit: (text: string, deliverAs?: 'steer' | 'followUp') => Promise<void>
}

export default function LiveSessionComposer({ status, disabled, onSubmit }: LiveSessionComposerProps) {
  const [text, setText] = useState('')
  const [deliverAs, setDeliverAs] = useState<'steer' | 'followUp'>('followUp')
  const [sending, setSending] = useState(false)

  const submit = async (): Promise<void> => {
    const value = text.trim()
    if (!value || sending || disabled) return
    setSending(true)
    try {
      await onSubmit(value, status === 'running' ? deliverAs : undefined)
      setText('')
    } catch {
      // The page keeps the detailed error; preserve the draft for retry.
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="border-t border-border bg-card p-2">
      <div className="flex gap-2 items-end">
        <textarea
          value={text}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
          }}
          disabled={disabled}
          maxLength={128 * 1024}
          rows={1}
          placeholder="发送到运行中的 Pi…"
          className="min-h-9 flex-1 resize-none rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm text-text outline-none focus:border-accent disabled:opacity-50"
        />
        {status === 'running' && (
          <select value={deliverAs} onChange={event => setDeliverAs(event.target.value as 'steer' | 'followUp')} className="h-8 rounded-md border border-border bg-bg px-2 text-[11px] text-text">
            <option value="followUp">Follow-up</option>
            <option value="steer">Steer</option>
          </select>
        )}
        <button type="button" onClick={() => void submit()} disabled={!text.trim() || sending || disabled} className="h-8 px-3 rounded-md bg-accent text-white border-none text-xs disabled:opacity-50">
          {sending ? '发送中…' : '发送'}
        </button>
      </div>
    </div>
  )
}
