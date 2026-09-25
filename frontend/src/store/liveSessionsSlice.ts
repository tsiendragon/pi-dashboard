import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type {
  LiveSessionDetail,
  LiveSessionEventMessage,
  LiveSessionImage,
  LiveSessionSummary,
  LiveSessionUiRequest,
} from '@shared/live-sessions'

export interface LiveSessionDetailState extends LiveSessionDetail {
  needsResync?: boolean
}

export interface LiveSessionsState {
  auth: 'checking' | 'required' | 'authenticated'
  browserClientId?: string
  sessions: Record<string, LiveSessionSummary>
  details: Record<string, LiveSessionDetailState>
  ownedLeases: Record<string, string>
  activeId?: string
  wsConnected: boolean
  error?: string
  /** Pending extension UI requests per session (L1 `extension_ui` → answered via `answer_ui`). */
  pendingUi: Record<string, Record<string, LiveSessionUiRequest>>
  /** One-way extension notifications per session (L1 `extension_ui_notify`, e.g. /goal command options). */
  notifications: Record<string, LiveSessionNotification[]>
}

export interface LiveSessionNotification {
  message: string
  notifyType: 'info' | 'warning' | 'error'
}

const initialState: LiveSessionsState = {
  auth: 'checking',
  sessions: {},
  details: {},
  ownedLeases: {},
  wsConnected: false,
  pendingUi: {},
  notifications: {},
}

function upsertSummary(state: LiveSessionsState, summary: LiveSessionSummary): boolean {
  const previous = state.sessions[summary.processInstanceId]
  if (previous && summary.revision < previous.revision) return false
  state.sessions[summary.processInstanceId] = {
    ...summary,
    claim: { ...summary.claim },
  }
  return true
}

function eventKey(message: LiveSessionEventMessage): string | undefined {
  const data = message.event.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const record = data as Record<string, unknown>
  const nestedMessage = record.message && typeof record.message === 'object' ? record.message as Record<string, unknown> : undefined
  const id = record.messageId || record.toolCallId || record.id || nestedMessage?.id
  return typeof id === 'string' ? `${message.event.type}:${id}` : undefined
}

function messageText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  const text = value.map(part => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return ''
    const record = part as Record<string, unknown>
    return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
  }).filter(Boolean).join('\n')
  return text || undefined
}

function removeMatchingOptimisticUserMessage(detail: LiveSessionDetailState, message: LiveSessionEventMessage): void {
  const data = message.event.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return
  const nested = (data as Record<string, unknown>).message
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return
  const record = nested as Record<string, unknown>
  if (record.role !== 'user') return
  const text = messageText(record.content)
  for (let index = detail.entries.length - 1; index >= 0; index--) {
    const entry = detail.entries[index]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const candidate = entry as Record<string, unknown>
    if (!candidate.dashboardLocalId) continue
    const candidateMessage = candidate.message
    if (!candidateMessage || typeof candidateMessage !== 'object' || Array.isArray(candidateMessage)) continue
    if (messageText((candidateMessage as Record<string, unknown>).content) === text) {
      detail.entries.splice(index, 1)
      return
    }
  }
}

function appendEvent(detail: LiveSessionDetailState, message: LiveSessionEventMessage): void {
  const next = { ...message.event, sequence: message.sequence }
  const type = message.event.type
  const key = eventKey(message)
  removeMatchingOptimisticUserMessage(detail, message)
  if (type === 'message_entry') {
    // The bridge can only read a message's session-entry id AFTER pi persists it,
    // so it arrives as a follow-up event. Fold it into the message it belongs to
    // (the nearest preceding `message_end` — nothing else can complete in the one
    // macrotask in between) and never render the carrier.
    const carrier = message.event.data && typeof message.event.data === 'object' && !Array.isArray(message.event.data)
      ? message.event.data as Record<string, unknown> : undefined
    const entryId = typeof carrier?.entryId === 'string' ? carrier.entryId : undefined
    if (entryId) {
      for (let index = detail.entries.length - 1; index >= 0; index--) {
        const candidate = detail.entries[index]
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
        const record = candidate as Record<string, unknown>
        if (record.type !== 'message_end') continue
        const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
          ? record.data as Record<string, unknown> : {}
        detail.entries[index] = { ...record, data: { ...data, entryId } }
        break
      }
    }
    return
  }
  if (type === 'live_feature_snapshot') {
    const feature = message.event.data && typeof message.event.data === 'object' && !Array.isArray(message.event.data)
      ? (message.event.data as Record<string, unknown>).feature : undefined
    const index = detail.entries.findIndex(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
      const record = entry as Record<string, unknown>
      const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : undefined
      return record.type === type && data?.feature === feature
    })
    if (index >= 0) detail.entries[index] = next
    else detail.entries.push(next)
    return
  }
  if (type === 'message_update' || type === 'tool_execution_update') {
    let index = -1
    for (let candidateIndex = detail.entries.length - 1; candidateIndex >= 0; candidateIndex--) {
      const entry = detail.entries[candidateIndex]
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const candidate = entry as Record<string, unknown>
      if (candidate.type !== type) continue
      if (!key) { index = candidateIndex; break }
      const candidateMessage: LiveSessionEventMessage = {
        type: 'event', processInstanceId: message.processInstanceId,
        sequence: Number(candidate.sequence) || 0,
        event: candidate as LiveSessionEventMessage['event'],
      }
      if (eventKey(candidateMessage) === key) { index = candidateIndex; break }
    }
    if (index >= 0) detail.entries[index] = next
    else detail.entries.push(next)
  } else {
    if (type === 'message_end') {
      for (let index = detail.entries.length - 1; index >= 0; index--) {
        const candidate = detail.entries[index]
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
        const candidateType = (candidate as Record<string, unknown>).type
        if (candidateType === 'message_update') detail.entries.splice(index, 1)
        else if (candidateType === 'message_end' || candidateType === 'message') break
      }
      const data = message.event.data && typeof message.event.data === 'object' && !Array.isArray(message.event.data)
        ? (message.event.data as Record<string, unknown>).message : undefined
      const serialized = JSON.stringify(data)
      const duplicate = detail.entries.slice(-3).some(candidate => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
        const record = candidate as Record<string, unknown>
        const candidateData = record.type === 'message' ? record.message
          : record.type === 'message_end' && record.data && typeof record.data === 'object' && !Array.isArray(record.data)
            ? (record.data as Record<string, unknown>).message : undefined
        return candidateData !== undefined && JSON.stringify(candidateData) === serialized
      })
      if (duplicate) return
    }
    if (type === 'tool_execution_end') {
      for (let index = detail.entries.length - 1; index >= 0; index--) {
        const candidate = detail.entries[index]
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
        const candidateType = (candidate as Record<string, unknown>).type
        if (candidateType === 'tool_execution_update' || candidateType === 'tool_execution_start') detail.entries.splice(index, 1)
        else if (candidateType === 'tool_execution_end') break
      }
    }
    if (type !== 'message_start') detail.entries.push(next)
  }
  if (detail.entries.length > 1_000) detail.entries.splice(0, detail.entries.length - 1_000)
}

/** Index the registry's pending-dialog mirror by request id for the slice state. */
function pendingUiBucket(requests: LiveSessionUiRequest[] | undefined): Record<string, LiveSessionUiRequest> {
  return Object.fromEntries((requests ?? []).map(request => [request.id, request]))
}

function normalizeEntries(summary: LiveSessionSummary, entries: unknown[]): unknown[] {
  const detail: LiveSessionDetailState = { summary: { ...summary, claim: { ...summary.claim } }, entries: [] }
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof (entry as Record<string, unknown>).type !== 'string') {
      detail.entries.push(entry)
      return
    }
    const record = entry as LiveSessionEventMessage['event']
    if (record.type === 'message_start' || record.type === 'message_update' || record.type === 'message_end'
      || record.type === 'tool_execution_start' || record.type === 'tool_execution_update' || record.type === 'tool_execution_end'
      || record.type === 'live_feature_snapshot') {
      appendEvent(detail, { type: 'event', processInstanceId: summary.processInstanceId, sequence: index + 1, event: record })
    } else {
      detail.entries.push(entry)
    }
  })
  return detail.entries
}

const liveSessionsSlice = createSlice({
  name: 'liveSessions',
  initialState,
  reducers: {
    authRequired(state, action: PayloadAction<string | undefined>) {
      state.auth = 'required'
      state.browserClientId = undefined
      state.wsConnected = false
      state.error = action.payload
    },
    authenticated(state, action: PayloadAction<{ browserClientId?: string } | undefined>) {
      state.auth = 'authenticated'
      if (action.payload?.browserClientId) state.browserClientId = action.payload.browserClientId
      state.error = undefined
    },
    authChecking(state) { state.auth = 'checking'; state.error = undefined },
    setLiveSessionError(state, action: PayloadAction<string | undefined>) { state.error = action.payload },
    setLiveWebSocketConnected(state, action: PayloadAction<boolean>) { state.wsConnected = action.payload },
    sessionsLoaded(state, action: PayloadAction<{ sessions: LiveSessionSummary[]; browserClientId?: string }>) {
      const nextIds = new Set(action.payload.sessions.map(summary => summary.processInstanceId))
      for (const id of Object.keys(state.sessions)) if (!nextIds.has(id)) delete state.sessions[id]
      for (const summary of action.payload.sessions) upsertSummary(state, summary)
      if (action.payload.browserClientId) state.browserClientId = action.payload.browserClientId
      state.auth = 'authenticated'
    },
    liveSessionAttached(state, action: PayloadAction<LiveSessionDetail | { sessions: LiveSessionSummary[] }>) {
      if ('sessions' in action.payload) {
        for (const summary of action.payload.sessions) upsertSummary(state, summary)
        return
      }
      if (!upsertSummary(state, action.payload.summary)) return
      state.details[action.payload.summary.processInstanceId] = {
        summary: { ...action.payload.summary, claim: { ...action.payload.summary.claim } },
        entries: normalizeEntries(action.payload.summary, action.payload.entries),
      }
      // The registry is authoritative for unanswered dialogs, so a fresh attach
      // restores them (a reconnected browser would otherwise never see them).
      state.pendingUi[action.payload.summary.processInstanceId] = pendingUiBucket(action.payload.pendingUi)
    },
    liveSessionSnapshot(state, action: PayloadAction<LiveSessionDetail>) {
      const incoming = action.payload
      const current = state.details[incoming.summary.processInstanceId]
      // A snapshot is fresh when it carries a newer revision OR a newer event
      // sequence. The eventSequence half matters for recovery: `revision` only
      // advances when the session pushes a snapshot (connect / fork / tree ops /
      // resync), so a browser resync fetch usually returns the same revision as
      // the copy we already hold. Gating on revision alone discarded exactly the
      // payload needed to heal missed events and froze the transcript until a
      // full page reload.
      const fresh = !current
        || incoming.summary.revision > current.summary.revision
        || incoming.summary.eventSequence > current.summary.eventSequence
      if (!fresh) return
      // Replacing the detail also drops any stale `needsResync` flag: the
      // snapshot now covers every event the flag was set for.
      state.sessions[incoming.summary.processInstanceId] = { ...incoming.summary, claim: { ...incoming.summary.claim } }
      state.details[incoming.summary.processInstanceId] = {
        summary: { ...incoming.summary, claim: { ...incoming.summary.claim } },
        entries: normalizeEntries(incoming.summary, incoming.entries),
      }
      // Snapshot replaces the pending-dialog mirror too: it is what makes a
      // page switch (WS reconnect) bring an unanswered dialog back.
      state.pendingUi[incoming.summary.processInstanceId] = pendingUiBucket(incoming.pendingUi)
    },
    liveSessionEvent(state, action: PayloadAction<LiveSessionEventMessage>) {
      const message = action.payload
      const detail = state.details[message.processInstanceId]
      const summary = state.sessions[message.processInstanceId]
      if (!detail || !summary) return
      const currentSequence = detail.summary.eventSequence
      if (message.sequence <= currentSequence) return
      if (message.sequence !== currentSequence + 1) {
        detail.needsResync = true
        return
      }
      detail.summary.eventSequence = message.sequence
      detail.summary.lastActivityAt = Date.now()
      summary.eventSequence = message.sequence
      summary.lastActivityAt = detail.summary.lastActivityAt
      if (message.event.type === 'agent_start') {
        detail.summary.status = 'running'
        summary.status = 'running'
      } else if (message.event.type === 'agent_settled') {
        detail.summary.status = 'idle'
        summary.status = 'idle'
      } else if (message.event.type === 'session_info_changed' && message.event.data && typeof message.event.data === 'object' && !Array.isArray(message.event.data)) {
        const name = (message.event.data as Record<string, unknown>).name
        if (typeof name === 'string' || name === null) {
          detail.summary.sessionName = typeof name === 'string' ? name : undefined
          summary.sessionName = typeof name === 'string' ? name : undefined
        }
      }
      if (message.event.type === 'extension_ui' || message.event.type === 'extension_ui_closed') {
        const data = message.event.data as Record<string, unknown> | undefined
        const uiId = data && typeof data.id === 'string' ? data.id : undefined
        if (uiId) {
          const bucket = state.pendingUi[message.processInstanceId] ?? (state.pendingUi[message.processInstanceId] = {})
          if (message.event.type === 'extension_ui' && data) {
            bucket[uiId] = {
              id: uiId,
              method: (typeof data.method === 'string' ? data.method : 'confirm') as LiveSessionUiRequest['method'],
              title: typeof data.title === 'string' ? data.title : '',
              ...(typeof data.message === 'string' ? { message: data.message } : {}),
              ...(Array.isArray(data.options) ? { options: data.options.filter((o): o is string => typeof o === 'string') } : {}),
              ...(typeof data.placeholder === 'string' ? { placeholder: data.placeholder } : {}),
              ...(typeof data.prefill === 'string' ? { prefill: data.prefill } : {}),
            }
          } else {
            delete bucket[uiId]
          }
        }
      }
      if (message.event.type === 'extension_ui_notify') {
        const data = message.event.data as Record<string, unknown> | undefined
        const text = data && typeof data.message === 'string' ? data.message : undefined
        if (text) {
          const notifyType: LiveSessionNotification['notifyType'] =
            data?.notifyType === 'warning' || data?.notifyType === 'error' ? data.notifyType : 'info'
          const list = state.notifications[message.processInstanceId] ?? (state.notifications[message.processInstanceId] = [])
          list.push({ message: text, notifyType })
          if (list.length > 20) list.splice(0, list.length - 20)
        }
      }
      appendEvent(detail, message)
    },
    liveSessionClaimChanged(state, action: PayloadAction<LiveSessionSummary>) {
      upsertSummary(state, action.payload)
      const detail = state.details[action.payload.processInstanceId]
      if (detail) detail.summary.claim = { ...action.payload.claim }
      if (action.payload.claim.state === 'unclaimed') delete state.ownedLeases[action.payload.processInstanceId]
    },
    liveSessionReconnecting(state, action: PayloadAction<LiveSessionSummary>) {
      upsertSummary(state, { ...action.payload, status: 'reconnecting' })
      const detail = state.details[action.payload.processInstanceId]
      if (detail) detail.summary.status = 'reconnecting'
    },
    liveSessionDetached(state, action: PayloadAction<{ summary: LiveSessionSummary; reason?: string }>) {
      const id = action.payload.summary.processInstanceId
      delete state.sessions[id]
      delete state.details[id]
      delete state.ownedLeases[id]
      delete state.pendingUi[id]
      delete state.notifications[id]
      if (state.activeId === id) state.activeId = undefined
    },
    liveSessionOwned(state, action: PayloadAction<{ processInstanceId: string; leaseId: string; expiresAt?: number }>) {
      const { processInstanceId, leaseId, expiresAt } = action.payload
      state.ownedLeases[processInstanceId] = leaseId
      const summary = state.sessions[processInstanceId]
      if (summary) summary.claim = { state: 'claimed', leaseId, expiresAt }
      const detail = state.details[processInstanceId]
      if (detail) detail.summary.claim = { state: 'claimed', leaseId, expiresAt }
    },
    liveSessionReleased(state, action: PayloadAction<string>) {
      const id = action.payload
      delete state.ownedLeases[id]
      const summary = state.sessions[id]
      if (summary) summary.claim = { state: 'unclaimed' }
      const detail = state.details[id]
      if (detail) detail.summary.claim = { state: 'unclaimed' }
    },
    liveSessionUserMessageAdded(state, action: PayloadAction<{ processInstanceId: string; localId: string; text: string; images?: LiveSessionImage[]; deliverAs?: 'steer' | 'followUp' }>) {
      const detail = state.details[action.payload.processInstanceId]
      if (!detail) return
      const content = action.payload.images?.length
        ? [{ type: 'text' as const, text: action.payload.text }, ...action.payload.images]
        : action.payload.text
      detail.entries.push({
        type: 'message',
        dashboardLocalId: action.payload.localId,
        // A prompt sent while Pi is working is queued, not handled. Remember how it
        // was delivered so the bubble can say “排队中” until Pi echoes it back.
        ...(action.payload.deliverAs
          ? { dashboardDeliverAs: action.payload.deliverAs, dashboardQueueState: 'sending' as const }
          : {}),
        message: { role: 'user', content },
      })
    },
    /** The bridge accepted a queued input: it is now Pi's turn to pick it up. */
    liveSessionUserMessageAcknowledged(state, action: PayloadAction<{ processInstanceId: string; localId: string }>) {
      const detail = state.details[action.payload.processInstanceId]
      if (!detail) return
      for (const entry of detail.entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
        const candidate = entry as Record<string, unknown>
        if (candidate.dashboardLocalId !== action.payload.localId) continue
        candidate.dashboardQueueState = 'queued'
      }
    },
    liveSessionUserMessageRemoved(state, action: PayloadAction<{ processInstanceId: string; localId: string }>) {
      const detail = state.details[action.payload.processInstanceId]
      if (!detail) return
      const index = detail.entries.findIndex(entry => !!entry && typeof entry === 'object' && !Array.isArray(entry)
        && (entry as Record<string, unknown>).dashboardLocalId === action.payload.localId)
      if (index >= 0) detail.entries.splice(index, 1)
    },
    uiAnswered(state, action: PayloadAction<{ processInstanceId: string; id: string }>) {
      const bucket = state.pendingUi[action.payload.processInstanceId]
      if (bucket) delete bucket[action.payload.id]
    },
    dismissSessionNotifications(state, action: PayloadAction<string>) {
      delete state.notifications[action.payload]
    },
    selectLiveSession(state, action: PayloadAction<string | undefined>) { state.activeId = action.payload },
    clearLiveSessions(state) {
      state.sessions = {}
      state.details = {}
      state.ownedLeases = {}
      state.pendingUi = {}
      state.notifications = {}
      state.activeId = undefined
      state.wsConnected = false
    },
  },
})

export const {
  authRequired, authenticated, authChecking, setLiveSessionError, setLiveWebSocketConnected,
  sessionsLoaded, liveSessionAttached, liveSessionSnapshot, liveSessionEvent,
  liveSessionClaimChanged, liveSessionReconnecting, liveSessionDetached,
  liveSessionOwned, liveSessionReleased, liveSessionUserMessageAdded,
  liveSessionUserMessageRemoved, liveSessionUserMessageAcknowledged, selectLiveSession, clearLiveSessions, uiAnswered,
  dismissSessionNotifications,
} = liveSessionsSlice.actions

export default liveSessionsSlice.reducer
