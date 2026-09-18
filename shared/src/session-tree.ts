/**
 * Session-family graph payload for the `/live-sessions/graph` page.
 *
 * A "family" is the set of pi session files linked through `header.parentSession`
 * (created by `fork` / `clone`). Forked files are self-contained copies: they
 * share the leading prefix (same entry ids, same order) with their parent file,
 * so the graph renders the parent's prefix once and hangs the child's
 * child-only entries off the last shared entry id (`forkAnchorId`).
 *
 * These types are deliberately kept out of the versioned live-session wire
 * protocol (`live-sessions.ts`): the graph is served over a plain read-only
 * HTTP endpoint, not the broker socket.
 */

/** Hard cap on how many session files one family response may contain. */
export const SESSION_TREE_MAX_SESSIONS = 40
/** Hard cap on how many rendered nodes one family response may contain. */
export const SESSION_TREE_MAX_NODES = 3000
/** Collapse a linear run of at least this many non-structural nodes into one node. */
export const SESSION_TREE_LINEAR_RUN_MIN = 3
/** Files larger than this are parsed from the tail only (bounded read). */
export const SESSION_TREE_MAX_PARSE_BYTES = 20 * 1024 * 1024
/** Tail window used for oversized files. */
export const SESSION_TREE_TAIL_BYTES = 8 * 1024 * 1024
/** Preview text length kept per node. */
export const SESSION_TREE_PREVIEW_CHARS = 160
/** Steps returned per expanded run by default (the UI offers “加载更多” to raise this). */
export const SESSION_TREE_STEPS_DEFAULT = 400
/** Hard ceiling for `?steps=`; above this the whole-graph `detail=full` mode is the tool. */
export const SESSION_TREE_STEPS_MAX = 3000
/** Header index (one line read per session file) freshness window. */
export const SESSION_TREE_INDEX_TTL_MS = 30_000

export type SessionTreeNodeKind =
  | 'message'
  | 'tool'
  | 'system'
  | 'compaction'
  | 'branchSummary'
  | 'custom'
  | 'collapsed'

export type SessionTreeNodeRole = 'user' | 'assistant' | 'system' | 'tool'

export interface SessionTreeNode {
  /** Entry id, or a synthetic `run:<headId>` id for collapsed linear runs. */
  id: string
  /** Tree edge inside the rendered graph (a child file's first node is re-parented to `forkAnchorId`). */
  parentId: string | null
  kind: SessionTreeNodeKind
  /** Owning session key (`<session file basename without .jsonl>`). */
  sessionKey: string
  role?: SessionTreeNodeRole
  /** Raw pi entry type (`message` / `compaction` / `branch_summary` / `custom` / ...). */
  type: string
  /** pi `label` entry target value, when the entry has been labeled. */
  label?: string
  /** One-line node title. */
  title: string
  preview?: string
  timestamp?: string
  /** Tool names invoked by an assistant message, when any. */
  tools?: string[]
  childCount: number
  isLeaf: boolean
  /** True for the focus file's active leaf (`leafId`). */
  isHead: boolean
  /** `kind === 'collapsed'` only: how many entries were folded in. */
  collapsedCount?: number
  /** `kind === 'collapsed'` only: the folded entry-id range, for a later expansion pass. */
  collapsedRange?: { from: string; to: string }
  /** `kind === 'collapsed'` only: the run was expanded in place (`?expand=`), see `steps`. */
  expanded?: boolean
  /**
   * `kind === 'collapsed'` only: the real entries of the run, in order, so the UI
   * can list them inside the expanded card. They are carried as nested data and
   * are NOT part of the graph layout (that is what keeps the canvas readable).
   */
  steps?: SessionTreeNode[]
  /** True when `steps` was cut short of the run's real size (`collapsedCount` is the truth). */
  stepsTruncated?: boolean
  /** True when a forked child session hangs off this entry. */
  isForkAnchor?: boolean
}

export interface SessionTreeSessionEntry {
  /** `<session file basename without .jsonl>` — stable id used by nodes and fork edges. */
  key: string
  /** Absolute session file path. */
  file: string
  sessionId: string | null
  cwd?: string
  timestamp?: string
  entryCount: number
  leafId: string | null
  isFocus: boolean
  /** Set when this file is currently attached to a live pi process. */
  isLive?: boolean
  /** Session key of the file this one was forked from (`header.parentSession`), when in the family. */
  forkOf?: string
  /** Entry id in `forkOf` where the branches diverge; `null` when the prefix could not be matched. */
  forkAnchorId?: string | null
  /** True when the file was oversized and only its tail was parsed. */
  partial?: boolean
}

export interface SessionTreeGraph {
  /** Session key of the focused session (empty string when the file could not be resolved). */
  focusKey: string
  sessions: SessionTreeSessionEntry[]
  nodes: SessionTreeNode[]
  /** `collapsed` = linear runs folded (default); `full` = every entry returned. */
  detail: 'collapsed' | 'full'
  /** True when sessions or nodes were dropped because a cap was hit. */
  truncated: boolean
  generatedAt: number
}