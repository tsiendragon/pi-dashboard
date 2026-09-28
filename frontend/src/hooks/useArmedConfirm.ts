import { useCallback, useEffect, useState } from 'react'

/**
 * Two-step confirmation for destructive UI, as a replacement for `window.confirm`.
 *
 * Browsers answer `window.confirm` with a *silent* `false` in several ordinary
 * situations — the user ticked "prevent this page from creating additional
 * dialogs", the tab is not focused, or the page runs in a stricter WebView. A
 * confirm-gated button then looks completely dead: no dialog, no action, no
 * feedback. Arming keeps the decision inside the page: the first press arms it
 * (the caller renders the confirming label) and the second press within
 * `timeoutMs` proceeds.
 *
 * Usage:
 *   const close = useArmedConfirm()
 *   onClick={() => { if (!close.confirm()) return; doTheThing() }}
 *   <button>{close.armed ? '确认关闭' : '关闭'}</button>
 */
export function useArmedConfirm(timeoutMs = 5000) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), timeoutMs)
    return () => window.clearTimeout(timer)
  }, [armed, timeoutMs])

  const disarm = useCallback(() => setArmed(false), [])

  /** True when the caller may proceed (i.e. this press is the confirming one). */
  const confirm = useCallback(() => {
    if (armed) {
      setArmed(false)
      return true
    }
    setArmed(true)
    return false
  }, [armed])

  return { armed, confirm, disarm }
}