/**
 * Copy text to the system clipboard.
 *
 * `navigator.clipboard` only exists in secure contexts, but the dashboard is
 * commonly reached over plain http (LAN IP / reverse tunnel), so fall back to
 * the legacy selection + execCommand path when the modern API is unavailable.
 * Returns whether the copy actually succeeded.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the legacy path */
  }

  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.position = 'fixed'
  el.style.top = '0'
  el.style.opacity = '0'
  document.body.appendChild(el)
  try {
    el.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(el)
  }
}