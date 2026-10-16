/**
 * Repo candidates behind the Live Pi start field's keyword search.
 *
 * `liveSessions.repoRoots` names the folders where checkouts live (for example
 * `~/repos`). Their DIRECT children are the candidates: walking deeper would
 * surface `src/`, `node_modules/` and worktree copies, which are never what
 * someone typing a repo name means. The scan is read-only and every failure is
 * per-child, so one unreadable root cannot break the list.
 */
import { access, readdir, stat } from 'fs/promises'
import path from 'path'
import type { RepoCandidate } from '../../shared/src/live-sessions.js'

/** Directories that are never a repo the user wants to start in. */
const SKIP_NAMES = new Set(['node_modules', '__pycache__'])

/** Hard cap so a misconfigured root (say, the home dir) cannot flood the menu. */
export const MAX_REPO_CANDIDATES = 400

export async function listRepoCandidates(repoRoots: readonly string[]): Promise<RepoCandidate[]> {
  const seen = new Set<string>()
  const candidates: RepoCandidate[] = []
  roots: for (const root of repoRoots) {
    let entries: import('fs').Dirent[]
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    const children = entries
      .filter(entry => !entry.name.startsWith('.') && !SKIP_NAMES.has(entry.name))
      .map(entry => path.join(root, entry.name))
    const resolved = await Promise.all(children.map(async full => {
      try {
        // stat (not Dirent.isDirectory) so symlinked checkouts count too.
        if (!(await stat(full)).isDirectory()) return null
      } catch {
        return null
      }
      return full
    }))
    for (const full of resolved) {
      if (!full || seen.has(full)) continue
      seen.add(full)
      candidates.push({ name: path.basename(full), path: full, git: await isCheckout(full) })
      if (candidates.length >= MAX_REPO_CANDIDATES) break roots
    }
  }
  return candidates.sort((left, right) => left.name.localeCompare(right.name))
}

async function isCheckout(dir: string): Promise<boolean> {
  try {
    await access(path.join(dir, '.git'))
    return true
  } catch {
    return false
  }
}