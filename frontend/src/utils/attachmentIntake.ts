import { api } from '../api/client'

export interface AttachedFile {
  name: string
  path: string
}

/** Append an attachment unless the same path is already attached. */
export function withAttachedFile(list: AttachedFile[], file: AttachedFile): AttachedFile[] {
  return list.some(existing => existing.path === file.path) ? list : [...list, file]
}

/**
 * Upload picked/dropped/pasted files to the dashboard host and return their paths.
 * Composer messages then carry the paths, so pi can read the real file.
 */
export async function uploadAttachedFiles(files: File[]): Promise<AttachedFile[]> {
  if (!files.length) return []
  const payload = await Promise.all(files.map(file => new Promise<{ name: string; data: string }>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ name: file.name, data: (reader.result as string).split(',')[1] })
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`))
    reader.readAsDataURL(file)
  })))
  const { paths } = await api.uploadFiles(payload)
  if (!paths?.length) throw new Error('Upload returned no paths')
  return paths.map((path, index) => ({ name: files[index]?.name || path.split('/').pop() || path, path }))
}

/**
 * Resolve a path reference (`~/x`, `/x`, `docs/x.md`, `notes.md`) to a file that
 * exists on the dashboard host.
 *
 * Absolute paths must exist literally. Simple names are also searched as a unique
 * exact-name match under the workspace cwd first, then the whole home dir — a
 * pasted file name cannot be trusted to be unique, so ambiguous hits resolve to
 * null and the caller keeps the plain text paste instead.
 */
export async function resolveFileRef(candidate: string, cwd?: string | null): Promise<AttachedFile | null> {
  const absolute = candidate.startsWith('/') || candidate.startsWith('~')
  const target = absolute ? candidate : cwd ? `${cwd.replace(/\/+$/, '')}/${candidate.replace(/^\.\//, '')}` : candidate

  const slash = target.lastIndexOf('/')
  const dir = slash > 0 ? target.slice(0, slash) : '/'
  const base = slash >= 0 ? target.slice(slash + 1) : target
  if (!base || base === '.' || base === '..') return null

  try {
    const { entries } = await api.browseFiles(dir)
    const hit = entries.find(entry => entry.name === base && !entry.isDir)
    if (hit) return { name: hit.name, path: hit.path }
  } catch {
    // Unreadable / non-existent directory — fall through to the name search.
  }

  if (absolute) return null
  try {
    const { entries } = await api.fileSearch(base, cwd ?? undefined, 100)
    const matches = entries.filter(entry => entry.name === base && !entry.isDir)
    const prefix = cwd ? (cwd.endsWith('/') ? cwd : `${cwd}/`) : null
    const inCwd = prefix ? matches.filter(entry => entry.path.startsWith(prefix)) : []
    if (inCwd.length === 1) return { name: inCwd[0].name, path: inCwd[0].path }
    if (inCwd.length === 0 && matches.length === 1) return { name: matches[0].name, path: matches[0].path }
    return null
  } catch {
    return null
  }
}