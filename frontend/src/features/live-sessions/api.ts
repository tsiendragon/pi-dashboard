import type { LiveSessionCommand, LiveSessionContextView, LiveSessionDetail, LiveSessionGroup, LiveSessionMeta, LiveSessionModelOption, LiveSessionReloadResult, LiveSessionSummary, RepoCandidate } from '@shared/live-sessions'
import type { SessionTreeGraph } from '@shared/session-tree'
import type { CompactionMark } from './compactionWatch'

export class LiveSessionApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'LiveSessionApiError'
  }
}

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    throw new LiveSessionApiError(
      response.status,
      typeof body.error === 'string' ? body.error : 'live_session_request_failed',
      typeof body.message === 'string' ? body.message : `HTTP ${response.status}`,
    )
  }
  return body as T
}

function post<T>(path: string, body: unknown): Promise<T> {
  return fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(json<T>)
}

export const liveSessionApi = {
  authenticate: (token: string) => post<{ ok: true; browserClientId: string }>('/api/live-sessions/auth', { token }),
  websocketTicket: () => post<{ ok: true; result: { ticket: string; expiresAt: number } }>('/api/live-sessions/ws-ticket', {})
    .then(result => result.result),
  start: (input: { cwd: string; model?: string; thinkingLevel?: string; title?: string; forkFrom?: string }) => post<{ ok: true; result: { slotKey: string; cwd: string; title: string; processInstanceId?: string; sessionId?: string; tmuxSession?: string } }>('/api/live-sessions/start', input)
    .then(result => result.result),
  /**
   * Entry-level fork. Extracts the source session's root→entry branch into a NEW
   * session file and starts a fresh Pi on it; the source keeps running. Returns
   * the new session's ids so the caller can place it beside the parent.
   */
  forkAtEntry: (processInstanceId: string, entryId: string) => post<{ ok: true; result: { processInstanceId?: string; sessionId?: string; tmuxSession?: string; forkedFrom?: string; entryId?: string } }>(
    `/api/live-sessions/${encodeURIComponent(processInstanceId)}/fork`, { entryId },
  ).then(result => result.result),
  discardAfter: (processInstanceId: string, entryId: string) => post<{ ok: true; result: { processInstanceId?: string; sessionId?: string; tmuxSession: string; entryId: string; deletedEntries: number } }>(
    `/api/live-sessions/${encodeURIComponent(processInstanceId)}/discard-after`, { entryId },
  ).then(result => result.result),
  withdrawMessage: (processInstanceId: string, entryId: string) => post<{ ok: true; result: { processInstanceId?: string; sessionId?: string; tmuxSession: string; entryId: string; removedEntries: number } }>(
    `/api/live-sessions/${encodeURIComponent(processInstanceId)}/withdraw-message`, { entryId },
  ).then(result => result.result),
  restart: (processInstanceId: string) => post<{ ok: true; result: { processInstanceId?: string; sessionId?: string; tmuxSession: string } }>(
    `/api/live-sessions/${encodeURIComponent(processInstanceId)}/restart`, {},
  ).then(result => result.result),
  rename: (processInstanceId: string, name: string) => post<{ ok: true; result: unknown }>(
    `/api/live-sessions/${encodeURIComponent(processInstanceId)}/commands`, { command: { type: 'set_session_name', name } },
  ).then(result => result.result),
  /**
   * Bulk `/reload` of every main session — for after dashboard extensions, skills,
   * prompts or themes changed, when reconnecting each session by hand is tedious.
   * The backend skips subagent child processes so running tasks are not killed.
   */
  reloadAll: () => post<{ ok: true; result: LiveSessionReloadResult }>('/api/live-sessions/reload', {})
    .then(result => result.result),
  list: () => fetch('/api/live-sessions', { credentials: 'same-origin' })
    .then(json<{ sessions: LiveSessionSummary[]; browserClientId?: string }>),
  /** Directories under `liveSessions.repoRoots` the start field may suggest by keyword. */
  repoCandidates: () => fetch('/api/live-sessions/repo-candidates', { credentials: 'same-origin' })
    .then(json<{ repos?: RepoCandidate[] }>)
    .then(result => Array.isArray(result.repos) ? result.repos : []),
  listMeta: () => fetch('/api/live-session-meta', { credentials: 'same-origin' })
    .then(json<{ meta: Record<string, LiveSessionMeta> }>).then(result => result.meta),
  patchMeta: (processInstanceId: string, patch: { tags?: string[]; pinned?: boolean }) => fetch(`/api/live-sessions/${encodeURIComponent(processInstanceId)}/meta`, {
    method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  }).then(json<{ ok: true; meta: LiveSessionMeta; all: Record<string, LiveSessionMeta> }>).then(result => result.all),
  listOrderState: () => fetch('/api/live-session-order', { credentials: 'same-origin' })
    .then(json<{ order: string[]; sectionOrder?: string[] }>)
    .then(result => ({ order: result.order, sectionOrder: result.sectionOrder ?? [] })),
  saveSectionOrder: (sectionOrder: string[]) => fetch('/api/live-session-order', {
    method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sectionOrder }),
  }).then(json<{ ok: true; sectionOrder: string[] }>).then(result => result.sectionOrder),
  listOrder: () => fetch('/api/live-session-order', { credentials: 'same-origin' })
    .then(json<{ order?: string[] }>).then(result => Array.isArray(result.order) ? result.order : []),
  saveOrder: (order: string[]) => fetch('/api/live-session-order', {
    method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order }),
  }).then(json<{ ok: true; order?: string[] }>).then(result => Array.isArray(result.order) ? result.order : []),
  listGroups: () => fetch('/api/live-session-groups', { credentials: 'same-origin' })
    .then(json<{ groups: LiveSessionGroup[] }>)
    .then(result => result.groups),
  createGroup: (name: string) => post<{ ok: true; groups: LiveSessionGroup[] }>('/api/live-session-groups', { name })
    .then(result => result.groups),
  renameGroup: (groupId: string, name: string) => fetch(`/api/live-session-groups/${encodeURIComponent(groupId)}`, {
    method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }).then(json<{ ok: true; groups: LiveSessionGroup[] }>).then(result => result.groups),
  deleteGroup: (groupId: string) => fetch(`/api/live-session-groups/${encodeURIComponent(groupId)}`, {
    method: 'DELETE', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
  }).then(json<{ ok: true; groups: LiveSessionGroup[] }>).then(result => result.groups),
  /** Move a duplicate group's members into `targetId` and delete the source. */
  mergeGroup: (groupId: string, targetId: string) => post<{ ok: true; groups: LiveSessionGroup[] }>(
    `/api/live-session-groups/${encodeURIComponent(groupId)}/merge`, { targetId },
  ).then(result => result.groups),
  addGroupMember: (groupId: string, processInstanceId: string) => post<{ ok: true; groups: LiveSessionGroup[] }>(
    `/api/live-session-groups/${encodeURIComponent(groupId)}/members`, { processInstanceId },
  ).then(result => result.groups),
  removeGroupMember: (groupId: string, sessionId: string) => fetch(`/api/live-session-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
  }).then(json<{ ok: true; groups: LiveSessionGroup[] }>).then(result => result.groups),
  detail: (processInstanceId: string) => fetch(`/api/live-sessions/${encodeURIComponent(processInstanceId)}`, { credentials: 'same-origin' })
    .then(json<LiveSessionDetail>),
  claim: (processInstanceId: string, requestedLeaseMs = 30_000) => post<{ ok: true; result: { leaseId: string; expiresAt?: number } }>(
    `/api/live-sessions/${encodeURIComponent(processInstanceId)}/claim`, { requestedLeaseMs },
  ),
  renew: (processInstanceId: string, leaseId: string) => post<{ ok: true; result: { leaseId: string; expiresAt?: number } }>(
    `/api/live-sessions/${encodeURIComponent(processInstanceId)}/renew`, { leaseId },
  ),
  release: (processInstanceId: string, leaseId: string) => post<{ ok: true; result: unknown }>(
    `/api/live-sessions/${encodeURIComponent(processInstanceId)}/release`, { leaseId },
  ),
  models: (processInstanceId: string) => post<{ ok: true; result: { models: LiveSessionModelOption[] } }>(
    `/api/live-sessions/${encodeURIComponent(processInstanceId)}/commands`, { command: { type: 'get_models' } },
  ).then(result => result.result.models),
  /**
   * What this session sends to the model, as the bridge reconstructed it from the
   * last real provider request (or an approximation when none has gone out yet).
   * Requires the `context_view` capability — an older bridge answers
   * `unsupported_command`.
   */
  contextView: (processInstanceId: string) => post<{ ok: true; result: LiveSessionContextView }>(
    `/api/live-sessions/${encodeURIComponent(processInstanceId)}/commands`, { command: { type: 'get_context' } },
  ).then(result => result.result),
  command: (processInstanceId: string, command: Extract<LiveSessionCommand, { type: 'resync' | 'input' | 'abort' | 'set_session_name' | 'get_models' | 'get_context' | 'set_model' | 'compact' | 'reload' | 'shutdown' | 'feature_command' | 'answer_ui' }>) => post<{ ok: true; result: unknown }>(
    `/api/live-sessions/${encodeURIComponent(processInstanceId)}/commands`, { command },
  ),
  /** Close a tmux-first live session: kills the tmux session hosting its Pi. */
  closeTmuxSession: (tmuxSession: string) => fetch(`/api/pty/sessions/${encodeURIComponent(tmuxSession)}`, {
    method: 'DELETE', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
  }).then(json<{ ok: true }>),
  /**
   * Close a subagent live session. tmux-backed ones die with their tmux session;
   * plain subagent child processes are signalled directly. The registry drops the
   * row on its own once the process is gone, so the caller only refreshes.
   */
  closeSession: (processInstanceId: string) => post<{ ok: true; result: { method: 'tmux' | 'signal'; pid: number; alreadyGone: boolean } }>(
    `/api/live-sessions/${encodeURIComponent(processInstanceId)}/close`, {},
  ).then(result => result.result),
  /**
   * Session-family graph for the graph page. Keyed by absolute session file path
   * so sessions that are no longer running can be inspected too.
   *
   * The response is validated because a backend that predates this route does not
   * 404: the SPA static fallback answers 200 with index.html, which would
   * otherwise silently yield `undefined` and render an empty canvas.
   */
  sessionTree: (file: string, detail: 'collapsed' | 'full' = 'collapsed', expand: string[] = [], steps = 0) =>
    fetch(
      `/api/session-tree?file=${encodeURIComponent(file)}`
      + (detail === 'full' ? '&detail=full' : '')
      + (expand.length ? `&expand=${encodeURIComponent(expand.join(','))}` : '')
      + (expand.length && steps > 0 ? `&steps=${steps}` : ''),
      { credentials: 'same-origin' },
    )
    .then(json<{ ok: true; result: SessionTreeGraph }>)
    .then(payload => {
      const graph = payload?.result
      if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.sessions)) {
        throw new LiveSessionApiError(502, 'session_tree_unavailable', '会话图谱接口不可用：后端可能是旧版本，请重启 dashboard（./run.sh）')
      }
      return graph
    }),
  /**
   * Task anchor of one session file.
   *
   * Read-only, and deliberately keyed by file so a session that is no longer
   * running still answers: the checklist of a finished task is exactly what gets
   * lost once the process is gone.
   */
  sessionGoal: (file: string) => fetch(
    `/api/session-goal?file=${encodeURIComponent(file)}`,
    { credentials: 'same-origin' },
  )
    .then(json<{ ok: true; result: { goal: import('@shared/goal-anchor').GoalAnchor | null; partial: boolean } }>)
    .then(payload => {
      const result = payload?.result
      if (!result || typeof result !== 'object' || !('goal' in result)) {
        throw new LiveSessionApiError(502, 'session_goal_unavailable', '任务锚点接口不可用：后端可能是旧版本，请重启 dashboard（./run.sh）')
      }
      return result
    }),
  /**
   * Compaction markers of one session file.
   *
   * `/compact` is fire-and-forget agent-side (`ctx.compact()` does not await), so
   * the command ack cannot say when compaction finished. The UI polls these
   * markers and compares them against the returned server `now`, because the
   * browser clock may be skewed from the machine writing the session file.
   */
  compactions: (file: string) => fetch(
    `/api/session-compactions?file=${encodeURIComponent(file)}`,
    { credentials: 'same-origin' },
  )
    .then(json<{ ok: true; result: { now: number; compactions: CompactionMark[] } }>)
    .then(payload => {
      const result = payload?.result
      if (!result || !Array.isArray(result.compactions) || typeof result.now !== 'number') {
        throw new LiveSessionApiError(502, 'compactions_unavailable', '压缩状态接口不可用：后端可能是旧版本，请重启 dashboard（./run.sh）')
      }
      return result
    }),
  /**
   * Session-tree write actions. These ride the EXISTING `input` command channel
   * (the bridge registers `/ls-navigate` and `/ls-fork` extension commands), so
   * no wire-protocol version bump is involved.
   */
  sessionTreeAction: (processInstanceId: string, text: string) => post<{ ok: true; result: unknown }>(
    `/api/live-sessions/${encodeURIComponent(processInstanceId)}/commands`, { command: { type: 'input', channel: 'web', text } },
  ),
}
