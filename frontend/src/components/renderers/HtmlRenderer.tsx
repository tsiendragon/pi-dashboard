import { useEffect, useRef, useState } from 'react'
import { inlineHtmlAssets, resolveHtmlAssetRefs } from '../../utils/resolvePath'

/**
 * Renders a locally-generated HTML artifact inside a sandboxed, opaque-origin
 * iframe with its JavaScript actually running (tabs, Mermaid, hljs, …).
 *
 * Security: sandbox WITHOUT `allow-same-origin`, so the frame gets a null origin
 * and cannot touch the dashboard's DOM/cookies/localStorage. Its `fetch` to the
 * un-authed mutation API is separately blocked by the backend `sameOriginOnly`
 * guard (Origin: null → 403).
 *
 * Assets: that same opaque origin is why the frame must not fetch anything
 * itself — the browser marks its requests cross-site and drops the SSO session
 * cookie of any gateway in front of the dashboard (DSW proxy), which 302s the
 * image/video to a login page. So the parent fetches each relative asset via
 * /api/local-file (credentials attached) and inlines it as a data: URI before
 * the html ever reaches srcDoc. Anything not inlinable falls back to a plain
 * /api/local-file URL (works when the dashboard is reached without a gateway).
 *
 * Commenting: the parent cannot read a selection made inside an opaque-origin
 * frame, so a small BRIDGE script is appended to the artifact. It captures the
 * in-frame selection and postMessages the selected text out. The parent
 * validates `event.source === iframe.contentWindow` (event.origin is the useless
 * string "null" for sandboxed frames) and reverse-maps the text to source lines.
 */
function withBridge(html: string): string {
  return html + `<script>(function(){
    document.addEventListener('mouseup', function(){
      var s = window.getSelection();
      if (!s || s.isCollapsed) return;
      var text = s.toString();
      if (!text.trim()) return;
      parent.postMessage({ __picomment: true, kind: 'selection', text: text }, '*');
    });
  })()<\/script>`
}

interface Props {
  content: string
  /** Path of the HTML file on disk — relative images/videos/scripts resolve against its directory. */
  baseFilePath?: string
  onSelect?: (text: string) => void
  /** Bumps to force a full iframe remount on live-reload (guarantees script re-exec). */
  reloadKey?: number
}

export default function HtmlRenderer({ content, baseFilePath, onSelect, reloadKey }: Props) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [processed, setProcessed] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setProcessed(null)
    inlineHtmlAssets(content, baseFilePath)
      // Leftover relative refs (missing/oversized assets, page links) still get
      // the /api/local-file URL so they at least work off-gateway.
      .then(inlined => { if (!cancelled) setProcessed(resolveHtmlAssetRefs(inlined, baseFilePath)) })
      .catch(() => { if (!cancelled) setProcessed(resolveHtmlAssetRefs(content, baseFilePath)) })
    return () => { cancelled = true }
  }, [content, baseFilePath])

  useEffect(() => {
    if (!onSelect) return
    function onMsg(e: MessageEvent) {
      
      
      if (e.source !== ref.current?.contentWindow) return
      const d = e.data
      if (d && d.__picomment && d.kind === 'selection' && typeof d.text === 'string') {
        onSelect?.(d.text)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [onSelect])

  if (processed == null) {
    return <div className="flex h-full w-full items-center justify-center text-sm text-muted">Loading…</div>
  }

  return (
    <iframe
      key={reloadKey}
      ref={ref}
      title="HTML preview"
      srcDoc={withBridge(processed)}
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className="w-full h-full border-0 bg-white rounded-md"
    />
  )
}
