import type { Comment } from '../hooks/usePanelState'

const COMMENTS_ENDPOINT = '/api/file-comments'

/** Read the `.‹name›.comments.json` sidecar for a file; missing sidecar → no comments. */
export async function loadFileComments(filePath: string): Promise<Comment[]> {
  try {
    const res = await fetch(`${COMMENTS_ENDPOINT}?path=${encodeURIComponent(filePath)}`)
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data?.comments) ? data.comments : []
  } catch (error) {
    console.warn('[file-comments] load failed', filePath, error)
    return []
  }
}

/** Write the whole comment list back to the sidecar (the backend has no partial update). */
export async function saveFileComments(filePath: string, comments: Comment[]): Promise<void> {
  const res = await fetch(COMMENTS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, comments }),
  })
  if (!res.ok) throw new Error(`Failed to save comments (${res.status})`)
}

/** Newest snapshot version of a file, used to stamp new comments. */
export async function loadCurrentFileVersion(filePath: string): Promise<number> {
  try {
    const res = await fetch(`/api/file-versions?path=${encodeURIComponent(filePath)}`)
    if (!res.ok) return 1
    const data = await res.json()
    const versions = Array.isArray(data?.versions) ? data.versions : []
    return versions.length > 0 ? versions[versions.length - 1].version : 1
  } catch (error) {
    console.warn('[file-comments] version lookup failed', filePath, error)
    return 1
  }
}