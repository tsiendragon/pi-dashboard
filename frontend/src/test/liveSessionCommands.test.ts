/**
 * 「清空」only exists when the session really has `/clear`.
 *
 * `/clear` is registered by the `session-aliases` extension, not by pi, and pi skips
 * a missing extension file silently — so a session can be running with no clear
 * command at all. The bridge advertises `session_clear` from pi's live command
 * registry; without the flag the UI must refuse with words instead of sending text
 * that the model would answer (a click that burns a turn and clears nothing).
 */
import { describe, expect, it } from 'vitest'
import { clearCommandAvailable, LIVE_SESSION_SLASH_MENU } from '../features/live-sessions/liveSessionCommands'

describe('clearCommandAvailable', () => {
  it('requires the bridge to advertise session_clear', () => {
    expect(clearCommandAvailable(['session_tree', 'session_clear'])).toBe(true)
    expect(clearCommandAvailable(['session_tree'])).toBe(false)
    expect(clearCommandAvailable(undefined)).toBe(false)
  })

  it('keeps offering /clear in the slash menu', () => {
    expect(LIVE_SESSION_SLASH_MENU.some(item => item.command === '/clear')).toBe(true)
  })
})
