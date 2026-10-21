import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { RepoView } from '@shared/repos'
import { Badge, PageHeader, SearchInput } from '../../components/ui'
import { liveSessionApi } from '../live-sessions/api'
import { attentionReasons, relativeTime, remoteForms, repoApi, scrubRemote, type RepoInputBody } from './api'
import { copyText } from '../../utils/clipboard'

type Filter = 'all' | 'attention' | 'pinned'

const BTN = 'px-2 py-1 rounded-md border border-border bg-transparent text-muted text-body-s cursor-pointer hover:text-text hover:border-border-strong disabled:opacity-40 disabled:cursor-not-allowed'
const BTN_PRIMARY = 'px-3 py-1 rounded-md border-none bg-accent text-accent-fg text-body-s font-semibold cursor-pointer hover:bg-accent-hover disabled:opacity-40'

function GitState({ repo }: { repo: RepoView }) {
  const s = repo.status
  if (!repo.exists) return <span className="text-danger">路径不存在</span>
  if (!s) return <span className="text-muted">正在读取 git 状态…</span>
  if (!s.isGit) return <span className="text-muted">非 git 目录</span>
  if (s.slow) return <span className="text-warn text-body-s">git status 超时（目录太大或磁盘冷），点「刷新状态」重试</span>
  const dirty = [s.staged + s.modified ? `${s.staged + s.modified} 改动` : '', s.untracked ? `${s.untracked} 新文件` : '', s.conflicted ? `${s.conflicted} 冲突` : '', s.stash ? `stash ${s.stash}` : ''].filter(Boolean)
  const sync = s.ahead === null ? '没有上游分支' : s.ahead || s.behind ? [s.ahead ? `↑${s.ahead} 未推送` : '', s.behind ? `↓${s.behind} 落后` : ''].filter(Boolean).join(' ') : '已同步'
  const syncWarn = s.ahead === null ? false : !!(s.ahead || s.behind)
  const offBranch = repo.defaultBranch && s.branch && s.branch !== repo.defaultBranch
  return (
    <div className="flex flex-col gap-0.5 text-body-s">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-text">{s.detached ? '(游离 HEAD)' : `⎇ ${s.branch ?? '?'}`}</span>
        {offBranch && <Badge variant="warn">≠ {repo.defaultBranch}</Badge>}
        <span className={syncWarn ? 'text-warn' : 'text-muted'}>{sync}</span>
      </div>
      <div className={dirty.length ? 'text-warn' : 'text-muted'}>{dirty.length ? dirty.join(' · ') : '工作区干净'}</div>
      {repo.statusAt && <div className="text-2xs text-muted">{repo.refreshing ? '更新中… · ' : ''}状态读取于 {relativeTime(repo.statusAt / 1000)}</div>}
    </div>
  )
}

/** One copyable remote form: `ssh git@host:a/b.git` or `https https://host/a/b.git`. */
function RemoteLine({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (!await copyText(value)) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="font-mono">{label} {value}</span>
      <button type="button" title={`复制 ${value}`}
        className="px-1.5 py-0.5 rounded border border-border bg-transparent text-2xs text-muted cursor-pointer hover:text-accent hover:border-accent"
        onClick={() => void copy()}>{copied ? '已复制' : '复制'}</button>
    </div>
  )
}

interface FormState { path: string; id: string; name: string; tags: string; defaultBranch: string }

function RepoDialog({ editing, onClose, onSaved }: { editing: RepoView | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<FormState>({
    path: editing?.path ?? '', id: editing?.id ?? '', name: editing?.name ?? '',
    tags: editing?.tags?.join(', ') ?? '', defaultBranch: editing?.defaultBranch ?? '',
  })
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const input = form.path.trim()
    if (!/^[~/]/.test(input)) { setSuggestions([]); return }
    const timer = window.setTimeout(() => {
      fetch(`/api/path-complete?input=${encodeURIComponent(input)}`).then(r => r.json())
        .then((body: { entries?: { path: string; isDir: boolean }[] }) => setSuggestions((body.entries ?? []).filter(e => e.isDir).slice(0, 6).map(e => e.path)))
        .catch(() => setSuggestions([]))
    }, 150)
    return () => window.clearTimeout(timer)
  }, [form.path])

  const set = (key: keyof FormState) => (event: React.ChangeEvent<HTMLInputElement>) => setForm(prev => ({ ...prev, [key]: event.target.value }))

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    const body: RepoInputBody = {
      path: form.path.trim(), name: form.name.trim(), defaultBranch: form.defaultBranch.trim(),
      tags: form.tags.split(',').map(tag => tag.trim()).filter(Boolean),
      ...(editing ? { pinned: editing.pinned } : form.id.trim() ? { id: form.id.trim() } : {}),
    }
    try {
      if (editing) await repoApi.update(editing.id, body)
      else await repoApi.add(body)
      onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setBusy(false)
    }
  }

  const field = 'w-full bg-bg-elevated border border-border rounded-md px-3 py-1.5 text-text text-sm font-body outline-none focus-ring'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <form onSubmit={submit} className="w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-xl flex flex-col gap-3">
        <div className="text-sm font-semibold text-text-strong">{editing ? `编辑 ${editing.id}` : '添加仓库'}</div>
        <label className="text-body-s text-muted">绝对路径（任意位置，不要求同一父目录）
          <input autoFocus className={`${field} font-mono mt-1`} value={form.path} onChange={set('path')} placeholder="/home/you/repos/my-repo" />
        </label>
        {suggestions.length > 0 && (
          <div className="flex flex-col rounded-md border border-border bg-bg-elevated text-body-s font-mono max-h-40 overflow-auto">
            {suggestions.map(path => (
              <button key={path} type="button" className="text-left px-3 py-1 bg-transparent border-none text-text cursor-pointer hover:bg-bg-hover"
                onClick={() => setForm(prev => ({ ...prev, path: path + '/' }))}>{path}</button>
            ))}
          </div>
        )}
        <label className="text-body-s text-muted">id（其他地方引用它；登记后不可改）
          <input className={`${field} font-mono mt-1`} value={form.id} onChange={set('id')} disabled={!!editing} placeholder="留空则按目录名生成" />
        </label>
        <label className="text-body-s text-muted">显示名（可选）
          <input className={`${field} mt-1`} value={form.name} onChange={set('name')} />
        </label>
        <div className="flex gap-3">
          <label className="flex-1 text-body-s text-muted">标签（逗号分隔）
            <input className={`${field} mt-1`} value={form.tags} onChange={set('tags')} placeholder="work, pi" />
          </label>
          <label className="flex-1 text-body-s text-muted">默认分支（可选）
            <input className={`${field} font-mono mt-1`} value={form.defaultBranch} onChange={set('defaultBranch')} placeholder="main" />
          </label>
        </div>
        {error && <div className="text-danger text-body-s">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN} onClick={onClose}>取消</button>
          <button type="submit" className={BTN_PRIMARY} disabled={busy || !form.path.trim()}>{busy ? '保存中…' : '保存'}</button>
        </div>
      </form>
    </div>
  )
}

export default function ReposPage() {
  const navigate = useNavigate()
  const [repos, setRepos] = useState<RepoView[] | null>(null)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [tag, setTag] = useState<string>()
  const [dialog, setDialog] = useState<{ editing: RepoView | null } | null>(null)
  const [busyId, setBusyId] = useState<string>()

  const load = useCallback(async (refresh = false) => {
    try { setRepos(await repoApi.list(refresh)); setError(undefined) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }, [])
  useEffect(() => { void load() }, [load])
  // Statuses are computed in the background; poll until every existing repo has one.
  const waiting = !!repos?.some(repo => repo.exists && (!repo.status || repo.refreshing))
  useEffect(() => {
    if (!waiting) return
    const timer = window.setTimeout(() => { void load() }, 2000)
    return () => window.clearTimeout(timer)
  }, [waiting, repos, load])

  const act = async (repo: RepoView, label: string, run: () => Promise<unknown>) => {
    setBusyId(repo.id); setError(undefined); setNotice(undefined)
    try { await run(); await load(); setNotice(`${repo.id}：${label}`) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    setBusyId(undefined)
  }

  const startLivePi = async (repo: RepoView) => {
    setBusyId(repo.id); setError(undefined)
    try {
      await liveSessionApi.start({ cwd: repo.path, title: repo.name ?? repo.id })
      navigate('/live-sessions')
    } catch (reason) {
      setError(`启动 Live Pi 失败：${reason instanceof Error ? reason.message : String(reason)}`)
      setBusyId(undefined)
    }
  }

  const allTags = useMemo(() => [...new Set((repos ?? []).flatMap(repo => repo.tags ?? []))].sort(), [repos])
  const attentionCount = useMemo(() => (repos ?? []).filter(repo => attentionReasons(repo).length).length, [repos])
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (repos ?? [])
      .filter(repo => filter === 'all' || (filter === 'pinned' ? repo.pinned : attentionReasons(repo).length > 0))
      .filter(repo => !tag || repo.tags?.includes(tag))
      .filter(repo => !needle || [repo.id, repo.name, repo.path, ...(repo.tags ?? [])].some(text => text?.toLowerCase().includes(needle)))
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.id.localeCompare(b.id))
  }, [repos, filter, tag, query])

  const chip = (active: boolean) => `px-2.5 py-1 rounded-full border text-body-s cursor-pointer ${active ? 'border-accent text-accent bg-accent-subtle' : 'border-border text-muted bg-transparent hover:text-text'}`

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <PageHeader title="Repos" subtitle="登记你常用的仓库：每个仓库一个绝对路径，保存在 ~/.pi/dashboard.json 的 repos 里" />
      <div className="px-6 pb-8 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput className="w-64" placeholder="搜索 id / 路径 / 标签" value={query} onChange={event => setQuery(event.target.value)} />
          <button className={chip(filter === 'all')} onClick={() => setFilter('all')}>全部 {repos?.length ?? 0}</button>
          <button className={chip(filter === 'attention')} onClick={() => setFilter('attention')}>⚠ 需要处理 {attentionCount}</button>
          <button className={chip(filter === 'pinned')} onClick={() => setFilter('pinned')}>★ 置顶</button>
          {allTags.map(name => <button key={name} className={chip(tag === name)} onClick={() => setTag(tag === name ? undefined : name)}>#{name}</button>)}
          <div className="flex-1" />
          <button className={BTN} disabled={waiting} onClick={() => void load(true)} title="重新读取所有仓库的 git 状态（大仓库可能要几十秒）">{waiting ? '读取中…' : '刷新状态'}</button>
          <button className={BTN_PRIMARY} onClick={() => setDialog({ editing: null })}>＋ 添加仓库</button>
        </div>
        {error && <div className="rounded-md border border-danger bg-danger-subtle px-3 py-2 text-danger text-body-s">{error}</div>}
        {notice && <div className="rounded-md border border-border bg-card px-3 py-2 text-muted text-body-s">{notice}</div>}

        {repos === null && !error && <div className="text-muted text-sm">加载中…</div>}
        {repos?.length === 0 && <div className="text-muted text-sm py-10 text-center">还没有登记仓库。点右上角「添加仓库」，或直接在 dashboard.json 的 repos 里写入。</div>}

        <div className="flex flex-col gap-2">
          {visible.map(repo => {
            const s = repo.status
            const reasons = attentionReasons(repo)
            const busy = busyId === repo.id
            const forms = s?.isGit && s.origin ? remoteForms(s.origin) : null
            return (
              <div key={repo.id} className={`rounded-lg border bg-card px-4 py-3 flex flex-wrap items-start gap-x-6 gap-y-2 ${!repo.exists ? 'border-danger' : 'border-border'}`}>
                <div className="min-w-0 flex-1 basis-72">
                  <div className="flex items-center gap-2 flex-wrap">
                    {repo.pinned && <span className="text-warn" title="置顶">★</span>}
                    <span className="font-semibold text-text-strong">{repo.name ?? repo.id}</span>
                    <span className="font-mono text-body-s text-muted">{repo.id}</span>
                    {repo.tags?.map(name => <Badge key={name} variant="aim">#{name}</Badge>)}
                    {repo.liveSessions > 0 && <Badge variant="ok">{repo.liveSessions} Live Pi</Badge>}
                  </div>
                  <div className="font-mono text-body-s text-muted break-all mt-0.5">{repo.path}</div>
                  {s?.isGit && (
                    <div className="mt-0.5 flex flex-col gap-0.5 text-2xs break-all">
                      <div className="font-mono text-muted">origin {s.origin ? scrubRemote(s.origin) : '无远端（只在本地使用）'}</div>
                      {forms?.ssh && <RemoteLine label="ssh" value={forms.ssh} />}
                      {forms?.https && <RemoteLine label="https" value={forms.https} />}
                      <div className={s.identity ? 'text-muted' : 'text-warn'}>
                        提交身份 {s.identity ? `${s.identity.name ?? '未设姓名'} <${s.identity.email ?? '未设邮箱'}>` : '未配置（git config user.name / user.email）'}
                      </div>
                    </div>
                  )}
                  {s?.last && <div className="text-body-s text-muted mt-1 truncate" title={s.last.subject}>{s.last.hash} · {s.last.subject} · {relativeTime(s.last.time)}</div>}
                  {reasons.length > 0 && <div className="text-body-s text-warn mt-1">⚠ {reasons.join(' · ')}</div>}
                </div>
                <div className="basis-56 shrink-0"><GitState repo={repo} /></div>
                <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                  {repo.exists && s?.isGit && <Link to={`/repos/${encodeURIComponent(repo.id)}/graph`} className="px-2.5 py-1 rounded-md bg-accent text-accent-fg text-body-s font-semibold no-underline hover:bg-accent-hover">Git Graph</Link>}
                  <button className={BTN} disabled={busy || !repo.exists} onClick={() => void startLivePi(repo)} title="在此目录启动 Live Pi">▶ Live Pi</button>
                  {s?.webUrl && <a className={`${BTN} no-underline`} href={s.webUrl} target="_blank" rel="noreferrer">GitHub ↗</a>}
                  {s?.isGit && <button className={BTN} disabled={busy} onClick={() => void act(repo, '已 fetch', () => repoApi.fetch(repo.id))} title="git fetch --prune">Fetch</button>}
                  <button className={BTN} disabled={busy} onClick={() => void act(repo, repo.pinned ? '已取消置顶' : '已置顶', () => repoApi.update(repo.id, { pinned: !repo.pinned }))}>{repo.pinned ? '取消置顶' : '置顶'}</button>
                  <button className={BTN} onClick={() => setDialog({ editing: repo })}>{repo.exists ? '编辑' : '改路径'}</button>
                  <button className={`${BTN} hover:!text-danger hover:!border-danger`} disabled={busy}
                    onClick={() => { if (window.confirm(`从清单移除 ${repo.id}？只删登记，不会动磁盘上的目录。`)) void act(repo, '已移除登记', () => repoApi.remove(repo.id)) }}>移除</button>
                </div>
              </div>
            )
          })}
          {repos && repos.length > 0 && visible.length === 0 && <div className="text-muted text-sm py-6 text-center">没有符合筛选的仓库</div>}
        </div>
      </div>
      {dialog && <RepoDialog editing={dialog.editing} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); void load() }} />}
    </div>
  )
}
