/**
 * Keyword lookup over the directories the user actually started a Live Pi in.
 *
 * The working-directory field used to offer the last few paths verbatim, which
 * stops helping as soon as that list outgrows one row of chips. History here is
 * what the browser remembered plus the cwd of every live session the sidebar can
 * see, so typing a fragment of a name ("toolkit", "card-router") is enough to get
 * the real path back.
 */

/** How many paths the browser remembers between sessions (display offers fewer). */
export const START_PATH_HISTORY_KEEP = 24

/** How many candidates the suggestion chips and the completion menu offer. */
export const START_PATH_HISTORY_LIMIT = 8

/** Recent paths first, then every session cwd that is not already listed. */
export function mergeStartPathHistory(
  recent: readonly string[],
  sessionCwds: readonly (string | null | undefined)[],
): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const candidate of [...recent, ...sessionCwds]) {
    const path = typeof candidate === 'string' ? candidate.trim() : ''
    if (!path || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

/** True when the query is a path being typed (`/…`, `~/…`, `./…`), not a keyword. */
export function isPathLikeQuery(query: string): boolean {
  return /^[~/.]/.test(query.trim())
}

function lastSegment(path: string): string {
  const parts = path.toLowerCase().replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path.toLowerCase()
}

/**
 * How well a path answers the query, higher being closer: an exact last segment
 * beats a prefix, a prefix beats a middle-of-name hit, and a match anywhere in a
 * parent segment is the weakest (it only says the path lives in the right tree).
 */
function scorePath(path: string, query: string): number {
  const lowerPath = path.toLowerCase()
  const base = lastSegment(lowerPath)
  if (base === query) return 1000
  if (base.startsWith(query)) return 800
  if (base.includes(query)) return 600
  const segments = lowerPath.split('/').filter(Boolean)
  if (segments.some(segment => segment !== base && segment.startsWith(query))) return 500
  if (segments.some(segment => segment !== base && segment.includes(query))) return 400
  if (lowerPath.includes(query)) return 200
  return 0
}

/**
 * Rank `paths` against a free-text query. An empty query keeps the incoming
 * order (recency); otherwise the best matches come first, ties keep the incoming
 * order, and a shorter path wins over a longer one at the same score.
 */
export function matchStartPaths(
  paths: readonly string[],
  query: string,
  limit = START_PATH_HISTORY_LIMIT,
): string[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return paths.slice(0, limit)
  return paths
    .map((path, index) => ({ path, index, score: scorePath(path, normalized) }))
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.path.length - right.path.length || left.index - right.index)
    .slice(0, limit)
    .map(entry => entry.path)
}