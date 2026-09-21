import { useState } from 'react'
import type { SessionTreeGraph, SessionTreeNode, SessionTreeSessionEntry } from '@shared/session-tree'
import { NODE_H } from './layout'

const ROLE_ICONS: Record<string, string> = {
  user: '👤',
  assistant: '🤖',
  tool: '🛠',
  system: '⚙',
  compaction: '📦',
  branchSummary: '📋',
  custom: '✦',
  collapsed: '⋯',
}

export interface BranchActionState {
  /** Live process that owns the focused session, if any. */
  processInstanceId?: string
  /** True while a `/ls-navigate` request is in flight. */
  busy: boolean
  /** Set when the last action failed (e.g. lease expired, session busy). */
  error?: string
  /** Set when the session is claimed by another browser. */
  blockedReason?: string
}

export default function BranchDetailPanel({ node, graph, action, onNavigate, onFork, onOpenSession, onToggleExpand, onClose }: {  node: SessionTreeNode | null
  graph: SessionTreeGraph
  action: BranchActionState
  onNavigate: (node: SessionTreeNode) => void
  onFork: (node: SessionTreeNode) => void
  onOpenSession: (session: SessionTreeSessionEntry) => void
  onToggleExpand: (node: SessionTreeNode) => void
  onClose: () => void
}) {
  /**
   * Folded segments are the bulk of the default view, and a segment is not a real
   * entry, so it cannot be a write target. Let the reader pick the segment's start
   * or end entry right here instead of expanding and hunting in the canvas.
   */
  const [foldTarget, setFoldTarget] = useState<'from' | 'to'>('to')
  if (!node) {
    return (
      <aside className="flex h-full w-72 shrink-0 flex-col border-l border-border bg-panel p-4">
        <div className="text-body-s font-medium text-text">节点详情</div>
        <div className="mt-3 text-meta text-muted leading-relaxed">
          在图上点一个节点查看详情。
          <br />
          <br />
          单击节点 = 选中；跨会话节点（带 ↗）选中后可跳到那个会话。双击空白处回到当前会话页。
        </div>
        <div className="mt-6 grid gap-2 text-meta text-muted">
          <div className="flex justify-between"><span>会话数</span><span className="text-text tabular-nums">{graph.sessions.length}</span></div>
          <div className="flex justify-between"><span>节点数</span><span className="text-text tabular-nums">{graph.nodes.length}</span></div>
          <div className="flex justify-between"><span>焦点</span><span className="text-text truncate max-w-32">{graph.focusKey.slice(-12)}</span></div>
          <div className="flex justify-between"><span>生成时间</span><span className="text-text tabular-nums">{new Date(graph.generatedAt).toLocaleTimeString()}</span></div>
        </div>
      </aside>
    )
  }

  const session = graph.sessions.find(candidate => candidate.key === node.sessionKey) ?? null
  const isCurrentSession = session?.isFocus === true
  const forkParentPresent = session?.forkOf ? graph.sessions.some(candidate => candidate.key === session.forkOf) : false
  const isFolded = node.kind === 'collapsed'
  /**
   * Why the write buttons are greyed out. The old code disabled them silently for
   * folded segments (which are the bulk of the default view), so "从此分叉" looked
   * permanently un-clickable with no explanation.
   */
  const writeUnavailableReason = !isCurrentSession ? null
    : !action.processInstanceId ? '写操作不可用：该会话没有运行中的 Pi 进程（历史会话只能查看）。请在 Dashboard 里启动它，或先 /reload 后重试。'
    : action.blockedReason ? null // already rendered above
    : !isFolded ? null
    : node.expanded
      ? '已展开：直接点卡片列表里的某一轮，就能对它「切到此处 / 从此分叉」。'
      : '折叠段不是一条真实 entry，无法直接切分支/分叉。先点下面的「▶ 展开这 N 轮」，再点列表里的具体某一轮。'
  const canWrite = Boolean(action.processInstanceId) && !action.blockedReason
  const isHead = node.isHead

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col overflow-y-auto border-l border-border bg-panel">
      <div className="flex items-center gap-2 px-4 py-3">
        <span className="text-meta">{ROLE_ICONS[node.kind === 'collapsed' ? 'collapsed' : node.role ?? 'system'] ?? '·'}</span>
        <span className="text-body-s font-medium text-text">{node.kind === 'collapsed' ? '折叠的对话' : node.role ?? 'entry'}</span>
        <button
          onClick={onClose}
          className="ml-auto h-6 w-6 cursor-pointer rounded border-none bg-transparent text-meta text-muted transition-colors hover:bg-bg-hover hover:text-text"
          title="关闭"
        >✕</button>
      </div>

      <div className="grid gap-3 px-4 pb-4">
        <div>
          <div className="text-2xs font-medium uppercase tracking-wide text-muted">标题</div>
          <div className="mt-1 text-body-s text-text-strong">{node.title}</div>
        </div>

        {node.collapsedCount ? (
          <div>
            <div className="text-2xs font-medium uppercase tracking-wide text-muted">折叠范围</div>
            <div className="mt-1 text-meta text-text">
              {node.collapsedCount} 条 · <span className="font-mono text-muted">{node.collapsedRange?.from} → {node.collapsedRange?.to}</span>
            </div>
          </div>
        ) : null}

        {node.preview ? (
          <div>
            <div className="text-2xs font-medium uppercase tracking-wide text-muted">{node.type === 'turn' ? '提问' : '预览'}</div>
            <div className="mt-1 whitespace-pre-wrap break-words text-meta leading-relaxed text-muted">{node.preview}</div>
          </div>
        ) : null}

        {node.reply ? (
          <div>
            <div className="text-2xs font-medium uppercase tracking-wide text-muted">回复</div>
            <div className="mt-1 whitespace-pre-wrap break-words text-meta leading-relaxed text-muted">{node.reply}</div>
          </div>
        ) : null}

        {node.coveredCount && node.coveredCount > 1 ? (
          <div className="rounded border border-border bg-bg-elevated px-2 py-1 text-2xs leading-relaxed text-muted">
            这一轮含 {node.coveredCount} 条记录：思考、工具调用与遥测已并入本行。
            {node.tools?.length ? `用到的工具：${node.tools.join('、')}。` : ''}
          </div>
        ) : null}

        <div className="grid gap-1.5 text-meta">
          <div className="flex justify-between gap-2"><span className="text-muted">entry id</span><span className="truncate font-mono text-text">{node.id}</span></div>
          <div className="flex justify-between gap-2"><span className="text-muted">类型</span><span className="text-text">{node.type}</span></div>
          <div className="flex justify-between gap-2"><span className="text-muted">子节点</span><span className="tabular-nums text-text">{node.childCount}</span></div>
          {node.label ? <div className="flex justify-between gap-2"><span className="text-muted">标签</span><span className="text-text">{node.label}</span></div> : null}
          {node.tools?.length ? <div className="flex justify-between gap-2"><span className="text-muted">工具</span><span className="truncate text-text">{node.tools.join(', ')}</span></div> : null}
          {node.timestamp ? <div className="flex justify-between gap-2"><span className="text-muted">时间</span><span className="tabular-nums text-text">{new Date(node.timestamp).toLocaleString()}</span></div> : null}
          <div className="flex justify-between gap-2"><span className="text-muted">所属会话</span><span className="truncate font-mono text-text" title={node.sessionKey}>{node.sessionKey.slice(-12)}</span></div>
          {session ? (
            <div className="flex justify-between gap-2">
              <span className="text-muted">状态</span>
              <span className={session.isLive ? 'text-ok' : 'text-warn'}>{session.isLive ? '运行中' : '未运行'}</span>
            </div>
          ) : null}
          {node.isForkAnchor ? (
            <div className="flex justify-between gap-2"><span className="text-muted">分叉点</span><span className="text-info">有会话由此分出</span></div>
          ) : null}
          {session?.forkOf ? (
            <div className="flex justify-between gap-3">
              <span className="text-muted">分叉自</span>
              <span className="truncate font-mono text-text" title={session.forkOf}>
                {session.forkOf.slice(-12)}{forkParentPresent ? '' : '（父文件缺失）'}
              </span>
            </div>
          ) : null}
          {isHead ? (
            <div className="flex justify-between gap-2"><span className="text-muted">HEAD</span><span className="text-accent">该会话的活动叶子</span></div>
          ) : null}
        </div>

        {action.blockedReason ? (
          <div className="rounded-md bg-warn-subtle px-3 py-2 text-2xs leading-relaxed text-text">{action.blockedReason}</div>
        ) : null}
        {writeUnavailableReason ? (
          <div className="rounded-md bg-bg-elevated px-3 py-2 text-2xs leading-relaxed text-muted">{writeUnavailableReason}</div>
        ) : null}
        {action.error ? (
          <div className="rounded-md bg-danger-subtle px-3 py-2 text-2xs leading-relaxed text-text">{action.error}</div>
        ) : null}

        {node.kind === 'collapsed' ? (
          <div className="grid gap-2 pt-1">
            <button
              type="button"
              onClick={() => onToggleExpand(node)}
              className="h-8 cursor-pointer rounded-md border border-border bg-transparent text-body-s font-medium text-text transition-colors hover:bg-bg-hover"
            >{node.expanded ? `▼ 收起这 ${node.collapsedCount} 轮` : `▶ 展开这 ${node.collapsedCount} 轮（就地，卡片内可滚）`}</button>
            {node.expanded && node.steps?.length ? (
              <div className="text-2xs leading-relaxed text-muted">
                已加载 {node.steps.length} / {node.collapsedCount} 轮，点其中一行可直接选中/切到那一轮。每轮 = 一次提问 + agent 的思考/工具调用/回复。
                {node.stepsTruncated ? '卡片底部「加载更多」可继续加载下一批。' : ''}
              </div>
            ) : null}
            {node.collapsedRange ? (
              <div className="grid gap-1.5 rounded-md border border-border bg-bg-elevated p-2">
                <div className="text-2xs text-muted">这一段不是 entry，选一个真实 entry 作为写操作目标：</div>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setFoldTarget('from')}
                    className={`cursor-pointer rounded border px-2 py-1 text-2xs font-mono transition-colors ${foldTarget === 'from' ? 'border-accent bg-accent-subtle text-accent' : 'border-border bg-card text-muted hover:border-accent'}`}
                    title={`起点 entry：${node.collapsedRange.from}`}
                  >起点 {node.collapsedRange.from.slice(0, 8)}</button>
                  <button
                    type="button"
                    onClick={() => setFoldTarget('to')}
                    className={`cursor-pointer rounded border px-2 py-1 text-2xs font-mono transition-colors ${foldTarget === 'to' ? 'border-accent bg-accent-subtle text-accent' : 'border-border bg-card text-muted hover:border-accent'}`}
                    title={`终点 entry：${node.collapsedRange.to}`}
                  >终点 {node.collapsedRange.to.slice(0, 8)}</button>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    disabled={!canWrite || action.busy}
                    onClick={() => onNavigate({ ...node, id: foldTarget === 'from' ? node.collapsedRange!.from : node.collapsedRange!.to, kind: 'message' })}
                    className="cursor-pointer rounded border border-border bg-transparent px-2 py-1 text-2xs text-text transition-colors hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-40"
                  >切到该处</button>
                  <button
                    type="button"
                    disabled={!canWrite || action.busy}
                    onClick={() => onFork({ ...node, id: foldTarget === 'from' ? node.collapsedRange!.from : node.collapsedRange!.to, kind: 'message' })}
                    className="cursor-pointer rounded border border-accent bg-transparent px-2 py-1 text-2xs text-accent transition-colors hover:bg-accent hover:text-accent-fg disabled:cursor-not-allowed disabled:opacity-40"
                  >从此分叉</button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="grid gap-2 pt-1">
          {isCurrentSession ? (
            <>
              <button
                onClick={() => onNavigate(node)}
                disabled={!canWrite || action.busy || isHead || isFolded}
                className="h-8 cursor-pointer rounded-md border-none bg-accent text-body-s font-medium text-accent-fg transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                title={isHead ? '已经是活动叶子' : isFolded ? '折叠段不是真实 entry，先展开再点具体某一轮' : '把会话的活动分支切到这个节点（原地，不新建会话）'}
              >
                {action.busy ? '处理中…' : isHead ? '已是当前位置' : '切到此处'}
              </button>
              <button
                onClick={() => onFork(node)}
                disabled={!canWrite || action.busy || isFolded}
                className="h-8 cursor-pointer rounded-md border border-border bg-transparent text-body-s font-medium text-text transition-colors hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-40"
                title={isFolded
                  ? '折叠段不是真实 entry，先展开再点具体某一轮'
                  : '从这一轮分叉：同一个 Pi 进程会切到一个新会话文件（并复制本会话到这一步的前缀），随后自动进入新会话页面并定位到这一步'}
              >
                从此分叉
              </button>
            </>
          ) : (
            <button
              onClick={() => { if (session) onOpenSession(session) }}
              className="h-8 cursor-pointer rounded-md border-none bg-accent text-body-s font-medium text-accent-fg transition-opacity"
            >
              {session?.isLive ? '打开该会话' : '在图谱中定位该会话'}
            </button>
          )}
          {!action.processInstanceId && isCurrentSession ? (
            <div className="text-2xs leading-relaxed text-muted">
              当前会话没有运行中的 Pi 进程，写操作不可用（历史会话只能查看）。
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-auto px-4 pb-4 text-2xs text-muted">
        节点高度 {NODE_H}px · 拖拽平移 · 滚轮缩放
      </div>
    </aside>
  )
}