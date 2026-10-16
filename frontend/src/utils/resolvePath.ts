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
