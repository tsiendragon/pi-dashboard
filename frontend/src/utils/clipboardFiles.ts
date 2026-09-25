/**
 * Clipboard paste helpers.
 *
 * Browsers expose files copied from the OS file manager as `kind: 'file'`
 * DataTransfer items (sometimes only through `clipboardData.files`), while
 * plain text/HTML arrives as `kind: 'string'`. These helpers keep that
 * structural handling out of the composer so images and documents can be
 * routed to the same pipelines as drag-drop.
 */

export interface ClipboardItemLike {
  kind?: string
  type?: string
  getAsFile?: () => File | null
}

export interface ClipboardDataLike {
  items?: ArrayLike<ClipboardItemLike> | null
  files?: ArrayLike<File> | null
}

/** Files carried by a paste event; empty when the clipboard holds only text. */
export function clipboardFiles(data: ClipboardDataLike | null | undefined): File[] {
  const files: File[] = []
  for (const item of Array.from(data?.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile?.()
    if (file) files.push(file)
  }
  if (!files.length) files.push(...Array.from(data?.files ?? []))
  return files
}

/** Images are sent inline as base64; everything else is uploaded as a file path. */
export function splitFilesByKind(files: File[]): { images: File[]; documents: File[] } {
  const images: File[] = []
  const documents: File[] = []
  for (const file of files) {
    if (file.type.startsWith('image/')) images.push(file)
    else documents.push(file)
  }
  return { images, documents }
}

const FILE_URL_RE = /^file:\/\//i
/** Whitespace means the paste is prose (or a command line), never a lone path. */
const HAS_WHITESPACE_RE = /\s/
/** `/abs`, `~/x`, `./x`, `../x` — an explicit path, safe to resolve as a file. */
const PATH_LIKE_RE = /^(?:[/~]|\.\.?\/)/
/** A bare file name (`notes.md`) — names with an extension, no spaces or separators. */
const BARE_NAME_RE = /^[^\s/\\:*?"<>|]+\.[A-Za-z0-9]{1,8}$/
/** A trailing file extension (`notes.md`, `/tmp/a.json`). */
const FILE_EXTENSION_RE = /\.[A-Za-z0-9]{1,8}$/

/**
 * Whether a pasted single-line text is worth resolving as a file.
 *
 * Tighter than a bare "starts like a path" check: a pasted slash command such
 * as `/taskspace start …` also begins with `/` but must stay ordinary text, so a
 * leading slash only counts when the rest behaves like a real path (a second
 * separator or a file extension). Whitespace always disqualifies a candidate.
 */
function looksLikePath(raw: string): boolean {
  if (HAS_WHITESPACE_RE.test(raw)) return false
  if (BARE_NAME_RE.test(raw)) return true
  if (!PATH_LIKE_RE.test(raw)) return false
  if (raw.startsWith('~/') || raw.startsWith('./') || raw.startsWith('../')) return true
  return raw.indexOf('/', 1) > 0 || FILE_EXTENSION_RE.test(raw)
}

/** Turn a `file://` URL into a filesystem path (Windows `file:///C:/…` included). */
export function decodeFileUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!FILE_URL_RE.test(trimmed)) return null
  try {
    const url = new URL(trimmed)
    const path = decodeURIComponent(url.pathname)
    return url.hostname && url.hostname !== 'localhost' ? `//${url.hostname}${path}` : path
  } catch {
    return null
  }
}

/**
 * The file referenced by a text-only paste, or null when the clipboard holds prose.
 *
 * macOS browsers put a file copied in Finder on the clipboard as text (a `file://`
 * URL or just the file name) instead of a `kind: 'file'` item, so the composer
 * resolves this candidate against the workspace before falling back to a text paste.
 */
export function pastedFileRef({ uriList, text }: { uriList?: string | null; text?: string | null }): string | null {
  for (const line of (uriList ?? '').split(/\r?\n/)) {
    const decoded = decodeFileUrl(line)
    if (decoded) return decoded
  }
  const raw = (text ?? '').trim().replace(/^["']|["']$/g, '')
  if (!raw || /[\r\n]/.test(raw)) return null
  return decodeFileUrl(raw) ?? (looksLikePath(raw) ? raw : null)
}