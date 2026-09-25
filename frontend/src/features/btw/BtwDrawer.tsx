import { useEffect, useMemo, useState } from 'react'
import { useIntegration } from '../useIntegration'

type Snapshot = {
  revision: number
  status: 'closed' | 'starting' | 'ready' | 'busy' | 'error'
  model?: string
  activity?: string
  conversation: Array<{ role: 'user' | 'assistant' | 'notice'; text: string }>
  error?: string
}

export default function BtwDrawer({ slot, onClose, onCopy }: { slot: string; onClose: () => void; onCopy: (text: string) => void }) {
  const { attached, snapshot, pending, error, send } = useIntegration<Snapshot>(slot, 'btw')
  const [input, setInput] = useState('')

  useEffect(() => {
    if (attached && (!snapshot || snapshot.status === 'closed')) void send({ type: 'open' }).catch(() => {})
  }, [attached, snapshot?.status, send])

  const lastAnswer = useMemo(() => [...(snapshot?.conversation ?? [])].reverse().find(item => item.role === 'assistant' && item.text.trim())?.text.trim(), [snapshot?.conversation])
  const close = () => { void send({ type: 'close' }).catch(() => {}); onClose() }
  const submit = () => {
    const text = input.trim()
    if (!text || snapshot?.status === 'busy') return
    setInput('')
    void send({ type: 'submit', text }).catch(() => {})
  }

  return <div className="fixed inset-y-0 right-0 z-50 w-full md:w-[min(680px,70vw)] bg-bg border-l border-border shadow-2xl flex flex-col">
    <header className="flex items-center gap-3 px-4 py-3 border-b border-border bg-chrome">
      <strong>BTW</strong>
      <span className="text-xs text-muted">read-only side chat{snapshot?.model ? ` · ${snapshot.model}` : ''}</span>
      {(pending > 0 || snapshot?.status === 'starting') && <span className="w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />}
      <button className="ml-auto text-xs text-muted hover:text-text" disabled={!lastAnswer} onClick={() => lastAnswer && onCopy(lastAnswer)}>Copy to draft</button>
      <button className="text-muted hover:text-text" onClick={close}>✕</button>
    </header>

    {!attached ? <div className="m-auto text-center p-6"><div className="text-text">BTW integration is starting or unavailable.</div><div className="text-sm text-muted mt-1">The active Pi slot must load pi-tsien-extension.</div></div> :
    <div className="flex-1 overflow-y-auto p-4 space-y-3">
      {(snapshot?.conversation ?? []).map((item, index) => item.role === 'notice'
        ? <div key={index} className="text-xs text-muted text-center">{item.text}</div>
        : <div key={index} className={`max-w-[90%] rounded-lg border px-3 py-2 whitespace-pre-wrap text-sm ${item.role === 'user' ? 'ml-auto bg-accent-subtle border-accent' : 'bg-card border-border'}`}>{item.text || (snapshot?.status === 'busy' && index === (snapshot?.conversation.length ?? 0) - 1 ? '…' : '')}</div>)}
    </div>}

    {snapshot?.activity && <div className="px-4 py-2 text-xs text-muted border-t border-border">{snapshot.activity}</div>}
    {(error || snapshot?.error) && <div className="px-4 py-2 text-xs text-danger border-t border-danger">{error || snapshot?.error}</div>}
    <footer className="border-t border-border p-3">
      <div className="flex gap-2">
        <textarea className="flex-1 min-h-12 max-h-32 bg-bg-elevated border border-border rounded-lg px-3 py-2 text-sm" placeholder="Ask without interrupting the main agent" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }} />
        {snapshot?.status === 'busy' ? <button className="px-3 rounded-lg border border-danger text-danger" onClick={() => void send({ type: 'abort' })}>Stop</button> : <button className="px-4 rounded-lg bg-accent text-accent-fg disabled:opacity-40" disabled={!input.trim() || !attached} onClick={submit}>Send</button>}
      </div>
      <div className="flex gap-3 mt-2 text-xs"><button className="text-muted hover:text-text" disabled={snapshot?.status === 'busy'} onClick={() => void send({ type: 'refresh-parent' })}>Refresh parent context</button><span className="text-muted ml-auto">read · grep · find · ls · session_history</span></div>
    </footer>
  </div>
}
