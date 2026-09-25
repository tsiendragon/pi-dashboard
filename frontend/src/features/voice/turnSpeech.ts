/**
 * Turn-boundary gate for auto-reading replies aloud.
 *
 * A live session's `status` stays `running` for as long as the Pi process lives
 * (tmux-first sessions are idle between turns), so the finished-turn signal is
 * the derived agent state going busy → idle. Two things make that boundary
 * subtle:
 *
 * - the transcript entry carrying the final reply can arrive a beat late, so a
 *   finished turn stays "pending" until its text is actually present;
 * - at the boundary the newest assistant message may still be the *previous*
 *   reply, so the gate remembers the pre-turn baseline and waits for text that
 *   differs from it instead of reading a stale answer twice.
 */

export interface TurnSpeechGate {
  /** `undefined` until the first observation, so mount never replays a reply. */
  previousBusy?: boolean
  /** A turn finished and is still waiting to be read aloud. */
  pending: boolean
  /** Newest assistant text seen when the current/last turn started. */
  baseline: string
}

export const INITIAL_TURN_SPEECH_GATE: TurnSpeechGate = { pending: false, baseline: '' }

export function advanceTurnSpeech(gate: TurnSpeechGate, busy: boolean, spoken: string): TurnSpeechGate {
  if (busy) {
    // The reply on screen when the turn starts is the previous answer.
    return { previousBusy: true, pending: false, baseline: gate.previousBusy === true ? gate.baseline : spoken }
  }
  return { previousBusy: false, pending: gate.previousBusy === true || gate.pending, baseline: gate.baseline }
}

export interface TurnSpeechDecision {
  gate: TurnSpeechGate
  /** Text to speak now, or null to wait/skip. */
  speak: string | null
}

export function takePendingSpeech(
  gate: TurnSpeechGate,
  busy: boolean,
  enabled: boolean,
  spoken: string,
  lastSpoken: string,
): TurnSpeechDecision {
  if (!gate.pending || busy) return { gate, speak: null }
  if (!enabled) return { gate: { ...gate, pending: false }, speak: null }
  // Keep waiting: the transcript has not caught up with the finished turn yet
  // (empty, or still the pre-turn reply).
  if (!spoken || spoken === gate.baseline) return { gate, speak: null }
  const settled = { ...gate, pending: false }
  return { gate: settled, speak: spoken === lastSpoken ? null : spoken }
}