/**
 * Live-session view of the goal anchor.
 *
 * The parsing lives in `@shared/goal-anchor` because the backend session list
 * needs the same numbers for its per-row badge. This module keeps the names the
 * live-session UI already used, so call sites and tests stay unchanged.
 */
import {
  goalAnchorFromEntries,
  type GoalAnchor,
  type GoalBlocker,
  type GoalSourceDoc,
  type GoalStatus,
  type GoalWorkItem,
  type GoalWorkItemState,
} from '@shared/goal-anchor'

export type SessionGoalStatus = GoalStatus
export type SessionGoalWorkItemState = GoalWorkItemState
export type SessionGoalBlocker = GoalBlocker
export type SessionGoalWorkItem = GoalWorkItem
export type SessionGoalSourceDoc = GoalSourceDoc
export type SessionGoalSummary = GoalAnchor

export {
  goalProgressOf,
  goalStaleness,
  GOAL_STALE_MESSAGE_THRESHOLD,
  type GoalProgress,
  type GoalStalenessReason,
} from '@shared/goal-anchor'

/** Read the latest persisted pi-agent-goal state from a live-session snapshot. */
export const sessionGoalFromEntries = goalAnchorFromEntries