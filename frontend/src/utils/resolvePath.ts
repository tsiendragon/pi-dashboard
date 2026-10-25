/**
 * Resolve a file path the user clicked / typed against a workspace cwd.
 *
 * The dashboard backend's file-serving endpoints (`/api/file-read`,
 * `/api/local-file`, etc.) `readFile` the path as-is. When a path is
 * relative the OS resolves it against `process.cwd()` of the dashboard
 * process — which is the install dir, not the user's workspace — so any
 * relative path 404s. Inline references in assistant messages and the
 * referenced-files panel routinely produce relative paths
 * (e.g. `docs/design/1-pager.md`); we resolve them here against the
 * active slot's cwd before they hit the wire.
 *
 * Rules:
 *   - empty input → empty (caller will short-circuit / 400)
 *   - `/abs/...` → returned unchanged
 *   - `~/...` or `~` → returned unchanged (backend's `expandHome` handles it)
 *   - relative + cwd → joined onto cwd (and `./` collapsed)
 *   - relative + no cwd → returned unchanged (preserves prior behaviour)
 */
export function resolvePath(path: string, cwd?: string | null): string {
  if (!path) return path
  if (path.startsWith('/') || path.startsWith('~')) return path
  if (!cwd) return path
  // Strip leading ./ — `cwd/./foo` is fine on POSIX but ugly in tooltips.
  const cleaned = path.replace(/^\.\//, '')
  const base = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd
  return `${base}/${cleaned}`
}

/** Directory portion of a POSIX-ish path (`''` when there is no `/`). */
function dirOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  return slash >= 0 ? normalized.slice(0, slash) : ''
}

/** Collapse `./` and `../` without touching a leading `/` or `~`. */
function joinPosix(path: string): string {
  const absolute = path.startsWith('/')
  const out: string[] = []
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(segment)
  }
  return (absolute ? '/' : '') + out.join('/')
}

/**
 * Rewrite a Markdown asset reference so the preview can actually load it.
 *
 * `![](images/foo.png)` renders its `src` verbatim, so the browser resolves it
 * against the current page URL (`/chat`) — where the SPA fallback answers with
 * `index.html` (HTTP 200, `text/html`) and the `<img>` silently stays blank.
 * GitHub resolves the same markdown against the file's own directory, which is
 * why relative images work there but not in the dashboard preview.
 *
 * So: resolve relative asset paths against the markdown file's directory and
 * hand them to `/api/local-file`, the endpoint the dashboard already uses to
 * serve local files.
 *
 * Rules:
 *   - `http:`, `https:`, `data:`, `blob:`, `//host/x.png` → unchanged
 *   - `/api/...` and any other root-relative URL → unchanged
 *   - `images/x.png`, `./x.png`, `../x.png` → `/api/local-file?path=<resolved>`
 *   - no `baseFilePath` (chat messages, live sessions) → unchanged
 */
export function resolveMarkdownAssetUrl(url: string, baseFilePath?: string | null): string {
  if (!url || !baseFilePath) return url
  // Any scheme (`http:`, `data:`, `blob:`, `mailto:`) or a root-relative URL is
  // already something the browser can fetch as-is.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) || url.startsWith('/')) return url
  const pathPart = url.split(/[?#]/, 1)[0]
  if (!pathPart) return url
  const dir = dirOf(baseFilePath)
  const resolved = joinPosix(dir ? `${dir}/${pathPart}` : pathPart)
  return `/api/local-file?path=${encodeURIComponent(resolved)}`
}

const HTML_ASSET_ATTR_RE = /(\s(?:src|href|poster)\s*=\s*)("([^"]*)"|'([^']*)')/gi

function isRelativeAssetUrl(url: string): boolean {
  if (!url || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) || url.startsWith('/') || url.startsWith('#')) return false
  return Boolean(url.split(/[?#]/, 1)[0])
}

/**
 * Asset types worth inlining into a preview document as data: URIs. Other
 * relative refs (e.g. `<a href="page2.html">`) keep the /api/local-file URL.
 */
const ASSET_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
}

/** Per-asset inline cap: base64 inflates ~33%, and srcdoc duplicates the string. */
const MAX_INLINE_ASSET_BYTES = 40 * 1024 * 1024

// Session cache so re-rendering / live-reload of the same document does not
// refetch every asset. Trade-off (deliberate): if an asset file is rewritten
// on disk under the same name, the preview keeps the old bytes until reload.
const inlineAssetCache = new Map<string, Promise<string | null>>()

function blobToDataUrl(blob: Blob, mime: string): Promise<string> {
  const typed = blob.type ? blob : new Blob([blob], { type: mime })
  return new Promise((resolvePromise, rejectPromise) => {
    const reader = new FileReader()
    reader.onload = () => resolvePromise(reader.result as string)
    reader.onerror = () => rejectPromise(reader.error)
    reader.readAsDataURL(typed)
  })
}

/**
 * Inline a local HTML artifact's relative assets as data: URIs, so the
 * sandboxed preview iframe does not have to fetch anything itself.
 *
 * Why not just point the iframe at /api/local-file (see resolveHtmlAssetRefs)?
 * The iframe runs with an opaque origin (sandbox without allow-same-origin),
 * so the browser marks its subresource requests cross-site and does NOT attach
 * the SSO session cookie of the gateway in front of the dashboard (DSW proxy).
 * The gateway then 302s every image/video to a login page and the preview
 * shows blank boxes. Fetching the bytes in the parent page context carries
 * the credential; data: URIs work in any origin.
 *
 * Assets that are missing, unreadable or larger than MAX_INLINE_ASSET_BYTES
 * keep their original reference (the /api/local-file rewrite may still apply).
 */
export async function inlineHtmlAssets(
  html: string,
  baseFilePath: string | null | undefined,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (!html || !baseFilePath) return html
  const dir = dirOf(baseFilePath)

  const jobs = new Map<string, string>() // url -> resolved absolute path
  html.replace(HTML_ASSET_ATTR_RE, (match, _prefix, _quoted, dq: string | undefined, sq: string | undefined) => {
    const url = (dq ?? sq ?? '').trim()
    if (!isRelativeAssetUrl(url) || jobs.has(url)) return match
    const pathPart = url.split(/[?#]/, 1)[0]
    const ext = pathPart.slice(pathPart.lastIndexOf('.')).toLowerCase()
    if (!ASSET_MIME_BY_EXT[ext]) return match
    jobs.set(url, joinPosix(dir ? `${dir}/${pathPart}` : pathPart))
    return match
  })
  if (jobs.size === 0) return html

  const results = new Map<string, string | null>()
  await Promise.all([...jobs.values()].map(async resolved => {
    let cached = inlineAssetCache.get(resolved)
    if (!cached) {
      const ext = resolved.slice(resolved.lastIndexOf('.')).toLowerCase()
      cached = (async () => {
        const res = await fetcher(`/api/local-file?path=${encodeURIComponent(resolved)}`)
        if (!res.ok) return null
        const blob = await res.blob()
        if (blob.size > MAX_INLINE_ASSET_BYTES) return null
        return blobToDataUrl(blob, ASSET_MIME_BY_EXT[ext] ?? 'application/octet-stream')
      })().catch(() => null)
      inlineAssetCache.set(resolved, cached)
    }
    results.set(resolved, await cached)
  }))

  return html.replace(HTML_ASSET_ATTR_RE, (match, prefix: string, _quoted, dq: string | undefined, sq: string | undefined) => {
    const url = (dq ?? sq ?? '').trim()
    const resolved = jobs.get(url)
    if (!resolved) return match
    const dataUrl = results.get(resolved)
    if (!dataUrl) return match
    const quote = dq !== undefined ? '"' : "'"
    return `${prefix}${quote}${dataUrl}${quote}`
  })
}
/**
 * Point a local HTML artifact's relative asset references at /api/local-file,
 * resolved against the file's own directory. Used as a fallback when inlining
 * fails, and for non-inlinable refs like `<a href="page2.html">`.
 */
export function resolveHtmlAssetRefs(html: string, baseFilePath?: string | null): string {
  if (!html || !baseFilePath) return html
  const dir = dirOf(baseFilePath)
  return html.replace(
    HTML_ASSET_ATTR_RE,
    (match, prefix: string, _quoted: string, dq: string | undefined, sq: string | undefined) => {
      const url = (dq ?? sq ?? '').trim()
      if (!isRelativeAssetUrl(url)) return match
      const pathPart = url.split(/[?#]/, 1)[0]
      if (!pathPart) return match
      const resolved = joinPosix(dir ? `${dir}/${pathPart}` : pathPart)
      const quote = dq !== undefined ? '"' : "'"
      return `${prefix}${quote}/api/local-file?path=${encodeURIComponent(resolved)}${quote}`
    },
  )
}
