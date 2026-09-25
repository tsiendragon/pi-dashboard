import type { LiveSessionSummary } from '@shared/live-sessions'
import { liveSessionApi } from './api'
import { buildSessionSections, materializeOrder } from './sessionOrder'

/**
 * Place a freshly forked session beside the session it came from.
 *
 * A fork is a brand-new session, so it starts ungrouped and unranked — that
 * would drop it at the tail of 未分组, far from its source. Reproducing the
 * sidebar's block layout from the server stores (task groups, pin, manual order)
 * puts it in the same block, directly behind its parent. The layout comes from
 * `buildSessionSections`, the same function the sidebar renders with, so the
 * placement matches what the reader sees.
 *
 * All three reads are done at call time (not from component state) so the row
 * menu and the transcript bubble can share one code path.
 */
export async function placeForkBesideParent(input: {
  parent: LiveSessionSummary
  forkedProcessInstanceId: string
  forkedSessionId: string
  /** Every live session, so the manual order can be materialised in full. */
  sessions: readonly LiveSessionSummary[]
}): Promise<void> {  const [groups, order, meta] = await Promise.all([
    liveSessionApi.listGroups(),
    liveSessionApi.listOrder(),
    liveSessionApi.listMeta(),
  ])

  // Same block as the parent: same task group, and pinned if the parent is.
  const parentGroup = groups.find(group => group.sessionIds.includes(input.parent.sessionId))
  if (parentGroup) await liveSessionApi.addGroupMember(parentGroup.id, input.forkedProcessInstanceId)
  if (meta[input.parent.sessionId]?.pinned) await liveSessionApi.patchMeta(input.forkedProcessInstanceId, { pinned: true })

  // Directly behind the parent in the order list, so the two rows are adjacent.
  const displayed = buildSessionSections(input.sessions, meta, groups, order)
    .flatMap(section => section.sessions.map(session => session.sessionId))
  const base = materializeOrder(order, displayed)
  const parentIndex = base.indexOf(input.parent.sessionId)
  const insertAt = parentIndex >= 0 ? parentIndex + 1 : base.length
  await liveSessionApi.saveOrder([...base.slice(0, insertAt), input.forkedSessionId, ...base.slice(insertAt)])
}

/**
 * Fork a live session at one step and land the result beside its source.
 *
 * One code path for the sidebar row, the transcript bubble and the graph node, so
 * all three produce the same thing: the source keeps running, and the new session
 * inherits its task group and sits directly behind it.
 */
export async function forkLiveSessionAtStep(input: {
  source: LiveSessionSummary
  entryId: string
  sessions: readonly LiveSessionSummary[]
}): Promise<{ processInstanceId: string; sessionId: string }> {
  const result = await liveSessionApi.forkAtEntry(input.source.processInstanceId, input.entryId)
  if (!result.processInstanceId || !result.sessionId) throw new Error('新 Pi 已启动，但没有拿到会话标识')
  await placeForkBesideParent({
    parent: input.source,
    forkedProcessInstanceId: result.processInstanceId,
    forkedSessionId: result.sessionId,
    sessions: input.sessions,
  })
  return { processInstanceId: result.processInstanceId, sessionId: result.sessionId }
}