import { useEffect, useMemo, useRef, useState } from 'react'
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
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (attached && (!snapshot || snapshot.status === 'closed')) void send({ type: 'open' }).catch(() => {})
  }, [attached, snapshot?.status, send])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 3000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const conversation = snapshot?.conversation ?? []
  const lastAnswer = useMemo(() => [...conversation].reverse().find(item => item.role === 'assistant' && item.text.trim())?.text.trim(), [conversation])
  const close = () => { void send({ type: 'close' }).catch(() => {}); onClose() }
  const submit = () => {
    const text = input.trim()
    if (!text || snapshot?.status === 'busy') return
    setInput('')
    void send({ type: 'submit', text }).catch(() => {})
  }
  const copyAnswer = async () => {
    if (!lastAnswer) return
    try {
      await navigator.clipboard.writeText(lastAnswer)
      setNotice('已复制这个回答的原文')
    } catch {
      setNotice('浏览器拒绝了复制，请手动选中文本复制')
    }
  }

  /* Follow the newest exchange so a long answer never lands below the fold. */
  const transcript = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const node = transcript.current
    if (node) node.scrollTop = node.scrollHeight
  }, [conversation.length, snapshot?.activity])

  const busy = snapshot?.status === 'busy'
  return <div className="fixed inset-y-0 right-0 z-50 w-full md:w-[min(680px,70vw)] bg-bg border-l border-border shadow-2xl flex flex-col">
    <header className="flex items-center gap-3 px-4 py-3 border-b border-border bg-chrome">
      <strong>BTW</strong>
      <span className="text-xs text-muted">只读侧聊{snapshot?.model ? ` · ${snapshot.model}` : ''}</span>
      {(pending > 0 || snapshot?.status === 'starting') && <span className="w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />}
      <button className="ml-auto text-xs text-muted hover:text-text disabled:opacity-40" disabled={!lastAnswer} onClick={() => lastAnswer && onCopy(lastAnswer)} title="把最后一个回答放进主输入框（不发送）">送进输入框</button>
      <button className="text-muted hover:text-text" onClick={close} aria-label="关闭 BTW">✕</button>
    </header>

    {!attached ? <div className="m-auto text-center p-6"><div className="text-text">BTW 正在连接或不可用。</div><div className="text-sm text-muted mt-1">当前 Pi 会话需要加载 pi-tsien-extension。</div></div> :
    <div ref={transcript} className="flex-1 overflow-y-auto p-4 space-y-3" aria-label="BTW 对话记录">
      {conversation.length === 0 && <div className="text-center text-sm text-muted">
        {snapshot?.status === 'starting' ? '正在启动只读侧聊…' : '直接提问即可：它只读、不影响主会话，每次提问前会自动同步主上下文。'}
      </div>}
      {conversation.map((item, index) => item.role === 'notice'
        ? <div key={index} className="text-xs text-muted text-center">{item.text}</div>
        : <div key={index} className={`max-w-[90%] rounded-lg border px-3 py-2 whitespace-pre-wrap text-sm ${item.role === 'user' ? 'ml-auto bg-accent-subtle border-accent' : 'bg-card border-border'}`}>{item.text || (busy && index === conversation.length - 1 ? '正在生成…' : '')}</div>)}
    </div>}

    {snapshot?.activity && <div className="px-4 py-2 text-xs text-muted border-t border-border">{snapshot.activity}</div>}
    {(error || snapshot?.error) && <div className="px-4 py-2 text-xs text-danger border-t border-danger" role="alert">{error || snapshot?.error}</div>}
    <footer className="border-t border-border p-3">
      <div className="flex gap-2">
        <textarea className="flex-1 min-h-12 max-h-32 bg-bg-elevated border border-border rounded-lg px-3 py-2 text-sm" placeholder={busy ? 'BTW 正在回答；可先「中止」' : '问 BTW 一个问题（Enter 发送，Shift+Enter 换行）'} aria-label="BTW 提问" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }} />
        {busy ? <button className="px-3 rounded-lg border border-danger text-danger" onClick={() => void send({ type: 'abort' })}>中止</button> : <button className="px-4 rounded-lg bg-accent text-accent-fg disabled:opacity-40" disabled={!input.trim() || !attached} onClick={submit}>发送</button>}
      </div>
      <div className="flex gap-3 mt-2 text-xs">
        <button className="text-muted hover:text-text" disabled={busy} onClick={() => void send({ type: 'refresh-parent' })} title="立刻重新同步主会话上下文（每次提问前也会自动同步）">同步主上下文</button>
        <button className="text-muted hover:text-text disabled:opacity-40" disabled={!lastAnswer} onClick={() => void copyAnswer()}>复制回答</button>
        {notice && <span className="text-muted" role="status">{notice}</span>}
        <span className="text-muted ml-auto">read · grep · find · ls · session_history</span>
      </div>
    </footer>
  </div>
}