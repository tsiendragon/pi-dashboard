/**
 * Offline transcript renderer for the Android app.
 *
 * It reuses the real WebUI renderer (react-markdown + remark-gfm + rehype-raw +
 * DOMPurify + highlight.js + mermaid + DiffBlock) and the real design tokens, so
 * code blocks, tables, lists, diffs and diagrams look the same as the web UI
 * instead of being re-implemented in Kotlin.
 *
 * Deliberate constraints:
 * - no network access, no cookies, no credentials: the APK bundles this page and
 *   the native app passes already-projected timeline items in;
 * - `onFileOpen` is a no-op so a tapped path never reaches `api.revealPath`;
 * - raw/HTML output is still rendered through DOMPurify exactly as the web UI does.
 */
import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import MarkdownRenderer from '../src/components/MarkdownRenderer'
import darkTheme from '../src/themes/dark.css?raw'
import lightTheme from '../src/themes/light.css?raw'
import '../src/index.css'
import './renderer.css'

type Role = 'user' | 'assistant' | 'tool' | 'system' | 'toolResult'

interface Item {
  id: string
  role: Role | string
  text: string
  thinking?: string | null
  toolName?: string | null
  isError?: boolean
  status?: string
  images?: { mimeType: string; data: string }[]
}

interface Payload {
  theme?: 'dark' | 'light'
  items?: Item[]
  emptyText?: string
}

const isTool = (item: Item) => item.role === 'tool' || item.role === 'toolResult' || !!item.toolName

function Card({ item }: { item: Item }) {
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const tool = isTool(item)
  // Card chrome mirrors the web UI: user on accent, tool on elevated, errors on danger.
  const shell = item.isError
    ? 'border-danger/40 bg-danger-subtle/30'
    : item.role === 'user'
      ? 'border-accent/30 bg-accent-subtle/25'
      : tool
        ? 'border-border bg-bg-elevated'
        : 'border-border bg-card'
  return (
    <article className={`min-w-0 rounded-md border px-3 py-2.5 ${shell}`}>
      <header className="mb-1 flex min-w-0 items-center gap-2 text-2xs text-muted">
        <span className={item.isError ? 'font-semibold text-danger' : 'font-semibold'}>
          {item.role === 'user' ? '你' : tool ? item.toolName || '工具' : item.role === 'assistant' ? 'Pi' : item.role}
        </span>
        {item.status === 'running' && <span className="text-accent">执行中</span>}
        {item.status === 'error' && <span className="text-danger">失败</span>}
        {item.thinking ? (
          <button
            type="button"
            className="ml-auto shrink-0 cursor-pointer border-0 bg-transparent p-0 text-2xs text-accent"
            aria-expanded={thinkingOpen}
            onClick={() => setThinkingOpen(value => !value)}
          >{thinkingOpen ? '收起思考' : '查看思考'}</button>
        ) : null}
      </header>
      {item.images && item.images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {item.images.map((image, index) => (
            <img
              key={`${item.id}-img-${index}`}
              src={`data:${image.mimeType};base64,${image.data}`}
              alt={`附件 ${index + 1}`}
              className="h-28 w-36 rounded border border-border bg-bg-elevated object-contain"
            />
          ))}
        </div>
      )}
      {item.thinking && thinkingOpen && (
        <pre className="mb-2 whitespace-pre-wrap break-words border-l border-border pl-2 text-2xs leading-5 text-muted">{item.thinking}</pre>
      )}
      <div className={tool ? 'min-w-0 text-body-s' : 'min-w-0 text-body-m'}>
        {item.text.trim()
          ? <MarkdownRenderer content={item.text} showRaw={false} streaming={item.status === 'running'} onFileOpen={() => {}} />
          : <p className="text-2xs text-muted">{item.status === 'running' ? '等待内容…' : '（空内容）'}</p>}
      </div>
    </article>
  )
}

function App() {
  const [payload, setPayload] = useState<Payload>({})
  const nearBottom = useRef(true)
  const root = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const scroller = document.scrollingElement || document.documentElement
    const onScroll = () => {
      const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
      nearBottom.current = remaining < 140
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    const bridge = {
      render(raw: string | Payload) {
        let next: Payload
        try { next = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return }
        setPayload(next)
        // The web UI injects one theme's raw CSS at runtime; do exactly the same so
        // the tokens (and therefore every colour) match the WebUI one-to-one.
        const theme = next.theme === 'light' ? 'light' : 'dark'
        let sheet = document.getElementById('pdr-theme') as HTMLStyleElement | null
        if (!sheet) {
          sheet = document.createElement('style')
          sheet.id = 'pdr-theme'
          document.head.appendChild(sheet)
        }
        sheet.textContent = theme === 'light' ? lightTheme : darkTheme
        document.documentElement.dataset.theme = theme
        document.documentElement.style.colorScheme = theme
      },
      scrollToBottom() { nearBottom.current = true; scrollDown() },
    }
    ;(window as unknown as { PiDashRenderer: typeof bridge }).PiDashRenderer = bridge
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Follow streaming output only when the reader is already at the bottom, so
  // scrolling back through history is never yanked away — same rule as native.
  useEffect(() => {
    if (!nearBottom.current) return
    const frame = requestAnimationFrame(() => setTimeout(scrollDown, 60))
    return () => cancelAnimationFrame(frame)
  }, [payload])

  const items = payload.items || []

  return (
    <div ref={root} className="space-y-2 px-3 py-3">
      {items.length === 0
        ? <p className="py-10 text-center text-sm text-muted">{payload.emptyText || '暂无内容'}</p>
        : items.map(item => <Card key={item.id} item={item} />)}
    </div>
  )
}

function scrollDown() {
  const scroller = document.scrollingElement || document.documentElement
  scroller.scrollTop = scroller.scrollHeight
}

createRoot(document.getElementById('root')!).render(<App />)