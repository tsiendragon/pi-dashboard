import type { RepoCommitDetail, RepoEntry, RepoGitStatus, RepoGraphPage, RepoView } from '@shared/repos'

export class RepoApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'RepoApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    const text = typeof body.message === 'string' ? body.message : typeof body.hint === 'string' ? body.hint : `HTTP ${response.status}`
    throw new RepoApiError(response.status, typeof body.error === 'string' ? body.error : 'repo_request_failed', text)
  }
  return body as T
}

export type RepoInputBody = Partial<Pick<RepoEntry, 'id' | 'path' | 'name' | 'tags' | 'pinned' | 'defaultBranch'>>
export interface RepoGraphResponse extends RepoGraphPage {
  repo: { id: string; name: string; path: string }
  /** null while the background status read is still running. */
  status: RepoGitStatus | null
}

export const repoApi = {
  /** `refresh` recomputes every status in the background; poll again until `refreshing` clears. */
  list: (refresh = false) => request<{ repos: RepoView[] }>(`/api/dash/repos${refresh ? '?refresh=1' : ''}`).then(r => r.repos),
  add: (body: RepoInputBody) => request<{ repo: RepoView }>('/api/dash/repos', { method: 'POST', body: JSON.stringify(body) }).then(r => r.repo),
  update: (id: string, body: RepoInputBody) => request<{ repo: RepoView }>(`/api/dash/repos/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }).then(r => r.repo),
  remove: (id: string) => request<{ ok: true }>(`/api/dash/repos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  fetch: (id: string) => request<{ repo: RepoView }>(`/api/dash/repos/${encodeURIComponent(id)}/fetch`, { method: 'POST', body: '{}' }).then(r => r.repo),
  graph: (id: string, scope: 'all' | 'head', cursor: number) =>
    request<RepoGraphResponse>(`/api/dash/repos/${encodeURIComponent(id)}/graph?scope=${scope}&cursor=${cursor}`),
  commit: (id: string, sha: string) =>
    request<{ commit: RepoCommitDetail }>(`/api/dash/repos/${encodeURIComponent(id)}/commit/${sha}`).then(r => r.commit),
}

export function relativeTime(seconds: number, now = Date.now()): string {
  const diff = Math.max(0, Math.floor(now / 1000) - seconds)
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))} 个月前`
  return `${Math.floor(diff / (86400 * 365))} 年前`
}

/** Reasons a repo deserves a look; the "需要处理" filter is simply "any reason". */
export function attentionReasons(repo: RepoView): string[] {
  if (!repo.exists) return ['路径不存在']
  const s = repo.status
  if (!s || !s.isGit) return []
  const reasons: string[] = []
  if (s.conflicted) reasons.push('有冲突')
  if (s.detached) reasons.push('游离 HEAD')
  if (s.ahead) reasons.push(`未推送 ${s.ahead}`)
  if (s.behind) reasons.push(`落后 ${s.behind}`)
  if (repo.defaultBranch && s.branch && s.branch !== repo.defaultBranch) reasons.push(`不在 ${repo.defaultBranch}`)
  return reasons
}
