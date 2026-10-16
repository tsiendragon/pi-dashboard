import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { RepoCommit, RepoCommitDetail, RepoGitStatus, RepoRef } from '@shared/repos'
import { Badge } from '../../components/ui'
import { relativeTime, repoApi } from './api'
import { layoutGraph } from './graphLayout'

const ROW_H = 28
/** Branch labels shown per commit before collapsing into a `+N` tooltip. */
const MAX_REFS = 3
const LANE_W = 14
const PALETTE = ['#4c8dff', '#2fb67c', '#e0883c', '#b064e8', '#e5566d', '#14b8c4', '#c9a227', '#7a8cff']
const colorOf = (slot: number) => PALETTE[slot % PALETTE.length]!
const BTN = 'px-2 py-1 rounded-md border border-border bg-transparent text-muted text-body-s cursor-pointer hover:text-text hover:border-border-strong disabled:opacity-40'

function RefChip({ item }: { item: RepoRef }) {
  const cls = item.kind === 'head' ? 'bg-accent text-accent-fg'
    : item.kind === 'local' ? 'bg-ok-subtle text-ok'
    : item.kind === 'tag' ? 'bg-warn-subtle text-warn'
    : 'bg-bg-elevated text-muted border border-border'
  return <span className={`px-1.5 rounded text-2xs font-mono whitespace-nowrap max-w-[14rem] truncate ${cls}`} title={item.name}>{item.kind === 'tag' ? '🏷 ' : ''}{item.name}</span>
}

function GraphCell({ row, width }: { row: ReturnType<typeof layoutGraph>['rows'][number]; width: number }) {
  const x = (lane: number) => lane * LANE_W + LANE_W / 2
  const mid = ROW_H / 2
  return (
    <svg width={width} height={ROW_H} className="shrink-0 block">
      {row.segments.map((seg, index) => {
        const stroke = colorOf(seg.color)
        const d = seg.kind === 'pass' ? `M${x(seg.lane)} 0V${ROW_H}`
          : seg.kind === 'in' ? `M${x(seg.lane)} 0C${x(seg.lane)} ${mid * 0.6} ${x(row.node)} ${mid * 0.4} ${x(row.node)} ${mid}`
          : `M${x(row.node)} ${mid}C${x(row.node)} ${mid * 1.6} ${x(seg.lane)} ${mid * 1.4} ${x(seg.lane)} ${ROW_H}`
        return <path key={index} d={d} stroke={stroke} strokeWidth={2} fill="none" />
      })}
      <circle cx={x(row.node)} cy={mid} r={4} fill={colorOf(row.nodeColor)} stroke="var(--card)" strokeWidth={1.5} />
    </svg>
  )
}

export default function RepoGraphPage() {
  const { id = '' } = useParams<{ id: string }>()
  const [commits, setCommits] = useState<RepoCommit[]>([])
  const [cursor, setCursor] = useState<number | null>(0)
  const [meta, setMeta] = useState<{ name: string; path: string } | null>(null)
  const [status, setStatus] = useState<RepoGitStatus | null>(null)
  const [scope, setScope] = useState<'all' | 'head'>('all')
  const [showRemote, setShowRemote] = useState(true)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string>()
  const [detail, setDetail] = useState<RepoCommitDetail | null>(null)
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)

  const loadPage = useCallback(async (from: number, replace: boolean) => {
    setLoading(true)
    try {
      const page = await repoApi.graph(id, scope, from)
      setMeta(page.repo); setStatus(prev => page.status ?? prev)
      setCommits(prev => replace ? page.commits : [...prev, ...page.commits])
      setCursor(page.nextCursor)
      setError(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
    setLoading(false)
  }, [id, scope])

  useEffect(() => { setCommits([]); setCursor(0); setSelected(undefined); setDetail(null); void loadPage(0, true) }, [loadPage])

  useEffect(() => {
    if (!selected) { setDetail(null); return }
    let cancelled = false
    repoApi.commit(id, selected).then(next => { if (!cancelled) setDetail(next) }).catch(() => { if (!cancelled) setDetail(null) })
    return () => { cancelled = true }
  }, [id, selected])

  const layout = useMemo(() => layoutGraph(commits), [commits])
  const width = Math.max(1, layout.laneCount) * LANE_W + 4
  const needle = query.trim().toLowerCase()
  const matches = (commit: RepoCommit) => !needle || [commit.subject, commit.hash, commit.author, ...commit.refs.map(ref => ref.name)].some(text => text.toLowerCase().includes(needle))
  const byHash = useMemo(() => new Map(commits.map(commit => [commit.hash, commit])), [commits])
  const webCommit = detail && status?.webUrl ? `${status.webUrl}/commit/${detail.hash}` : null

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-6 pt-4 pb-3 flex flex-wrap items-center gap-3 border-b border-border">
        <Link to="/repos" className="text-accent text-sm no-underline hover:underline">← Repos</Link>
        <div className="text-lg font-bold text-text-strong">{meta?.name ?? id}</div>
        <div className="font-mono text-body-s text-muted">{meta?.path}</div>
        {status && <>
          {status.branch && <Badge variant="aim">⎇ {status.branch}</Badge>}
          {!!status.ahead && <Badge variant="warn">↑{status.ahead} 未推送</Badge>}
          {!!status.behind && <Badge variant="warn">↓{status.behind} 落后</Badge>}
          {status.staged + status.modified + status.untracked > 0 && <Badge variant="warn">{status.staged + status.modified + status.untracked} 个未提交</Badge>}
          <span className="text-body-s text-muted">{status.localBranches} 本地分支 · {status.worktrees} worktree</span>
          {status.webUrl && <a className="text-accent text-body-s" href={status.webUrl} target="_blank" rel="noreferrer">在 GitHub 打开 ↗</a>}
        </>}
      </div>
      <div className="px-6 py-2 flex flex-wrap items-center gap-2 border-b border-border">
        <button className={BTN} onClick={() => setScope(scope === 'all' ? 'head' : 'all')}>{scope === 'all' ? '范围：所有分支' : '范围：仅当前分支'}</button>
        <label className="text-body-s text-muted flex items-center gap-1"><input type="checkbox" checked={showRemote} onChange={event => setShowRemote(event.target.checked)} />显示远端分支标签</label>
        <input className="bg-bg-elevated border border-border rounded-md px-3 py-1 text-sm text-text w-64 outline-none focus-ring" placeholder="搜索信息 / hash / 作者 / 分支" value={query} onChange={event => setQuery(event.target.value)} />
        <button className={BTN} disabled={loading} onClick={() => void loadPage(0, true)}>刷新</button>
        <span className="text-body-s text-muted">已载入 {commits.length} 条提交</span>
      </div>
      {error && <div className="mx-6 mt-3 rounded-md border border-danger bg-danger-subtle px-3 py-2 text-danger text-body-s">{error}</div>}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 overflow-auto">
          {commits.map((commit, index) => {
            const row = layout.rows[index]!
            const dim = !matches(commit)
            const refs = commit.refs.filter(ref => showRemote || ref.kind !== 'remote')
            return (
              <div key={commit.hash} onClick={() => setSelected(commit.hash)}
                className={`flex items-center gap-2 pr-4 cursor-pointer text-body-s hover:bg-bg-hover ${selected === commit.hash ? 'bg-accent-subtle' : ''} ${dim ? 'opacity-30' : ''}`} style={{ height: ROW_H }}>
                <GraphCell row={row} width={width} />
                <div className="flex items-center gap-1 min-w-0 flex-1">
                  {refs.slice(0, MAX_REFS).map(ref => <RefChip key={ref.kind + ref.name} item={ref} />)}
                  {refs.length > MAX_REFS && <span className="text-2xs text-muted whitespace-nowrap" title={refs.slice(MAX_REFS).map(ref => ref.name).join('\n')}>+{refs.length - MAX_REFS}</span>}
                  <span className={`truncate ${commit.parents.length > 1 ? 'text-muted' : 'text-text'}`}>{commit.subject}</span>
                </div>
                <span className="w-24 truncate text-muted hidden md:block">{commit.author}</span>
                <span className="w-24 text-muted hidden md:block">{relativeTime(commit.time)}</span>
                <span className="w-16 font-mono text-muted">{commit.hash.slice(0, 7)}</span>
              </div>
            )
          })}
          {cursor !== null && commits.length > 0 && (
            <div className="p-3 text-center"><button className={BTN} disabled={loading} onClick={() => void loadPage(cursor, false)}>{loading ? '加载中…' : '加载更多'}</button></div>
          )}
          {!loading && !error && commits.length === 0 && <div className="p-8 text-center text-muted text-sm">这个仓库还没有提交</div>}
        </div>
        {selected && (
          <aside className="w-96 shrink-0 border-l border-border overflow-auto p-4 flex flex-col gap-2 text-body-s">
            {detail ? <>
              <div className="text-sm font-semibold text-text-strong break-words">{detail.subject}</div>
              {detail.body && <pre className="whitespace-pre-wrap text-muted font-body m-0">{detail.body}</pre>}
              <div className="text-muted">{detail.author} · {relativeTime(detail.time)}</div>
              <div className="font-mono text-muted break-all">{detail.hash}</div>
              <div className="text-muted">父提交：{detail.parents.length === 0 ? '无（根提交）' : detail.parents.map(parent => (
                <button key={parent} className="font-mono text-accent bg-transparent border-none cursor-pointer p-0 mr-2 hover:underline" disabled={!byHash.has(parent)} onClick={() => setSelected(parent)}>{parent.slice(0, 7)}</button>
              ))}</div>
              <div className="flex gap-2">
                <button className={BTN} onClick={() => void navigator.clipboard?.writeText(detail.hash)}>复制 hash</button>
                {webCommit && <a className={`${BTN} no-underline`} href={webCommit} target="_blank" rel="noreferrer">GitHub ↗</a>}
              </div>
              <div className="text-muted mt-2">改动文件 {detail.files.length}</div>
              <ul className="m-0 p-0 list-none flex flex-col gap-0.5">
                {detail.files.map(file => (
                  <li key={file.path} className="flex gap-2 font-mono">
                    <span className="truncate flex-1" title={file.path}>{file.path}</span>
                    <span className="text-ok">{file.added === null ? 'bin' : `+${file.added}`}</span>
                    <span className="text-danger">{file.deleted === null ? '' : `-${file.deleted}`}</span>
                  </li>
                ))}
              </ul>
            </> : <div className="text-muted">加载中…</div>}
          </aside>
        )}
      </div>
    </div>
  )
}
