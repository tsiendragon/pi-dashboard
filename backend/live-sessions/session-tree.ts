/**
 * Session-family graph builder for the `/live-sessions/graph` page.
 *
 * Design notes (all verified against real session files):
 * - A forked session file is a SELF-CONTAINED copy: it repeats its parent's
 *   leading prefix with identical entry ids in identical order, then appends its
 *   own entries. `header.parentSession` holds the parent's absolute file path.
 * - Therefore the graph renders the parent's prefix once and hangs the child's
 *   child-only entries off the last shared entry id (`forkAnchorId`). Every
 *   non-root session in the family skips its own copy of the prefix.
 * - Files are read asynchronously and bounded: files over
 *   `SESSION_TREE_MAX_PARSE_BYTES` are parsed from a tail window only, which is
 *   reported as `partial: true`.
 */
import { createReadStream } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { extractText, stripInjectedBlocks } from '../session-store.js'
import {
  SESSION_TREE_INDEX_TTL_MS,
  SESSION_TREE_STEPS_DEFAULT,
  SESSION_TREE_STEPS_MAX,
  SESSION_TREE_LINEAR_RUN_MIN,
  SESSION_TREE_MAX_NODES,
  SESSION_TREE_MAX_PARSE_BYTES,
  SESSION_TREE_MAX_SESSIONS,
  SESSION_TREE_PREVIEW_CHARS,
  SESSION_TREE_TAIL_BYTES,
  type SessionTreeGraph,
  type SessionTreeSessionEntry,
  type SessionTreeNode,
  type SessionTreeNodeKind,
  type SessionTreeNodeRole,
} from '../../shared/src/session-tree.js'

const HEADER_READ_BYTES = 256 * 1024
const IO_CONCURRENCY = 16

/**
 * Pi agent sessions root. `PI_DASH_SESSIONS_DIR` is an escape hatch for tests
 * (and for agents whose data dir is not the default); unset means the standard
 * `~/.pi/agent/sessions`.
 */
function sessionsDir(): string {
  const override = process.env.PI_DASH_SESSIONS_DIR
  return override && override.trim() ? override : join(homedir(), '.pi', 'agent', 'sessions')
}

export class SessionTreeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'SessionTreeError'
  }
}

export interface SessionHeaderInfo {
  file: string
  sessionId: string | null
  parentSession: string | null
  cwd?: string
  timestamp?: string
}

export interface BuildSessionFamilyOptions {
  /** Absolute path to the session file that the graph should focus. */
  sessionFile: string
  /** pi sessionIds that currently have an attached live process (drives `isLive`). */
  liveSessionIds?: Set<string>
  /**
   * `true` returns every entry instead of folding linear runs. The graph page
   * exposes this as a “显示步骤” toggle.
   */
  expandLinearRuns?: boolean
  /**
   * Head ids (`run:<headId>`) of folded runs that should be expanded IN PLACE:
   * the folded node stays a single graph node but carries its real entries in
   * `steps`,so the UI can list them inside the card without blowing up the layout.
   */
  expandRuns?: Set<string>
  /**
   * How many steps to return per expanded run. The UI's “加载更多” raises this
   * (clamped to [1, SESSION_TREE_STEPS_MAX]); `collapsedCount` still reports the
   * run's real size so the card can show `已加载 400 / 868`.
   */
  expandStepLimit?: number
}

interface ParsedEntry {
  id: string
  parentId: string | null
  type: string
  timestamp?: string
  kind: SessionTreeNodeKind
  role?: SessionTreeNodeRole
  title: string
  preview?: string
  tools?: string[]
}

interface ParsedFile {
  file: string
  entries: ParsedEntry[]
  leafId: string | null
  labels: Map<string, string>
  partial: boolean
}

export function sessionKeyForFile(file: string): string {
  return basename(file).replace(/\.jsonl$/, '')
}

// ─ small async helpers ──

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const workerCount = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      out[index] = await fn(items[index])
    }
  }))
  return out
}

function readSlice(file: string, start: number, end?: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    const stream = createReadStream(file, end === undefined ? { start } : { start, end })
    stream.on('data', chunk => chunks.push(Buffer.from(chunk)))
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    stream.on('error', reject)
  })
}

function clip(text: string): string | undefined {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > SESSION_TREE_PREVIEW_CHARS ? `${flat.slice(0, SESSION_TREE_PREVIEW_CHARS - 1)}…` : flat
}

function asRole(value: unknown): SessionTreeNodeRole | undefined {
  return value === 'user' || value === 'assistant' || value === 'system' || value === 'tool' ? value : undefined
}

/** Clamp the per-run step window requested by `?steps=` into a safe range. */function clampStepLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SESSION_TREE_STEPS_DEFAULT
  return Math.max(1, Math.min(SESSION_TREE_STEPS_MAX, Math.floor(value)))
}

// ── path scope guard ──

/**
 * Resolve `file` and require it to live inside `<agentDir>/sessions/`.
 * Throws `session_file_not_found` when the path does not exist and
 * `session_file_out_of_scope` when it resolves outside the sessions root, so the
 * HTTP layer can answer 404 / 403 instead of a misleading empty graph.
 */
export async function resolveSessionFileInScope(file: string): Promise<string> {
  let target: string
  try {
    target = await realpath(file)
  } catch {
    throw new SessionTreeError('session_file_not_found', 'session file does not exist')
  }
  const base = await realpath(sessionsDir()).catch(() => sessionsDir())
  if (target !== base && !target.startsWith(base + sep)) {
    throw new SessionTreeError('session_file_out_of_scope', 'session file is outside the pi sessions directory')
  }
  return target
}

// ─ header index (one line read per session file) ──

let headerIndexCache: { at: number; byFile: Map<string, SessionHeaderInfo> } | null = null

async function readFirstLine(file: string): Promise<string | null> {
  let head: string
  try {
    head = await readSlice(file, 0, HEADER_READ_BYTES - 1)
  } catch {
    return null
  }
  const newline = head.indexOf('\n')
  if (newline === -1) return head
  return head.slice(0, newline)
}

export async function listSessionHeaders(force = false): Promise<Map<string, SessionHeaderInfo>> {
  if (!force && headerIndexCache && Date.now() - headerIndexCache.at < SESSION_TREE_INDEX_TTL_MS) {
    return headerIndexCache.byFile
  }
  let dirs: string[] = []
  const root = sessionsDir()
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.startsWith('--')).map(entry => entry.name)
  } catch {
    dirs = []
  }
  const files: string[] = []
  for (const dir of dirs) {
    const full = join(root, dir)
    try {
      for (const name of await readdir(full)) if (name.endsWith('.jsonl')) files.push(join(full, name))
    } catch {
      // unreadable directory — skip
    }
  }
  const parsed = await mapLimit(files, IO_CONCURRENCY, async file => {
    const line = await readFirstLine(file)
    if (!line) return null
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      return null
    }
    if (obj.type !== 'session') return null
    const info: SessionHeaderInfo = {
      file,
      sessionId: typeof obj.id === 'string' ? obj.id : null,
      parentSession: typeof obj.parentSession === 'string' ? obj.parentSession : null,
      ...(typeof obj.cwd === 'string' ? { cwd: obj.cwd } : {}),
      ...(typeof obj.timestamp === 'string' ? { timestamp: obj.timestamp } : {}),
    }
    return info
  })
  const byFile = new Map<string, SessionHeaderInfo>()
  for (const info of parsed) if (info) byFile.set(info.file, info)
  headerIndexCache = { at: Date.now(), byFile }
  return byFile
}

// ── per-file parsing (mtime+size cached, bounded) ─

const parsedCache = new Map<string, { mtimeMs: number; size: number; value: ParsedFile }>()
const PARSED_CACHE_MAX = 48

export function resetSessionTreeCaches(): void {
  headerIndexCache = null
  parsedCache.clear()
}

function convertEntry(obj: Record<string, unknown>): { entry: ParsedEntry | null; label?: { targetId: string; label: string } } {
  const type = typeof obj.type === 'string' ? obj.type : ''
  if (type === 'label') {
    return typeof obj.targetId === 'string'
      ? { entry: null, label: { targetId: obj.targetId, label: typeof obj.label === 'string' ? obj.label : '' } }
      : { entry: null }
  }
  if (typeof obj.id !== 'string' || !obj.id) return { entry: null }
  const base = {
    id: obj.id,
    parentId: typeof obj.parentId === 'string' ? obj.parentId : null,
    type,
    ...(typeof obj.timestamp === 'string' ? { timestamp: obj.timestamp } : {}),
  }
  const message = obj.message as Record<string, unknown> | undefined
  switch (type) {
    case 'message': {
      const role = asRole(message?.role)
      const content = message?.content
      const raw = role === 'user' ? stripInjectedBlocks(extractText(content as never)) : extractText(content as never)
      const tools = Array.isArray(content)
        ? content.filter(part => (part as Record<string, unknown>)?.type === 'toolCall').map(part => String((part as Record<string, unknown>).name ?? 'tool'))
        : []
      return {
        entry: {
          ...base,
          kind: tools.length ? 'tool' : 'message',
          ...(role ? { role } : {}),
          title: role === 'user' ? 'User' : role === 'assistant' ? (tools.length ? `Assistant · ${tools.join(', ')}` : 'Assistant') : (role ?? 'Message'),
          ...(clip(raw) ? { preview: clip(raw)! } : {}),
          ...(tools.length ? { tools } : {}),
        },
      }
    }
    case 'branch_summary':
      return { entry: { ...base, kind: 'branchSummary', role: 'system', title: 'Branch summary', ...(clip(String(obj.summary ?? '')) ? { preview: clip(String(obj.summary ?? ''))! } : {}) } }
    case 'compaction':
      return { entry: { ...base, kind: 'compaction', role: 'system', title: 'Compaction', ...(clip(String(obj.summary ?? '')) ? { preview: clip(String(obj.summary ?? ''))! } : {}) } }
    case 'model_change':
      return { entry: { ...base, kind: 'system', role: 'system', title: `Model → ${String(obj.modelId ?? obj.model ?? '')}`.trim() } }
    case 'thinking_level_change':
      return { entry: { ...base, kind: 'system', role: 'system', title: `Thinking → ${String(obj.thinkingLevel ?? '')}`.trim() } }
    case 'session_info':
      return { entry: { ...base, kind: 'system', role: 'system', title: typeof obj.name === 'string' && obj.name ? `Renamed → ${obj.name}` : 'Session info' } }
    case 'custom_message':
      return { entry: { ...base, kind: 'custom', role: 'system', title: String(obj.customType ?? 'custom'), ...(clip(extractText(obj.content as never)) ? { preview: clip(extractText(obj.content as never))! } : {}) } }
    case 'custom':
      return { entry: { ...base, kind: 'custom', role: 'system', title: String(obj.customType ?? 'custom') } }
    default:
      return { entry: { ...base, kind: 'system', role: 'system', title: type || 'entry' } }
  }
}

async function readSessionFile(file: string, size: number): Promise<ParsedFile> {
  const partial = size > SESSION_TREE_MAX_PARSE_BYTES
  const start = partial ? Math.max(0, size - SESSION_TREE_TAIL_BYTES) : 0
  let text = await readSlice(file, start)
  if (start > 0) {
    const newline = text.indexOf('\n')
    text = newline === -1 ? '' : text.slice(newline + 1)
  }
  const entries: ParsedEntry[] = []
  const labels = new Map<string, string>()
  let leafId: string | null = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (!obj || obj.type === 'session') continue
    const { entry, label } = convertEntry(obj)
    if (label) {
      if (label.label) labels.set(label.targetId, label.label)
      else labels.delete(label.targetId)
      continue
    }
    if (!entry) continue
    entries.push(entry)
    leafId = entry.id
  }
  return { file, entries, leafId, labels, partial }
}

async function parseSessionFile(file: string): Promise<ParsedFile> {
  const info = await stat(file)
  const cached = parsedCache.get(file)
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    parsedCache.delete(file)
    parsedCache.set(file, cached)
    return cached.value
  }
  const value = await readSessionFile(file, info.size)
  parsedCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, value })
  while (parsedCache.size > PARSED_CACHE_MAX) {
    const oldest = parsedCache.keys().next().value
    if (oldest === undefined) break
    parsedCache.delete(oldest)
  }
  return value
}

// ── family assembly ──

/** Index of the last entry of the leading run shared with `parentIds`, or -1. */
function lastLeadingSharedIndex(entries: ParsedEntry[], parentIds: Set<string>): number {
  let index = -1
  for (let i = 0; i < entries.length; i += 1) {
    if (!parentIds.has(entries[i].id)) break
    index = i
  }
  return index
}

export async function buildSessionFamilyGraph(options: BuildSessionFamilyOptions): Promise<SessionTreeGraph> {
  const generatedAt = Date.now()
  const empty: SessionTreeGraph = { focusKey: '', sessions: [], detail: options.expandLinearRuns ? 'full' : 'collapsed', nodes: [], truncated: false, generatedAt }

  let focusFile: string
  try {
    focusFile = await resolveSessionFileInScope(options.sessionFile)
  } catch (error) {
    // Scope / existence failures are the caller's problem (403 / 404), not an
    // empty graph: silently returning no nodes would look like "empty session".
    if (error instanceof SessionTreeError) throw error
    return empty
  }

  let headers = await listSessionHeaders()
  if (!headers.has(focusFile)) headers = await listSessionHeaders(true)

  // Parent path → child files, restricted to files we can see in the index.
  const root = sessionsDir()
  const childrenOf = new Map<string, string[]>()
  for (const info of headers.values()) {
    if (!info.parentSession || !info.parentSession.startsWith(root + sep)) continue
    const list = childrenOf.get(info.parentSession)
    if (list) list.push(info.file)
    else childrenOf.set(info.parentSession, [info.file])
  }

  // Ancestors of the focus file (nearest first).
  const ancestors: string[] = []
  const seen = new Set<string>([focusFile])
  let cursor = headers.get(focusFile)?.parentSession ?? null
  while (cursor && headers.has(cursor) && !seen.has(cursor) && ancestors.length < SESSION_TREE_MAX_SESSIONS) {
    seen.add(cursor)
    ancestors.push(cursor)
    cursor = headers.get(cursor)?.parentSession ?? null
  }

  // Descendants (and non-focus-path siblings) breadth-first.
  const descendants: string[] = []
  const queue = [focusFile, ...ancestors]
  while (queue.length) {
    const current = queue.shift() as string
    for (const child of childrenOf.get(current) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      descendants.push(child)
      queue.push(child)
    }
  }
  descendants.sort((a, b) => (headers.get(a)?.timestamp ?? '').localeCompare(headers.get(b)?.timestamp ?? ''))

  let truncated = false
  const ordered = [focusFile, ...ancestors, ...descendants]
  if (ordered.length > SESSION_TREE_MAX_SESSIONS) {
    ordered.length = SESSION_TREE_MAX_SESSIONS
    truncated = true
  }

  const parsedList = await mapLimit(ordered, 8, async file => {
    try {
      return await parseSessionFile(file)
    } catch {
      return null
    }
  })
  const parsedByFile = new Map<string, ParsedFile>()
  for (const parsed of parsedList) if (parsed) parsedByFile.set(parsed.file, parsed)

  // Which session keys are inside the family (so we only skip prefixes whose
  // parent is actually rendered).
  const inFamily = new Set(ordered)
  const parentOf = new Map<string, string>()
  for (const file of ordered) {
    const parent = headers.get(file)?.parentSession
    if (parent && inFamily.has(parent)) parentOf.set(file, parent)
  }

  const sessions: SessionTreeSessionEntry[] = []
  const nodes: SessionTreeNode[] = []
  const anchorIds = new Set<string>()
  const firstNodeIds = new Set<string>()
  const childFirstNodeId = new Map<string, string>() // child file → its first rendered node id
  const firstNodeOf = new Map<string, string>()      // file → first rendered node id

  for (const file of ordered) {
    const header = headers.get(file)
    const parsed = parsedByFile.get(file)
    const key = sessionKeyForFile(file)
    const rawParent = header?.parentSession ?? null
    const parentFile = parentOf.get(file)
    const parentParsed = parentFile ? parsedByFile.get(parentFile) : undefined
    const parentIds = parentParsed ? new Set(parentParsed.entries.map(entry => entry.id)) : undefined

    let entries = parsed?.entries ?? []
    let anchorId: string | null = null
    let skip = -1
    if (parsed && parentIds && parentIds.size) skip = lastLeadingSharedIndex(entries, parentIds)
    if (skip >= 0) {
      anchorId = entries[skip].id
      entries = entries.slice(skip + 1)
    }

    const localIds = new Set(entries.map(entry => entry.id))
    const sessionNodes = entries.map((entry): SessionTreeNode => ({
      id: entry.id,
      parentId: entry.parentId && localIds.has(entry.parentId) ? entry.parentId : null,
      kind: entry.kind,
      sessionKey: key,
      ...(entry.role ? { role: entry.role } : {}),
      type: entry.type,
      ...(parsed?.labels.has(entry.id) ? { label: parsed.labels.get(entry.id) } : {}),
      title: entry.title,
      ...(entry.preview ? { preview: entry.preview } : {}),
      ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
      ...(entry.tools ? { tools: entry.tools } : {}),
      childCount: 0,
      isLeaf: false,
      isHead: false,
    }))

    const fallbackAnchor = anchorId ?? (parentParsed?.leafId ?? null)
    if (sessionNodes.length) {
      if (fallbackAnchor && localIds.has(fallbackAnchor) === false) sessionNodes[0].parentId = fallbackAnchor
      firstNodeOf.set(file, sessionNodes[0].id)
      // The session's start point must survive linear folding (see collapseLinearRuns).
      firstNodeIds.add(sessionNodes[0].id)
      if (parentFile) childFirstNodeId.set(parentFile, sessionNodes[0].id)
    }
    if (anchorId) anchorIds.add(anchorId)

    sessions.push({
      key,
      file,
      sessionId: header?.sessionId ?? null,
      ...(header?.cwd ? { cwd: header.cwd } : {}),
      ...(header?.timestamp ? { timestamp: header.timestamp } : {}),
      entryCount: parsed?.entries.length ?? 0,
      leafId: parsed?.leafId ?? null,
      isFocus: file === focusFile,
      ...(header?.sessionId && options.liveSessionIds?.has(header.sessionId) ? { isLive: true } : {}),
      // Kept even when the parent file is gone, so the UI can still say "forked
      // from X"; `forkAnchorId` stays null because the prefix could not be matched.
      ...(rawParent ? { forkOf: sessionKeyForFile(rawParent), forkAnchorId: anchorId } : {}),
      ...(parsed?.partial ? { partial: true } : {}),
    })

    nodes.push(...sessionNodes)
  }

  // Global child counts (cross-session anchor edges included), computed before
  // any node-cap truncation so branch nodes are not mislabelled as leaves.
  const nodeIds = new Set(nodes.map(node => node.id))
  const childCount = new Map<string, number>()
  for (const node of nodes) {
    if (node.parentId && nodeIds.has(node.parentId)) childCount.set(node.parentId, (childCount.get(node.parentId) ?? 0) + 1)
  }
  const leafOfSession = new Map(sessions.map(session => [session.key, session.leafId]))
  for (const node of nodes) {
    node.childCount = childCount.get(node.id) ?? 0
    node.isLeaf = node.childCount === 0
    node.isHead = leafOfSession.get(node.sessionKey) === node.id
    if (anchorIds.has(node.id)) node.isForkAnchor = true
  }

  if (nodes.length > SESSION_TREE_MAX_NODES) {
    // Keep whole sessions from the front (focus first) so edges stay intact.
    const keptSessions = new Set<string>()
    let budget = SESSION_TREE_MAX_NODES
    for (const session of sessions) {
      const size = nodes.reduce((total, node) => total + (node.sessionKey === session.key ? 1 : 0), 0)
      if (keptSessions.size && size > budget) break
      keptSessions.add(session.key)
      budget -= size
    }
    for (let i = nodes.length - 1; i >= 0; i -= 1) if (!keptSessions.has(nodes[i].sessionKey)) nodes.splice(i, 1)
    for (let i = sessions.length - 1; i >= 0; i -= 1) if (!keptSessions.has(sessions[i].key)) sessions.splice(i, 1)
    truncated = true
  }

  return {
    focusKey: ordered.includes(focusFile) ? sessionKeyForFile(focusFile) : '',
    sessions,
    detail: options.expandLinearRuns ? 'full' : 'collapsed',
    nodes: options.expandLinearRuns
      ? nodes
      : collapseLinearRuns(nodes, firstNodeIds, options.expandRuns, clampStepLimit(options.expandStepLimit)),
    truncated,
    generatedAt,
  }
}

// ── turns ──

function textOf(node: SessionTreeNode | undefined): string | undefined {
  if (!node) return undefined
  const text = (node.preview ?? '').split('\n')[0]?.trim()
  return text ? text : undefined
}

/**
 * Collapse ONE agent turn — a user request plus everything the agent did for it
 * (thinking, tool calls, telemetry, replies) — into a single readable row.
 *
 * `coveredCount` keeps the honest bookkeeping: the row says 1 turn but may stand
 * for dozens of records, and the panel reports how many were folded into it.
 */
function turnNode(bucket: SessionTreeNode[]): SessionTreeNode {
  const first = bucket[0]!
  const user = bucket.find(node => node.role === 'user')
  const replies = bucket.filter(node => node.role === 'assistant')
  const tools = [...new Set(bucket.flatMap(node => node.tools ?? []))]
  const request = textOf(user) ?? textOf(first)
  const reply = [...replies].reverse().map(node => textOf(node)).find(Boolean)
  const anchor = user ?? first
  const label = user ? 'User' : replies.length ? (tools.length ? `Assistant · ${tools.join(', ')}` : 'Assistant') : anchor.title
  return {
    ...anchor,
    parentId: anchor.parentId,
    kind: user && !tools.length ? 'message' : tools.length ? 'tool' : 'message',
    role: user ? 'user' : replies.length ? 'assistant' : 'system',
    type: 'turn',
    title: label,
    ...(request ? { preview: request } : {}),
    ...(reply ? { reply } : {}),
    ...(tools.length ? { tools } : {}),
    coveredCount: bucket.length,
    childCount: 0,
    isLeaf: false,
    isHead: false,
  }
}

/**
 * Group a run's entries into AGENT TURNS.
 *
 * A reader does not care that “Thinking → max” or `compact-thinking-duration` was
 * its own record, so a step in the graph means a turn: 15 records of a short session
 * are really ~4 exchanges. A user message opens a new turn; a compaction also breaks
 * one (it is a context reset, not part of the running exchange). Records before the
 * first request — a model switch, a thinking level — are that request's prelude, so
 * they are folded into it rather than becoming a step of their own.
 */
export function turnSteps(entries: SessionTreeNode[]): SessionTreeNode[] {
  const turns: SessionTreeNode[] = []
  let bucket: SessionTreeNode[] = []
  /** A bucket is a real turn once it holds a request (or a context reset). */
  const opened = (nodes: SessionTreeNode[]): boolean =>
    nodes.some(node => node.role === 'user' || node.kind === 'compaction')
  const flush = (): void => {
    if (bucket.length) turns.push(turnNode(bucket))
    bucket = []
  }
  for (const entry of entries) {
    // Entries before the first request (model switch, thinking level, session info) are
    // the PRELUDE of that request, not a step of their own, so they stay in the bucket.
    const startsTurn = entry.role === 'user' || entry.kind === 'compaction'
    if (startsTurn && opened(bucket)) flush()
    bucket.push(entry)
  }
  flush()
  return turns
}

// ── linear-run collapsing ──

/**
 * Fold linear stretches so a conversation does not turn into hundreds of cards.
 *
 * A node survives only when it is STRUCTURAL — navigation-relevant:
 * - the first node of a session (the start point) and its head/leaf (the end point)
 * - a branch point (`childCount !== 1`): where the tree actually forks
 * - a fork anchor (where a child session was forked off)
 * - a pi `label` bookmark
 * - a compaction / branch-summary marker (context boundaries)
 *
 * Everything else (plain user/assistant turns and tool steps) is absorbed into a
 * single `collapsed` node, so a purely linear session renders as exactly
 * start → +N 轮 → end. `N` counts **agent turns**, not records: thinking, tool calls,
 * telemetry and model switches belong to the turn they happened in.
 *
 * @param keepIds ids that must stay visible even when structurally foldable
 *                (used for each session's start node).
 */
export function collapseLinearRuns(
  nodes: SessionTreeNode[],
  keepIds?: Set<string>,
  expandRuns?: Set<string>,
  stepLimit: number = SESSION_TREE_STEPS_DEFAULT,
): SessionTreeNode[] {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const children = new Map<string, SessionTreeNode[]>()
  for (const node of nodes) {
    if (!node.parentId || !byId.has(node.parentId)) continue
    const list = children.get(node.parentId)
    if (list) list.push(node)
    else children.set(node.parentId, [node])
  }
  const structural = (node: SessionTreeNode): boolean =>
    node.childCount !== 1 || node.isLeaf || node.isHead || node.isForkAnchor === true ||
    node.label !== undefined || keepIds?.has(node.id) === true ||
    node.kind === 'branchSummary' || node.kind === 'compaction' || node.kind === 'collapsed'

  const out: SessionTreeNode[] = []
  const consumed = new Set<string>()

  const visit = (start: SessionTreeNode, parentOverride?: string): void => {
    if (consumed.has(start.id)) return
    consumed.add(start.id)
    out.push(parentOverride ? { ...start, parentId: parentOverride } : start)

    const chain: SessionTreeNode[] = []
    let current = start
    for (;;) {
      const kids = (children.get(current.id) ?? []).filter(child => !consumed.has(child.id))
      if (kids.length !== 1) break
      const kid = kids[0]
      if (structural(kid)) break
      chain.push(kid)
      consumed.add(kid.id)
      current = kid
    }

    if (chain.length >= SESSION_TREE_LINEAR_RUN_MIN) {
      // Fold the WHOLE run into one node and hang the run's children off it, so a
      // linear session becomes start → +N 轮 → end instead of start → +N → step → end.
      const head = chain[0]
      const tail = chain[chain.length - 1]
      const collapsedId = `run:${head.id}`
      const expanded = expandRuns?.has(collapsedId) === true
      const turns = turnSteps(chain)
      const firstText = textOf(turns[0])
      const lastText = textOf(turns[turns.length - 1])
      const span = firstText && lastText && firstText !== lastText ? `${firstText} → ${lastText}` : (firstText ?? '')
      out.push({
        id: collapsedId,
        parentId: start.id,
        kind: 'collapsed',
        sessionKey: start.sessionKey,
        type: 'collapsed',
        title: `+${turns.length} 轮`,
        ...(span ? { preview: span } : {}),
        childCount: 1,
        isLeaf: false,
        isHead: false,
        collapsedCount: turns.length,
        collapsedRange: { from: head.id, to: tail.id },
        // In-place expansion: keep ONE graph node, carry the real turns as nested
        // data so the canvas layout stays small. A row keeps the turn's first entry
        // id so clicking it can select/navigate that exact entry.
        ...(expanded ? {
          expanded: true,
          steps: turns.slice(0, stepLimit),
          ...(turns.length > stepLimit ? { stepsTruncated: true } : {}),
        } : {}),
      })
      for (const kid of children.get(tail.id) ?? []) visit(kid, collapsedId)
    } else {
      out.push(...chain)
      const last = chain.length ? chain[chain.length - 1] : start
      for (const kid of children.get(last.id) ?? []) visit(kid)
    }

    for (const kid of children.get(start.id) ?? []) {
      if (chain.length && kid.id === chain[0].id) continue
      visit(kid)
    }
  }

  for (const node of nodes) {
    if (!node.parentId || !byId.has(node.parentId)) visit(node)
  }
  for (const node of nodes) if (!consumed.has(node.id)) out.push(node)
  return out
}