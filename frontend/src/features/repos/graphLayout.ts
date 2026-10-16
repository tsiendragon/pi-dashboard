import type { RepoCommit } from '@shared/repos'

/** One drawn line inside a row; lanes are x slots, y runs 0 (row top) → 1 (row bottom), node at 0.5. */
export interface GraphSegment {
  kind: 'pass' | 'in' | 'out'
  /** pass: lane both ends; in: lane at the top; out: lane at the bottom. */
  lane: number
  /** Colour slot of the lane the line belongs to. */
  color: number
}

export interface GraphRow {
  hash: string
  node: number
  nodeColor: number
  segments: GraphSegment[]
}

export interface GraphLayout {
  rows: GraphRow[]
  laneCount: number
}

/**
 * Lane assignment for `git log --date-order` output (children always precede parents).
 * Each lane waits for one hash; the commit that matches takes the lane, the first parent
 * inherits it and extra parents (merges) fork into a free lane or join an existing one.
 * Colours follow the lane, so a branch keeps its colour until the lane is reused.
 */
export function layoutGraph(commits: readonly Pick<RepoCommit, 'hash' | 'parents'>[]): GraphLayout {
  let lanes: (string | null)[] = []
  let colors: number[] = []
  let nextColor = 0
  let laneCount = 0
  const rows: GraphRow[] = []

  for (const commit of commits) {
    const segments: GraphSegment[] = []
    let node = lanes.indexOf(commit.hash)
    if (node < 0) {
      node = lanes.indexOf(null)
      if (node < 0) node = lanes.length
      lanes[node] = null
      colors[node] = nextColor++
    }
    const nodeColor = colors[node]!

    lanes.forEach((hash, lane) => {
      if (hash === null || lane === node) return
      segments.push({ kind: 'pass', lane, color: colors[lane]! })
    })
    // Lanes converging into this commit (it was expected in more than one lane).
    lanes.forEach((hash, lane) => {
      if (hash === commit.hash) segments.push({ kind: 'in', lane, color: colors[lane]! })
    })
    // pass segments must not duplicate converging lanes
    const converging = new Set(lanes.map((hash, lane) => (hash === commit.hash ? lane : -1)).filter(lane => lane >= 0))
    const filtered = segments.filter(seg => seg.kind !== 'pass' || !converging.has(seg.lane))

    const after = [...lanes]
    converging.forEach(lane => { after[lane] = null })
    const [first, ...others] = commit.parents
    if (first !== undefined) {
      const existing = after.indexOf(first)
      if (existing >= 0 && existing !== node) {
        filtered.push({ kind: 'out', lane: existing, color: colors[existing]! })
      } else {
        after[node] = first
        colors[node] = nodeColor
        filtered.push({ kind: 'out', lane: node, color: nodeColor })
      }
    }
    for (const parent of others) {
      let lane = after.indexOf(parent)
      if (lane < 0) {
        lane = after.indexOf(null)
        if (lane < 0) lane = after.length
        after[lane] = parent
        colors[lane] = nextColor++
      }
      filtered.push({ kind: 'out', lane, color: colors[lane]! })
    }

    while (after.length && after[after.length - 1] === null) after.pop()
    lanes = after
    laneCount = Math.max(laneCount, node + 1, ...filtered.map(seg => seg.lane + 1))
    rows.push({ hash: commit.hash, node, nodeColor, segments: filtered })
  }
  return { rows, laneCount }
}
