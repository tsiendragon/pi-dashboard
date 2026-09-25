import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import {
  type LiveSessionCommand,
  type LiveSessionCommandEnvelope,
  type LiveSessionCommandResult,
  type LiveSessionDetail,
  type LiveSessionEventMessage,
  type LiveSessionHello,
  type LiveSessionReloadResult,
  type LiveSessionSnapshot,
  type LiveSessionSummary,
  type LiveSessionUiRequest,
} from '../../shared/src/live-sessions.js'
import { PI_SUBAGENT_CHILD_ENV, readProcessEnviron } from './process-env.js'
import { validateLiveSessionCommand } from './protocol.js'

export interface LiveSessionTransport {
  send(message: LiveSessionCommandEnvelope | { type: 'welcome'; protocolVersion: 2; heartbeatMs: number }): void
  close?(): void
}

export class LiveSessionRegistryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'LiveSessionRegistryError'
  }
}

type PendingCommand = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type SessionLineage = Pick<LiveSessionSummary, 'role' | 'parentSessionId' | 'parentToolCallId' | 'subagentWorkId'>

type Entry = {
  transport: LiveSessionTransport
  lineage?: SessionLineage
  hello: LiveSessionHello
  canonicalCwd: string
  summary?: LiveSessionSummary
  entries: unknown[]
  revision: number
  sequence: number
  awaitingResync: boolean
  attached: boolean
  pending: Map<string, PendingCommand>
  /** Unanswered extension UI requests, mirrored for reconnect/page-switch recovery. */
  pendingUi: Map<string, LiveSessionUiRequest>
  dispatchTail: Promise<unknown>
  reconnectTimer?: ReturnType<typeof setTimeout>
  leaseTimer?: ReturnType<typeof setTimeout>
  leaseOwner?: string
}

export interface LiveSessionRegistryOptions {
  commandTimeoutMs?: number
  disconnectGraceMs?: number
  maxTimelineEntries?: number
  now?: () => number
}

function resultRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Project a bridge `extension_ui` payload into the dashboard-side request shape. */
function uiRequestFromEvent(id: string, data: Record<string, unknown> | undefined): LiveSessionUiRequest {
  const options = Array.isArray(data?.options) ? data.options.filter((option): option is string => typeof option === 'string') : undefined
  return {
    id,
    method: (typeof data?.method === 'string' ? data.method : 'confirm') as LiveSessionUiRequest['method'],
    title: typeof data?.title === 'string' ? data.title : '',
    ...(typeof data?.message === 'string' ? { message: data.message } : {}),
    ...(options ? { options } : {}),
    ...(typeof data?.placeholder === 'string' ? { placeholder: data.placeholder } : {}),
    ...(typeof data?.prefill === 'string' ? { prefill: data.prefill } : {}),
  }
}

function inferProcessLineage(pid: number): SessionLineage | undefined {
  try {
    const env = readProcessEnviron(pid)
    if (!env) return undefined
    if (env.get(PI_SUBAGENT_CHILD_ENV) !== '1') return { role: 'main' }
    const raw = env.get('PI_TRACE_CONTEXT')
    const trace = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    const bounded = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value.slice(0, 512) : undefined
    return {
      role: 'subagent',
      ...(bounded(trace.parentSessionId) ? { parentSessionId: bounded(trace.parentSessionId) } : {}),
      ...(bounded(trace.parentToolCallId) ? { parentToolCallId: bounded(trace.parentToolCallId) } : {}),
      ...(bounded(trace.workId) ? { subagentWorkId: bounded(trace.workId) } : {}),
    }
  } catch {
    return undefined
  }
}

export class LiveSessionRegistry extends EventEmitter {
  private readonly entries = new Map<string, Entry>()
  private readonly commandTimeoutMs: number
  private readonly disconnectGraceMs: number
  private readonly maxTimelineEntries: number
  private readonly now: () => number

  constructor(options: LiveSessionRegistryOptions = {}) {
    super()
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000
    this.disconnectGraceMs = options.disconnectGraceMs ?? 15_000
    this.maxTimelineEntries = options.maxTimelineEntries ?? 1_000
    this.now = options.now || Date.now
  }

  connect(hello: LiveSessionHello, canonicalCwd: string, transport: LiveSessionTransport): void {
    const existing = this.entries.get(hello.processInstanceId)
    if (existing) {
      if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer)
      if (existing.transport !== transport) existing.transport.close?.()
      this.rejectPending(existing, 'live_session_reconnected', 'live session connection was replaced')
      existing.transport = transport
      existing.hello = hello
      existing.lineage = inferProcessLineage(hello.pid)
      existing.canonicalCwd = canonicalCwd
      existing.awaitingResync = true
      existing.dispatchTail = Promise.resolve()
      return
    }
    this.entries.set(hello.processInstanceId, {
      transport,
      hello,
      lineage: inferProcessLineage(hello.pid),
      canonicalCwd,
      entries: [],
      revision: -1,
      sequence: -1,
      awaitingResync: true,
      attached: false,
      pending: new Map(),
      pendingUi: new Map(),
      dispatchTail: Promise.resolve(),
    })
  }

  applySnapshot(snapshot: LiveSessionSnapshot, transport: LiveSessionTransport, canonicalCwd: string): boolean {
    const entry = this.requireConnection(snapshot.processInstanceId, transport)
    if (snapshot.summary.processInstanceId !== entry.hello.processInstanceId || snapshot.summary.pid !== entry.hello.pid) {
      throw new LiveSessionRegistryError('identity_mismatch', 'snapshot identity does not match hello')
    }
    const previousSessionId = entry.summary?.sessionId
    const sessionChanged = !!previousSessionId && previousSessionId !== snapshot.summary.sessionId
    // An in-process session switch (`/clear`, `/ls-fork`) rebuilds the extension's
    // projector, whose revision/sequence restart at 1/0, while the entry's cursor
    // still holds the finished numbering of the previous session. Applying that
    // cursor would reject every snapshot of the new session until it happened to
    // count past the old position — i.e. the row would sit on “重连中” for ages.
    if (!sessionChanged && snapshot.revision <= entry.revision) return false
    if (sessionChanged) this.clearLease(entry)
    // A session switch (`/clear`, `/ls-fork`) ends the previous session's dialogs.
    if (sessionChanged) entry.pendingUi.clear()
    entry.canonicalCwd = canonicalCwd
    entry.revision = snapshot.revision
    entry.sequence = snapshot.sequence
    entry.awaitingResync = false
    entry.entries = snapshot.entries.slice(-this.maxTimelineEntries)
    entry.summary = {
      ...snapshot.summary,
      ...(!snapshot.summary.role && entry.lineage ? entry.lineage : {}),
      processInstanceId: entry.hello.processInstanceId,
      pid: entry.hello.pid,
      cwd: snapshot.summary.cwd,
      canonicalCwd,
      mode: entry.hello.mode,
      revision: snapshot.revision,
      eventSequence: snapshot.sequence,
    }
    const orphanedLeaseId = !entry.leaseOwner && entry.summary.claim.state === 'claimed'
      ? entry.summary.claim.leaseId
      : undefined
    if (orphanedLeaseId) entry.summary.claim = { state: 'unclaimed' }
    const wasAttached = entry.attached
    entry.attached = true
    this.emit(wasAttached ? 'snapshot' : 'attached', this.detailOf(entry))
    if (sessionChanged || orphanedLeaseId) this.emit('claim_changed', entry.summary)
    if (orphanedLeaseId) {
      void this.dispatch(snapshot.processInstanceId, { type: 'release', leaseId: orphanedLeaseId }).catch(() => {})
    }
    // A brand-new entry starts with an empty dialog mirror, so ask the bridge to
    // replay the unanswered dialogs pi is still holding (a browser alone cannot
    // reconstruct them from the snapshot protocol).
    if (!wasAttached) {
      void this.dispatch(entry.hello.processInstanceId, { type: 'resync' }).catch(() => {})
    }
    return true
  }

  applyEvent(message: LiveSessionEventMessage, transport: LiveSessionTransport): boolean {
    const entry = this.requireConnection(message.processInstanceId, transport)
    if (!entry.summary || entry.awaitingResync) return false
    if (message.sequence !== entry.sequence + 1) {
      entry.awaitingResync = true
      this.sendResync(entry)
      return false
    }
    entry.sequence = message.sequence
    entry.summary.eventSequence = message.sequence
    entry.summary.lastActivityAt = this.now()
    this.projectEvent(entry, message)
    this.appendTimelineEvent(entry, message.event)
    if (entry.entries.length > this.maxTimelineEntries) entry.entries.splice(0, entry.entries.length - this.maxTimelineEntries)
    this.emit('event', message)
    return true
  }

  heartbeat(processInstanceId: string, transport: LiveSessionTransport, at: number): void {
    const entry = this.requireConnection(processInstanceId, transport)
    if (entry.summary) entry.summary.lastActivityAt = Math.max(entry.summary.lastActivityAt, at)
  }

  handleCommandResult(result: LiveSessionCommandResult, transport: LiveSessionTransport): void {
    const entry = [...this.entries.values()].find(candidate => candidate.transport === transport)
    if (!entry) return
    const pending = entry.pending.get(result.requestId)
    if (!pending) return
    entry.pending.delete(result.requestId)
    clearTimeout(pending.timer)
    if (result.ok) pending.resolve(result.result)
    else pending.reject(new LiveSessionRegistryError(result.error?.code || 'command_failed', result.error?.message || 'live session command failed'))
  }

  disconnect(processInstanceId: string, transport: LiveSessionTransport, reason = 'connection_closed'): void {
    const entry = this.entries.get(processInstanceId)
    if (!entry || entry.transport !== transport) return
    this.rejectPending(entry, 'live_session_disconnected', 'live session disconnected')
    if (!entry.summary) {
      this.detach(processInstanceId, reason, transport)
      return
    }
    entry.awaitingResync = true
    entry.summary.status = 'reconnecting'
    this.emit('reconnecting', entry.summary)
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
    entry.reconnectTimer = setTimeout(() => this.detach(processInstanceId, reason, transport), this.disconnectGraceMs)
    entry.reconnectTimer.unref?.()
  }

  detach(processInstanceId: string, reason = 'detached', transport?: LiveSessionTransport): void {
    const entry = this.entries.get(processInstanceId)
    if (!entry || (transport && entry.transport !== transport)) return
    this.entries.delete(processInstanceId)
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
    this.clearLease(entry)
    this.rejectPending(entry, 'live_session_detached', 'live session detached')
    if (entry.attached && entry.summary) this.emit('detached', { summary: entry.summary, reason })
  }

  list(): LiveSessionSummary[] {
    return [...this.entries.values()]
      .filter(entry => entry.attached && !!entry.summary)
      .map(entry => ({ ...entry.summary!, claim: { ...entry.summary!.claim } }))
      .sort((left, right) => left.startedAt - right.startedAt || left.processInstanceId.localeCompare(right.processInstanceId))
  }

  get(processInstanceId: string): LiveSessionDetail | undefined {
    const entry = this.entries.get(processInstanceId)
    return entry?.attached && entry.summary ? this.detailOf(entry) : undefined
  }

  /** Return metadata for usage accounting even when this process is not the newest process for its cwd. */
  getSummaryForUsage(processInstanceId: string): LiveSessionSummary | undefined {
    const entry = this.entries.get(processInstanceId)
    return entry?.summary ? { ...entry.summary, claim: { ...entry.summary.claim } } : undefined
  }

  async dispatch(processInstanceId: string, command: LiveSessionCommand): Promise<unknown> {
    const validated = validateLiveSessionCommand(command)
    const entry = this.entries.get(processInstanceId)
    if (!entry?.attached || !entry.summary || entry.awaitingResync) throw new LiveSessionRegistryError('live_session_unavailable', 'live session is unavailable')
    const run = () => this.dispatchNow(entry, validated)
    const result = entry.dispatchTail.then(run, run)
    entry.dispatchTail = result.catch(() => undefined)
    return result
  }

  async claim(processInstanceId: string, browserClientId: string, requestedLeaseMs: number): Promise<unknown> {
    const entry = this.requireAttached(processInstanceId)
    if (entry.summary!.claim.state === 'claimed') {
      if (entry.leaseOwner !== browserClientId) {
        throw new LiveSessionRegistryError('session_already_claimed', 'live session is already claimed')
      }
      return {
        state: 'claimed',
        leaseId: entry.summary!.claim.leaseId,
        expiresAt: entry.summary!.claim.expiresAt,
        alreadyClaimed: true,
      }
    }
    const result = await this.dispatch(processInstanceId, { type: 'claim', browserClientId, requestedLeaseMs })
    const data = resultRecord(result)
    const leaseId = typeof data?.leaseId === 'string' ? data.leaseId : undefined
    if (!leaseId) throw new LiveSessionRegistryError('invalid_command_result', 'claim result did not include a leaseId')
    const expiresAt = typeof data?.expiresAt === 'number' ? data.expiresAt : this.now() + requestedLeaseMs
    entry.leaseOwner = browserClientId
    entry.summary!.claim = { state: 'claimed', leaseId, expiresAt }
    this.scheduleLeaseExpiry(entry, expiresAt)
    this.emit('claim_changed', entry.summary)
    return result
  }

  async renew(processInstanceId: string, browserClientId: string, leaseId: string): Promise<unknown> {
    const entry = this.requireLease(processInstanceId, browserClientId, leaseId)
    const result = await this.dispatch(processInstanceId, { type: 'renew', leaseId })
    const data = resultRecord(result)
    const expiresAt = typeof data?.expiresAt === 'number' ? data.expiresAt : this.now() + 30_000
    entry.summary!.claim.expiresAt = expiresAt
    this.scheduleLeaseExpiry(entry, expiresAt)
    this.emit('claim_changed', entry.summary)
    return result
  }

  async release(processInstanceId: string, browserClientId: string, leaseId?: string): Promise<unknown> {
    const entry = this.requireAttached(processInstanceId)
    if (entry.summary!.claim.state === 'unclaimed') return { released: false }
    const activeLeaseId = entry.summary!.claim.leaseId
    if (entry.leaseOwner !== browserClientId || !leaseId || activeLeaseId !== leaseId) {
      throw new LiveSessionRegistryError('invalid_lease', 'lease does not belong to this browser')
    }
    try {
      return await this.dispatch(processInstanceId, { type: 'release', leaseId })
    } finally {
      this.clearLease(entry)
      this.emit('claim_changed', entry.summary)
    }
  }

  async sendBrowserCommand(processInstanceId: string, browserClientId: string, command: unknown): Promise<unknown> {
    const validated = validateLiveSessionCommand(command, true)
    if (validated.type !== 'input' && validated.type !== 'abort' && validated.type !== 'set_session_name' && validated.type !== 'get_models' && validated.type !== 'set_model' && validated.type !== 'compact' && validated.type !== 'reload' && validated.type !== 'feature_command' && validated.type !== 'answer_ui') {
      throw new LiveSessionRegistryError('unsupported_command', 'browser command is not allowed')
    }
    // answer_ui settles a pending extension UI request (first answer wins), so it
    // is deliberately dispatchable without holding the lease.
    if (validated.type === 'input' || validated.type === 'set_session_name' || validated.type === 'get_models' || validated.type === 'set_model' || validated.type === 'reload' || validated.type === 'answer_ui') return this.dispatch(processInstanceId, validated)
    this.requireLease(processInstanceId, browserClientId, validated.leaseId)
    return this.dispatch(processInstanceId, validated)
  }

  async releaseByBrowser(browserClientId: string): Promise<void> {
    const releases: Promise<unknown>[] = []
    for (const [processInstanceId, entry] of this.entries) {
      if (entry.leaseOwner !== browserClientId || !entry.summary?.claim.leaseId) continue
      releases.push(this.release(processInstanceId, browserClientId, entry.summary.claim.leaseId).catch(() => {
        this.clearLease(entry)
        this.emit('claim_changed', entry.summary)
      }))
    }
    await Promise.allSettled(releases)
  }

  /**
   * Reload every attached session in one shot — the bulk counterpart of the
   * per-session `重载` button, for when dashboard extensions, skills, prompts or
   * themes changed and every running Pi has to re-read them.
   *
   * Each session is dispatched independently so one unreachable process cannot
   * hold up the rest; per-session failures are collected rather than thrown.
   * Subagent child processes are skipped: restarting one mid-run would silently
   * discard the task it is executing.
   */
  async reloadAll(): Promise<LiveSessionReloadResult> {
    const sessions = this.list()
    const reloaded: string[] = []
    const skipped: string[] = []
    const failed: LiveSessionReloadResult['failed'] = []
    await Promise.all(sessions.map(async session => {
      if (session.role === 'subagent') { skipped.push(session.processInstanceId); return }
      try {
        await this.dispatch(session.processInstanceId, { type: 'reload' })
        reloaded.push(session.processInstanceId)
      } catch (error) {
        failed.push({
          processInstanceId: session.processInstanceId,
          code: error instanceof LiveSessionRegistryError ? error.code : 'reload_failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }))
    // Dispatches settle in arbitrary order; report in the sidebar's own order.
    const rank = new Map(sessions.map((session, index) => [session.processInstanceId, index]))
    const byRank = (left: string, right: string) => (rank.get(left) ?? 0) - (rank.get(right) ?? 0)
    return {
      reloaded: reloaded.sort(byRank),
      skipped: skipped.sort(byRank),
      failed: failed.sort((left, right) => byRank(left.processInstanceId, right.processInstanceId)),
    }
  }

  async stop(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    for (const entry of entries) {
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
      this.clearLease(entry)
      this.rejectPending(entry, 'broker_stopped', 'live session broker stopped')
      entry.transport.close?.()
    }
    this.removeAllListeners()
  }

  cleanup(): Promise<void> {
    return this.stop()
  }

  private timelineIdentity(event: LiveSessionEventMessage['event']): string | undefined {
    const data = resultRecord(event.data)
    const message = resultRecord(data?.message)
    const id = data?.messageId ?? data?.toolCallId ?? data?.id ?? message?.id
    if (typeof id === 'string') return id
    if (event.type.startsWith('message_') && typeof message?.role === 'string') return `message:${message.role}`
    if (event.type.startsWith('tool_execution_') && typeof data?.toolName === 'string') return `tool:${data.toolName}`
    return undefined
  }

  private appendTimelineEvent(entry: Entry, event: LiveSessionEventMessage['event']): void {
    const type = event.type
    if (type === 'message_start') return
    // Dialog and notify events surface as pending-dialog / notification state, not
    // as transcript rows. They are also replayed on resync, so keeping them out of
    // the timeline avoids duplicate "extension ui" noise.
    if (type === 'extension_ui' || type === 'extension_ui_closed' || type === 'extension_ui_notify') return
    if (type === 'message_entry') {
      // The bridge can only read a message's session-entry id AFTER pi persists
      // it, so it publishes the id as a follow-up event. Fold it into the message
      // it belongs to (the nearest preceding `message_end` — nothing else can
      // complete in the one macrotask in between) and never render the carrier.
      const raw = resultRecord(event.data)?.entryId
      const entryId = typeof raw === 'string' ? raw : undefined
      if (entryId) {
        for (let index = entry.entries.length - 1; index >= 0; index--) {
          const candidate = resultRecord(entry.entries[index])
          if (candidate?.type !== 'message_end') continue
          const data = resultRecord(candidate.data) ?? {}
          entry.entries[index] = { ...candidate, data: { ...data, entryId } }
          break
        }
      }
      return
    }
    const identity = this.timelineIdentity(event)
    const matches = (candidate: unknown, candidateType: string): boolean => {
      const record = resultRecord(candidate)
      if (!record || record.type !== candidateType) return false
      const candidateIdentity = this.timelineIdentity(record as LiveSessionEventMessage['event'])
      return identity ? candidateIdentity === identity : true
    }
    if (type === 'live_feature_snapshot') {
      const feature = resultRecord(event.data)?.feature
      let index = -1
      for (let candidateIndex = entry.entries.length - 1; candidateIndex >= 0; candidateIndex--) {
        const candidate = resultRecord(entry.entries[candidateIndex])
        if (candidate?.type !== type) continue
        if (resultRecord(candidate.data)?.feature === feature) { index = candidateIndex; break }
      }
      if (index >= 0) entry.entries[index] = event
      else entry.entries.push(event)
      return
    }
    if (type === 'message_update' || type === 'tool_execution_update') {
      let index = -1
      for (let candidateIndex = entry.entries.length - 1; candidateIndex >= 0; candidateIndex--) {
        if (matches(entry.entries[candidateIndex], type)) { index = candidateIndex; break }
      }
      if (index >= 0) entry.entries[index] = event
      else entry.entries.push(event)
      return
    }
    if (type === 'message_end') {
      entry.entries = entry.entries.filter(candidate => !matches(candidate, 'message_update'))
      const serialized = JSON.stringify(event.data)
      const duplicate = entry.entries.slice(-3).some(candidate => {
        const record = resultRecord(candidate)
        return record?.type === 'message_end' && JSON.stringify(record.data) === serialized
      })
      if (!duplicate) entry.entries.push(event)
      return
    }
    if (type === 'tool_execution_end') {
      entry.entries = entry.entries.filter(candidate => !matches(candidate, 'tool_execution_update') && !matches(candidate, 'tool_execution_start'))
      entry.entries.push(event)
      return
    }
    entry.entries.push(event)
  }

  private projectEvent(entry: Entry, message: LiveSessionEventMessage): void {
    const summary = entry.summary
    if (!summary) return
    const data = resultRecord(message.event.data)
    if (message.event.type === 'agent_start') summary.status = 'running'
    if (message.event.type === 'agent_settled') summary.status = 'idle'
    if (message.event.type === 'session_info_changed' && (typeof data?.name === 'string' || data?.name === null)) {
      summary.sessionName = typeof data.name === 'string' ? data.name : undefined
    }
    if (message.event.type === 'model_select') {
      const model = resultRecord(data?.model)
      if (typeof model?.provider === 'string' && typeof model.id === 'string') summary.model = { provider: model.provider, id: model.id }
    }
    if (message.event.type === 'thinking_level_select' && typeof data?.level === 'string') summary.thinkingLevel = data.level
    if (message.event.type === 'extension_ui' || message.event.type === 'extension_ui_closed') {
      // Mirror the bridge's one-shot dialog events so a browser that reconnects
      // (or comes back to this page) can re-open an unanswered dialog instead of
      // leaving pi blocked on a request nobody can see.
      const uiId = typeof data?.id === 'string' ? data.id : undefined
      if (uiId) {
        if (message.event.type === 'extension_ui') entry.pendingUi.set(uiId, uiRequestFromEvent(uiId, data))
        else entry.pendingUi.delete(uiId)
      }
    }
    if (message.event.type === 'claim_changed') {
      const claim = resultRecord(data?.claim)
      if (claim?.state === 'unclaimed') {
        this.clearLease(entry)
      } else if (claim?.state === 'claimed' && typeof claim.leaseId === 'string' && typeof claim.expiresAt === 'number' && entry.leaseOwner) {
        summary.claim = { state: 'claimed', leaseId: claim.leaseId, expiresAt: claim.expiresAt }
        this.scheduleLeaseExpiry(entry, claim.expiresAt)
      }
      this.emit('claim_changed', summary)
    }
  }

  private requireConnection(processInstanceId: string, transport: LiveSessionTransport): Entry {
    const entry = this.entries.get(processInstanceId)
    if (!entry || entry.transport !== transport) throw new LiveSessionRegistryError('connection_mismatch', 'message does not belong to this connection')
    return entry
  }

  private requireAttached(processInstanceId: string): Entry {
    const entry = this.entries.get(processInstanceId)
    if (!entry?.attached || !entry.summary) throw new LiveSessionRegistryError('live_session_not_found', 'live session not found')
    return entry
  }

  private requireLease(processInstanceId: string, browserClientId: string, leaseId: string): Entry {
    const entry = this.requireAttached(processInstanceId)
    if (entry.leaseOwner !== browserClientId || entry.summary!.claim.state !== 'claimed' || entry.summary!.claim.leaseId !== leaseId) {
      throw new LiveSessionRegistryError('invalid_lease', 'lease does not belong to this browser')
    }
    return entry
  }

  private dispatchNow(entry: Entry, command: LiveSessionCommand): Promise<unknown> {
    const requestId = randomUUID()
    const envelope: LiveSessionCommandEnvelope = {
      type: 'command',
      requestId,
      processInstanceId: entry.hello.processInstanceId,
      command,
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.pending.delete(requestId)
        reject(new LiveSessionRegistryError('command_timeout', 'live session command timed out'))
      }, this.commandTimeoutMs)
      timer.unref?.()
      entry.pending.set(requestId, { resolve, reject, timer })
      try { entry.transport.send(envelope) } catch (error) {
        clearTimeout(timer)
        entry.pending.delete(requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private sendResync(entry: Entry): void {
    const envelope: LiveSessionCommandEnvelope = {
      type: 'command',
      requestId: randomUUID(),
      processInstanceId: entry.hello.processInstanceId,
      command: { type: 'resync' },
    }
    try { entry.transport.send(envelope) } catch {}
  }

  private detailOf(entry: Entry): LiveSessionDetail {
    return {
      summary: { ...entry.summary!, claim: { ...entry.summary!.claim } },
      entries: [...entry.entries],
      pendingUi: [...entry.pendingUi.values()],
    }
  }

  private rejectPending(entry: Entry, code: string, message: string): void {
    for (const pending of entry.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new LiveSessionRegistryError(code, message))
    }
    entry.pending.clear()
  }

  private scheduleLeaseExpiry(entry: Entry, expiresAt: number): void {
    if (entry.leaseTimer) clearTimeout(entry.leaseTimer)
    entry.leaseTimer = setTimeout(() => {
      this.clearLease(entry)
      if (entry.summary) this.emit('claim_changed', entry.summary)
    }, Math.max(0, expiresAt - this.now()))
    entry.leaseTimer.unref?.()
  }

  private clearLease(entry: Entry): void {
    if (entry.leaseTimer) clearTimeout(entry.leaseTimer)
    entry.leaseTimer = undefined
    entry.leaseOwner = undefined
    if (entry.summary) entry.summary.claim = { state: 'unclaimed' }
  }
}

export const liveSessionRegistry = new LiveSessionRegistry()
