/**
 * Offline transcript renderer for the Android app.
 *
 * Reuses the real WebUI renderer (react-markdown + remark-gfm + rehype-raw +
 * DOMPurify + highlight.js + mermaid + DiffBlock) and the real theme CSS, and
 * mirrors the WebUI's step/reply presentation rules from
 * `features/live-sessions/ActivityTimeline.tsx`:
 *
 * - a tool is a one-line step (status icon + label + name/detail), not a dump of
 *   its arguments and full output; long output is collapsed behind a toggle;
 * - `run_code` (and equivalents) is grouped as "Run Code" because its output is
 *   the body of the step, not a message;
 * - long reply text is clipped to 12 lines / 1200 chars with the same
 *   "展开全部正文（N 行）" affordance and gradient.
 *
 * Deliberate constraints: no network, no cookies, no credentials. The native app
 * pushes already-projected items in; `onFileOpen` is a no-op so a tapped path
 * never reaches `api.revealPath`.
 */
import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import MarkdownRenderer from '../src/components/MarkdownRenderer'
import darkTheme from '../src/themes/dark.css?raw'
import lightTheme from '../src/themes/light.css?raw'
import '../src/index.css'
import './renderer.css'

interface Item {
  id: string
  role: string
  text: string
  thinking?: string | null
  toolName?: string | null
  isError?: boolean
  status?: string
  images?: { mimeType: string; data: string }[]
}

/** Set by the Android shell; absent in a plain browser, where clicks stay inert. */
interface NativeBridge {
  openPath?: (path: string) => void
  openUrl?: (url: string) => void
}

interface Payload {
  theme?: 'dark' | 'light'
  items?: Item[]
  emptyText?: string
}

/** Same thresholds as ActivityReplyBody. */
const PREVIEW_LINES = 12
const PREVIEW_CHARS = 1200

const STEP: Record<string, { icon: string; label: string; tone: string }> = {
  pending: { icon: '○', label: '未完成', tone: 'text-muted' },
  running: { icon: '●', label: '进行中', tone: 'text-accent' },
  done: { icon: '✓', label: '已完成', tone: 'text-ok' },
  error: { icon: '!', label: '失败', tone: 'text-danger' },
  blocked: { icon: '!', label: '受阻', tone: 'text-warn' },
}

const isTool = (item: Item) => item.role === 'tool' || item.role === 'toolResult' || !!item.toolName
const isRunCode = (item: Item) => /run[-_ ]?code|runcode/i.test(item.toolName || '')
const stepOf = (item: Item) => STEP[item.isError ? 'error' : item.status || 'done'] || STEP.done

/** One tool execution as a WebUI-style step row; output stays collapsed. */
function Step({ item }: { item: Item }) {
  const status = stepOf(item)
  const [open, setOpen] = useState(false)
  const body = item.text.trim()
  const lines = body ? body.split('\n') : []
  const detail = lines.length === 1 && body.length <= 120 ? body : ''
  const long = !!body && !detail
  const name = isRunCode(item) ? 'Run Code' : item.toolName || '工具'
  return (
    <article className="min-w-0 rounded-md border border-border bg-card px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 text-2xs">
        <span className={`shrink-0 font-semibold ${status.tone}`} aria-label={status.label}>{status.icon}</span>
        <span className={`shrink-0 ${status.tone}`}>{status.label}</span>
        <span className="shrink-0 font-medium text-text" title={name}>{name}</span>
        {detail && <span className="min-w-0 truncate text-muted" title={detail}>{detail}</span>}
        <span className="min-w-0 flex-1" />
        {long && (
          <button
            type="button"
            aria-expanded={open}
            className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-2xs text-accent"
            onClick={() => setOpen(value => !value)}
          >{open ? '收起输出' : isRunCode(item) ? '展开 Run Code' : '展开输出'}</button>
        )}
      </div>
      {body && long && open && (
        <pre className={`mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words border-l border-border pl-2 text-2xs leading-5 ${item.isError ? 'text-danger' : 'text-muted'}`}>{body}</pre>
      )}
    </article>
  )
}

/** Assistant/user text with the WebUI's clip-and-expand rule. */
function Body({ item }: { item: Item }) {
  const [expanded, setExpanded] = useState(false)
  const lines = item.text.split('\n')
  const long = lines.length > PREVIEW_LINES || item.text.length > PREVIEW_CHARS
  const visible = long && !expanded
    ? lines.slice(0, PREVIEW_LINES).join('\n').slice(0, PREVIEW_CHARS)
    : item.text
  const tool = isTool(item)
  return (
    <article className={`min-w-0 rounded-md border px-3 py-2.5 ${
      item.isError ? 'border-danger/40 bg-danger-subtle/30'
        : item.role === 'user' ? 'border-accent/30 bg-accent-subtle/25'
          : 'border-border bg-card'}`}>
      <header className="mb-1 flex min-w-0 items-center gap-2 text-2xs text-muted">
        <span className={item.isError ? 'font-semibold text-danger' : 'font-semibold'}>
          {item.role === 'user' ? '你' : item.role === 'assistant' ? 'Pi' : item.role}
        </span>
        {item.status === 'running' && <span className="text-accent">进行中</span>}
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
      <div className={`relative min-w-0 ${tool ? 'text-body-s' : 'text-body-s'} ${long && !expanded ? 'max-h-[200px] overflow-hidden' : ''}`}>
        <MarkdownRenderer content={visible} showRaw={false} streaming={item.status === 'running'} onFileOpen={openPath} />
        {long && !expanded && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-bg to-transparent" />}
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={expanded}
          className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-2xs text-accent"
          onClick={() => setExpanded(value => !value)}
        >{expanded ? '收起正文' : `展开全部正文（${lines.length} 行）`}</button>
      )}
    </article>
  )
}

function openPath(path: string) {
  ;(window as unknown as { PiDashNative?: NativeBridge }).PiDashNative?.openPath?.(path)
}

/**
 * Path discovery for taps.
 *
 * `MarkdownRenderer` only treats `<code>` spans and local links as openable, so a
 * path written in ordinary prose was inert. This delegated handler runs for every
 * tap: code/link first, then the first path-looking token inside the tapped
 * element. Anything already handled is skipped (`defaultPrevented`), and the
 * native side still refuses paths that are not on screen.
 */
const PATH_TOKEN = /(?:~|\.{0,2})?\/[\w.@~+-]+(?:\/[\w.@~+-]+)*\.[A-Za-z0-9]{1,8}/g

/** External links leave the app for the user's browser; the page never navigates. */
function urlFromTap(target: HTMLElement): string | undefined {
  const href = target.closest('a')?.getAttribute('href')?.trim()
  return href && /^https?:\/\//i.test(href) ? href : undefined
}

function pathFromTap(target: HTMLElement): string | undefined {
  const anchor = target.closest('a')
  const href = anchor?.getAttribute('href')?.trim()
  if (href) {
    if (/^(?:https?:|mailto:|#)/i.test(href)) return undefined
    return decodeURIComponent(href)
  }
  const code = target.closest('code')
  const scopes = [code?.textContent, target.textContent].filter((value): value is string => !!value)
  for (const scope of scopes) {
    const found = scope.match(PATH_TOKEN)
    if (found && found.length > 0) return found[0].replace(/[.,;:)]+$/, '')
  }
  return undefined
}

function usePathTaps() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (!target) return
      const url = urlFromTap(target)
      if (url) {
        event.preventDefault()
        ;(window as unknown as { PiDashNative?: NativeBridge }).PiDashNative?.openUrl?.(url)
        return
      }
      const path = pathFromTap(target)
      if (!path) return
      event.preventDefault()
      openPath(path)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])
}

function App() {
  usePathTaps()
  const [payload, setPayload] = useState<Payload>({})
  const nearBottom = useRef(true)

  useEffect(() => {
    const scroller = document.scrollingElement || document.documentElement
    const onScroll = () => {
      nearBottom.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    const bridge = {
      render(raw: string | Payload) {
        let next: Payload
        try { next = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return }
        setPayload(next)
        // The web UI injects one theme's raw CSS at runtime; do the same so the
        // tokens (and therefore every colour) match the WebUI one-to-one.
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

  useEffect(() => {
    if (!nearBottom.current) return
    const frame = requestAnimationFrame(() => setTimeout(scrollDown, 60))
    return () => cancelAnimationFrame(frame)
  }, [payload])

  const items = payload.items || []

  return (
    <div className="space-y-2 px-3 py-3">
      {items.length === 0
        ? <p className="py-10 text-center text-sm text-muted">{payload.emptyText || '暂无内容'}</p>
        : items.map(item => isTool(item)
          ? <Step key={item.id} item={item} />
          : <Body key={item.id} item={item} />)}
    </div>
  )
}

function scrollDown() {
  const scroller = document.scrollingElement || document.documentElement
  scroller.scrollTop = scroller.scrollHeight
}

createRoot(document.getElementById('root')!).render(<App />)