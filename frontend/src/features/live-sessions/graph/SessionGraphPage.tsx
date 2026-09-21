import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { SessionTreeNode, SessionTreeSessionEntry } from '@shared/session-tree'
import { useAppDispatch, useAppSelector } from '../../../store'
import { authenticated } from '../../../store/liveSessionsSlice'
import { AuthPanel } from '../LiveSessionPage'
import { liveSessionApi } from '../api'
import { useLiveSessionsRuntime } from '../useLiveSessions'
import { buildSessionTitles } from '../sessionTitle'
import BranchDetailPanel from './BranchDetailPanel'
import SessionFamilyGraph, { type GraphDetail } from './SessionFamilyGraph'
import { useSessionTree } from './useSessionTree'
import { GRAPH_NODE_VIEW_CYCLE, applyNodeView, graphNodeViewLabel, type GraphNodeView } from './nodeView'

function baseName(file: string): string {
  const tail = file.split('/').pop() ?? file
  return tail.replace(/\.jsonl$/, '')
}

/** One “加载更多” click loads this many more steps per expanded run. */
const STEP_BATCH = 400
/** Mirrors the server's `SESSION_TREE_STEPS_MAX`. */
const STEP_LIMIT_MAX = 3000
/** How long to wait for a forked session file to appear on disk. */
const PENDING_FILE_POLL_MS = 2000
const PENDING_FILE_MAX_TRIES = 30

/**
 * Outcome of a `/ls-fork` or `/ls-navigate`, published by the Pi extension as a
 * `tree_action` event. The extension reports its real result because the graph
 * page cannot know whether pi refused the action (busy, stale entry id) — that
 * used to be a terminal-only `notify`, invisible in the browser.
 */
export interface TreeActionOutcome {
  action: 'fork' | 'navigate'
  ok: boolean
  entryId: string
  message: string
  at: number
  sessionFile?: string
  filePending?: boolean
}

/**
 * Why the graph's write actions cannot run right now, or `undefined` when they can.
 *
 * Must never return nothing-but-``: a click used to hit `if (!live || !treeCapable) return`,
 * which looked exactly like a broken button.
 */
export function graphWriteBlockReason(input: {
  live: boolean
  treeCapable: boolean
  claimedByOther: boolean
}): string | undefined {
  if (!input.live) return '这个会话没有在线的 Pi 进程，图谱写操作不可用（只能看图）。'
  if (input.claimedByOther) return '该会话已被另一个浏览器接管，写操作已禁用：刷新页面重新接管后再操作。'
  if (!input.treeCapable) {
    return '当前 Pi 进程加载的是旧版 live-session 扩展（没有声明 session_tree 能力），图谱写操作不可用。请在该 Pi 会话里执行一次 /reload（或重启该会话）后重试。'
  }
  return undefined
}

/** Success goes to the toast, refusal goes to the error strip — never nowhere. */
export function treeActionFeedback(outcome: TreeActionOutcome): { toast?: string; error?: string } {
  return outcome.ok ? { toast: outcome.message } : { error: outcome.message }
}

/**
 * What to do when the pi process we are watching reports a different session file.
 *
 * `/ls-fork` keeps the SAME pi process and gives it a NEW session file, so a fork is
 * only observable as a changed `sessionFile`. After a fork the reader wants to be in
 * the new branch's agent page at the entry they forked at; a plain session swap
 * (terminal `/tree` + `resume`) should instead keep the graph and just follow.
 */
export function followSessionFile(
  processInstanceId: string,
  nextFile: string,
  forkEntryId: string | null,
): { kind: 'navigate'; to: string } | { kind: 'follow'; file: string } {
  if (forkEntryId) {
    // The fork copies the prefix with the same entry ids, so `?node=` still matches.
    return {
      kind: 'navigate',
      to: `/live-sessions/${encodeURIComponent(processInstanceId)}?node=${encodeURIComponent(forkEntryId)}`,
    }
  }
  return { kind: 'follow', file: nextFile }
}

export default function SessionGraphPage() {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const { refresh } = useLiveSessionsRuntime()
  const [params, setParams] = useSearchParams()
  const state = useAppSelector(root => root.liveSessions)
  const titles = useMemo(() => buildSessionTitles(state.sessions, state.details), [state.sessions, state.details])

  const file = params.get('file')
  const nodeParam = params.get('node')
  // `collapsed` (default) folds linear runs so a conversation reads as
  // start → +N 轮 → end; `full` returns every entry for record-level inspection.
  const [nodeView, setNodeView] = useState<GraphNodeView>('ends')
  /** Only 逐条记录 needs the server to return every entry. */
  const detail: GraphDetail = nodeView === 'full' ? 'full' : 'collapsed'
  /** Folded runs expanded in place (their steps render inside the card). */
  const [expandedRuns, setExpandedRuns] = useState<string[]>([])
  /** Per-run step window; “加载更多” raises it by one batch (server clamps to 3000). */
  const [stepLimit, setStepLimit] = useState(STEP_BATCH)
  const { graph: fullGraph, loading, error, refresh: reload } = useSessionTree(file, detail, expandedRuns, stepLimit)
  /**
   * 骨架视图：只留结构点（起点、各会话首节点、分叉点、当前点、标注），中间步骤的
   * 数量标在边上（`+N 轮`）。没有分叉的会话因此只剩“起点 → 现在”两张卡片。
   */
  const view = useMemo(
    () => (fullGraph ? applyNodeView(fullGraph.nodes, fullGraph.sessions, nodeView) : null),
    [fullGraph, nodeView],
  )
  const graph = useMemo(
    () => (fullGraph ? { ...fullGraph, nodes: view?.nodes ?? fullGraph.nodes } : null),
    [fullGraph, view],
  )

  const [selectedId, setSelectedId] = useState<string | null>(nodeParam)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  /**
   * A fork whose new session file is not on disk yet. pi defers that file until
   * the new session produces its first assistant message, and the graph is read
   * from disk — so jumping immediately would land on an empty/404 page and look
   * like the fork never happened.
   */
  const [pendingFile, setPendingFile] = useState<{ processInstanceId: string; file: string; entryId: string } | null>(null)

  // After `/ls-fork` the bridge swaps to a NEW session file, so the URL's `file`
  // goes stale: the graph would neither refresh nor keep its write actions. Follow
  // the process we were watching to whatever session file it now reports.
  const followedProcess = useRef<string | null>(null)
  /**
   * Entry id the user forked at, while waiting for the snapshot that swaps the
   * session file. `/ls-fork` creates a NEW session file for the SAME pi process, so
   * the fork is only observable as a changed `sessionFile` on that process.
   */
  const pendingForkRef = useRef<string | null>(null)
  useEffect(() => {
    if (!file) { followedProcess.current = null; return }
    const owner = Object.values(state.sessions).find(session => session.sessionFile === file)
    if (owner) followedProcess.current = owner.processInstanceId
  }, [file, state.sessions])
  useEffect(() => {
    const processInstanceId = followedProcess.current
    if (!processInstanceId) return
    const nextFile = state.sessions[processInstanceId]?.sessionFile
    if (!nextFile || nextFile === file) return
    const forkEntryId = pendingForkRef.current
    pendingForkRef.current = null
    const plan = followSessionFile(processInstanceId, nextFile, forkEntryId)
    if (plan.kind === 'navigate') {
      // pi defers the forked file until the new session's first reply, so wait
      // for it instead of jumping to a graph that cannot be read yet.
      setPendingFile({ processInstanceId, file: nextFile, entryId: forkEntryId ?? '' })
      return
    }
    setParams({ file: plan.file })
    setToast(`已跟随到新会话：${plan.file.split('/').pop() ?? plan.file}`)
  }, [state.sessions, file, setParams, navigate])

  // In-place expansions belong to one session file: drop them when the focus moves.
  useEffect(() => { setExpandedRuns([]); setStepLimit(STEP_BATCH) }, [file])

  const toggleExpand = useCallback((node: SessionTreeNode) => {
    setSelectedId(node.id)
    setExpandedRuns(list => list.includes(node.id) ? list.filter(id => id !== node.id) : [...list, node.id])
    setStepLimit(STEP_BATCH)
  }, [])

  const loadMoreSteps = useCallback((node: SessionTreeNode) => {
    setSelectedId(node.id)
    setStepLimit(current => Math.min(STEP_LIMIT_MAX, Math.max(current, node.steps?.length ?? 0) + STEP_BATCH))
  }, [])
  const [toast, setToast] = useState<string | null>(null)
  const [undo, setUndo] = useState<{ headId: string; label: string } | null>(null)
  const [manualPath, setManualPath] = useState('')

  // The live process (if any) that owns the focused file. Matching by sessionId
  // first is deliberate: the URL carries the path exactly as the bridge reported
  // it, which can differ from the realpath spelling the graph payload returns, and
  // a path mismatch would wrongly disable every write action.
  const live = useMemo(() => {
    if (!file) return undefined
    const focusSessionId = graph?.sessions.find(session => session.isFocus)?.sessionId
    if (focusSessionId) {
      const bySessionId = Object.values(state.sessions).find(session => session.sessionId === focusSessionId)
      if (bySessionId) return bySessionId
    }
    return Object.values(state.sessions).find(session => session.sessionFile === file)
  }, [file, graph, state.sessions])

  const ownedLease = live ? state.ownedLeases[live.processInstanceId] : undefined
  const claimedByOther = live?.claim.state === 'claimed' && !ownedLease
  // Write actions must never be sent to a bridge that does not register
  // `/ls-navigate` — pi would submit the text as a normal model prompt.
  const treeCapable = live?.capabilities?.includes('session_tree') === true
  const capabilityBlocked = live && !treeCapable
    ? '当前 Pi 进程加载的是旧版扩展，不支持图谱写操作。请先在该会话里执行 /reload（或重启该会话）再试。'
    : undefined

  // Keep the selection valid across refetches (a navigate/fork changes the tree).
  useEffect(() => {
    if (!graph) return
    const ids = new Set(graph.nodes.map(node => node.id))
    const preferred = nodeParam && ids.has(nodeParam) ? nodeParam : null
    if (preferred) { setSelectedId(preferred); return }
    if (selectedId && ids.has(selectedId)) return
    const head = graph.nodes.find(node => node.sessionKey === graph.focusKey && node.isHead)
    setSelectedId(head?.id ?? graph.nodes[0]?.id ?? null)
  }, [graph, nodeParam, selectedId])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(timer)
  }, [toast])

  const selectedNode = useMemo(() => {
    if (!graph || !selectedId) return null
    const direct = graph.nodes.find(node => node.id === selectedId)
    if (direct) return direct
    // A step row inside an expanded run is not a top-level node, but selecting it must
    // still fill the panel (and enable 切到此处 / 从此分叉 on that exact entry).
    for (const node of graph.nodes) {
      const step = node.steps?.find(candidate => candidate.id === selectedId)
      if (step) return step
    }
    return null
  }, [graph, selectedId])
  // Synthetic ids from folded linear runs (`run:<headId>`) are display-only: they
  // are not real entry ids, so they must never reach `/ls-navigate`.
  const actionableNodeId = selectedId && !selectedId.startsWith('run:') ? selectedId : null

  const runCommand = useCallback(async (text: string, successMessage: string, undoHeadId?: string | null) => {
    // Never fail silently: a greyed-out or capability-less action used to just
    // `return`, so a click looked like a broken button with no explanation.
    const blocked = graphWriteBlockReason({
      live: Boolean(live),
      treeCapable: Boolean(treeCapable),
      claimedByOther: Boolean(live?.claim.state === 'claimed' && !ownedLease),
    })
    if (blocked || !live) {
      setActionError(blocked ?? '图谱写操作不可用。')
      setToast(null)
      return
    }
    setBusy(true)
    setActionError(undefined)
    try {
      const suffix = ownedLease ? ` ${ownedLease}` : ''
      await liveSessionApi.sessionTreeAction(live.processInstanceId, `${text}${suffix}`)
      // The request is only an “accepted”: whether pi honoured it arrives as a
      // `tree_action` event, which sets the real toast or error below.
      setToast(successMessage)
      if (undoHeadId !== undefined) setUndo(undoHeadId ? { headId: undoHeadId, label: successMessage } : null)
      reload()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setActionError(message)
      setToast(null)
    } finally {
      setBusy(false)
    }
  }, [live, treeCapable, ownedLease, reload])

  /**
   * Show what pi actually did with the last `/ls-*` action.
   *
   * This is the only channel that can report a refusal the browser cannot
   * predict (session busy, stale entry id, fork deferred to disk), so it replaces
   * the optimistic toast as soon as it arrives.
   */
  const lastTreeAction = useAppSelector(state => {
    if (!live) return undefined
    const entries = state.liveSessions.details[live.processInstanceId]?.entries ?? []
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index] as { type?: unknown; data?: unknown } | null
      if (entry?.type !== 'tree_action') continue
      const data = entry.data as TreeActionOutcome | undefined
      if (data && typeof data.at === 'number') return data
    }
    return undefined
  })
  const shownTreeActionRef = useRef(0)
  useEffect(() => {
    if (!lastTreeAction || lastTreeAction.at === shownTreeActionRef.current) return
    shownTreeActionRef.current = lastTreeAction.at
    const feedback = treeActionFeedback(lastTreeAction)
    if (feedback.toast) {
      setActionError(undefined)
      setToast(feedback.toast)
      return
    }
    setToast(null)
    setActionError(feedback.error)
  }, [lastTreeAction])

  // Wait for a forked session file to land on disk, then jump to it.
  useEffect(() => {
    if (!pendingFile) return
    let cancelled = false
    let tries = 0
    const poll = (): void => {
      liveSessionApi.sessionTree(pendingFile.file)
        .then(() => {
          if (cancelled) return
          setPendingFile(null)
          setToast(null)
          navigate(`/live-sessions/${encodeURIComponent(pendingFile.processInstanceId)}?node=${encodeURIComponent(pendingFile.entryId)}`)
        })
        .catch(() => {
          if (cancelled) return
          tries += 1
          if (tries >= PENDING_FILE_MAX_TRIES) {
            setPendingFile(null)
            setActionError(`分叉已创建，但新会话文件 ${pendingFile.file.split('/').pop()} 还没写入磁盘；在它产出第一条回复后重新打开此页就能看到。`)
            return
          }
          timer = setTimeout(poll, PENDING_FILE_POLL_MS)
        })
    }
    let timer = setTimeout(poll, 600)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [pendingFile, navigate])

  const handleNavigate = useCallback((node: SessionTreeNode) => {
    const previousHead = graph?.nodes.find(candidate => candidate.sessionKey === graph.focusKey && candidate.isHead)?.id ?? null
    // pi confirms via `tree_action`; this is only the request echo.
    void runCommand(`/ls-navigate ${node.id}`, `已请求切换到 ${node.id}，等待 pi 确认…`, previousHead)
  }, [graph, runCommand])

  const handleFork = useCallback((node: SessionTreeNode) => {
    pendingForkRef.current = node.id
    // pi confirms via `tree_action`. Keep the echo honest: a refused fork must not
    // look successful while the confirmation is still in flight.
    void runCommand(`/ls-fork ${node.id}`, `已请求从 ${node.id} 分叉，等待 pi 确认…`, undefined)
  }, [runCommand])

  const handleOpenSession = useCallback((session: SessionTreeSessionEntry) => {
    const owner = Object.values(state.sessions).find(candidate => candidate.sessionFile === session.file)
    if (owner) {
      navigate(`/live-sessions/${encodeURIComponent(owner.processInstanceId)}${actionableNodeId ? `?node=${encodeURIComponent(actionableNodeId)}` : ''}`)
      return
    }
    // Not running: refocus the graph on that file instead of opening a transcript.
    setParams({ file: session.file, ...(actionableNodeId ? { node: actionableNodeId } : {}) })
    setToast(`该会话未运行，已在图谱中定位：${baseName(session.file)}`)
  }, [navigate, actionableNodeId, setParams, state.sessions])

  if (state.auth === 'checking') return <div className="flex flex-1 items-center justify-center text-muted">检查 Live Session 认证…</div>
  if (state.auth === 'required') return <AuthPanel onAuthenticated={browserClientId => { dispatch(authenticated({ browserClientId })); void refresh() }} />

  // ── No focus yet: pick a session ──
  if (!file) {
    const candidates = Object.values(state.sessions).filter(session => session.sessionFile)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-bg p-4 md:p-6">
        <header className="mb-4">
          <h1 className="text-lg font-semibold text-text-strong">会话家族图谱</h1>
          <p className="mt-1 text-xs text-muted">选择要查看的会话。图谱按 fork 关系把同一家族的会话文件画成一棵树。</p>
        </header>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input
            value={manualPath}
            onChange={event => setManualPath(event.target.value)}
            placeholder="或直接粘贴会话文件绝对路径"
            className="min-w-[280px] flex-1 rounded border border-border bg-card px-3 py-2 font-mono text-xs text-text outline-none focus:border-accent"
          />
          <button
            type="button"
            disabled={!manualPath.trim()}
            onClick={() => setParams({ file: manualPath.trim() })}
            className="rounded border border-border bg-card px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
          >打开</button>
        </div>
        {candidates.length === 0
          ? <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted">当前没有运行中的会话（带 session 文件）。可从任意会话页点「在图谱中查看」进入。</div>
          : <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {candidates.map(session => (
                <button
                  key={session.processInstanceId}
                  type="button"
                  onClick={() => setParams({ file: session.sessionFile as string })}
                  className="rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-accent hover:bg-accent-subtle"
                >
                  <div className="truncate text-sm font-semibold text-text-strong">
                    {titles[session.processInstanceId] || session.sessionName || `Pi ${session.pid}`}
                  </div>
                  <div className="mt-2 truncate text-xs text-muted" title={session.canonicalCwd}>{session.canonicalCwd}</div>
                  <div className="mt-1 truncate font-mono text-2xs text-muted">{baseName(session.sessionFile as string)}</div>
                </button>
              ))}
            </div>}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-body-s font-semibold text-text-strong">
            {live ? (titles[live.processInstanceId] || live.sessionName || `Pi ${live.pid}`) : baseName(file)}
          </h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-2xs text-muted">
            <span className="font-mono">{baseName(file)}</span>
            {graph ? <span>{graph.sessions.length} 会话 · {graph.nodes.length} 节点</span> : null}
            {view && view.hiddenSteps > 0 ? <span>中间 {view.hiddenSteps} 轮已折叠在边上</span> : null}
            {live
              ? <span className={live.status === 'running' ? 'text-accent' : 'text-ok'}>{live.status === 'running' ? '工作中' : '空闲'}</span>
              : <span className="text-warn">未运行</span>}
            {graph?.truncated ? <span className="text-warn">已截断</span> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setExpandedRuns([])
              setNodeView(current => GRAPH_NODE_VIEW_CYCLE[(GRAPH_NODE_VIEW_CYCLE.indexOf(current) + 1) % GRAPH_NODE_VIEW_CYCLE.length])
            }}
            className={`rounded border px-2.5 py-1 text-2xs transition-colors ${nodeView === 'full' ? 'border-accent bg-accent-subtle text-accent' : 'border-border bg-card text-muted hover:border-accent'}`}
            title={
              nodeView === 'ends' ? '骨架：只显示起点/分叉点/当前，中间轮数标在边上（默认）'
                : nodeView === 'key' ? '关键节点：折叠段、总结与标注都画出来'
                  : '显示每一条原始记录（thinking/工具调用都在，大会话会很慢）'
            }
          >◈ {graphNodeViewLabel(nodeView)}</button>
          <button
            type="button"
            onClick={reload}
            className="rounded border border-border bg-card px-2.5 py-1 text-2xs text-muted transition-colors hover:border-accent hover:text-accent"
          >刷新</button>
          {live ? (
            <button
              type="button"
              onClick={() => navigate(`/live-sessions/${encodeURIComponent(live.processInstanceId)}${actionableNodeId ? `?node=${encodeURIComponent(actionableNodeId)}` : ''}`)}
              className="rounded border border-border bg-card px-2.5 py-1 text-2xs text-muted transition-colors hover:border-accent hover:text-accent"
            >打开会话</button>
          ) : null}
          <button
            type="button"
            onClick={() => { setParams({}) }}
            className="rounded border border-border bg-card px-2.5 py-1 text-2xs text-muted transition-colors hover:border-accent hover:text-accent"
          >换会话</button>
        </div>
      </header>

      {graph?.truncated ? (
        <div className="bg-warn-subtle px-4 py-2 text-2xs text-text">
          图谱已截断：家族会话数或节点数超过上限（当前 {graph.sessions.length} 个会话 / {graph.nodes.length} 个节点）。长线性段已折叠为「⋯」。
        </div>
      ) : null}
      {capabilityBlocked || claimedByOther ? (
        <div className="bg-warn-subtle px-4 py-2 text-2xs text-text">
          {claimedByOther
            ? '⚠ 写操作已禁用：该会话已被另一个浏览器接管（当前浏览器未持有 lease）。'
            : '⚠ 写操作已禁用：当前 Pi 进程加载的是旧版 live-session 扩展（没有 session_tree 能力）。请在右侧面板之外，于该 Pi 会话里执行一次 /reload（或重启该会话），然后刷新本页。'}
        </div>
      ) : null}
      {pendingFile ? (
        <div className="bg-accent-subtle px-4 py-2 text-2xs text-text">
          已分叉：pi 已切到新会话，正在等待它的文件落盘（{(pendingFile.file.split('/').pop() ?? '').slice(0, 46)}）⋯ 该文件会随新会话的第一条回复生成。
        </div>
      ) : null}
      {live && live.sessionFile && graph && graph.sessions.find(session => session.isFocus)?.partial ? (
        <div className="bg-warn-subtle px-4 py-2 text-2xs text-text">
          该会话文件过大，只解析了尾部窗口：图上半部分的历史节点未全部载入。
        </div>
      ) : null}
      {error ? (
        <div className="bg-danger-subtle px-4 py-2 text-2xs text-text">读取图谱失败：{error}</div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1">
          {loading && !graph ? (
            <div className="flex h-full items-center justify-center text-body-s text-muted">加载会话家族图谱…</div>
          ) : graph && graph.nodes.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <div className="text-body-s text-text">该会话还没有可显示的节点</div>
              <div className="text-2xs text-muted">
                可能是 --no-session 启动、文件为空，或该会话只写了文件头。
              </div>
            </div>
          ) : graph ? (
            <SessionFamilyGraph
              graph={graph}
              selectedId={selectedId}
              onSelect={node => setSelectedId(node.id)}
              onOpenSession={handleOpenSession}
              onToggleExpand={toggleExpand}
              onLoadMore={loadMoreSteps}
              edgeBadges={view?.badges}
              onShowMiddle={() => setNodeView('key')}
            />
          ) : (
            // Never leave the canvas silently blank: a failed fetch (e.g. a backend
            // that predates /api/session-tree) must say so here, not just in a banner.
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <div className="text-body-s font-medium text-text">无法加载会话图谱</div>
              <div className="max-w-md text-2xs leading-relaxed text-muted">{error ?? '未知错误'}</div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={reload}
                  className="rounded border border-border bg-card px-3 py-1.5 text-2xs text-muted transition-colors hover:border-accent hover:text-accent"
                >重试</button>
                <button
                  type="button"
                  onClick={() => { setParams({}) }}
                  className="rounded border border-border bg-card px-3 py-1.5 text-2xs text-muted transition-colors hover:border-accent hover:text-accent"
                >换会话</button>
              </div>
            </div>
          )}

          {toast ? (
            <div className="pointer-events-none absolute bottom-16 left-1/2 -translate-x-1/2 rounded-md border border-border bg-panel px-3 py-1.5 text-2xs text-text shadow-lg">
              {toast}
            </div>
          ) : null}

          {undo ? (
            <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-md border border-border bg-panel px-3 py-2 shadow-lg">
              <span className="text-2xs text-muted">{undo.label} · 需要回退？</span>
              <button
                type="button"
                onClick={() => void runCommand(`/ls-navigate ${undo.headId}`, '已回退到原来的位置', null)}
                className="rounded border-none bg-accent px-2.5 py-1 text-2xs font-medium text-accent-fg"
              >撤销</button>
              <button
                type="button"
                onClick={() => setUndo(null)}
                className="rounded border-none bg-transparent text-2xs text-muted hover:text-text"
              >收起</button>
            </div>
          ) : null}
        </div>

        {graph ? (
          <BranchDetailPanel
            node={selectedNode}
            graph={graph}
            action={{
              ...(live ? { processInstanceId: live.processInstanceId } : {}),
              busy,
              ...(actionError ? { error: actionError } : {}),
              ...(claimedByOther ? { blockedReason: '该会话已被另一个浏览器接管（未持有 lease），写操作已禁用。' } : {}),
              ...(capabilityBlocked && !claimedByOther ? { blockedReason: capabilityBlocked } : {}),
            }}
            onNavigate={handleNavigate}
            onFork={handleFork}
            onOpenSession={handleOpenSession}
            onToggleExpand={toggleExpand}
            onClose={() => setSelectedId(null)}
          />
        ) : null}
      </div>
    </div>
  )
}