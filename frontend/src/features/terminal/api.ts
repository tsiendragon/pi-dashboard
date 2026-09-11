/**
 * API helpers for the web shared terminal (tmux relay).
 *
 * These are same-origin fetches: the `live-control-token` auth uses an
 * HttpOnly `pi_live_session` cookie, so the browser attaches it automatically.
 */

async function ptyJson<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let message = `HTTP ${r.status}`
    try {
      const text = await r.text()
      const parsed = JSON.parse(text)
      message = parsed.error || parsed.message || text || message
    } catch { /* keep fallback message */ }
    const err = new Error(message) as Error & { status: number }
    err.status = r.status
    throw err
  }
  return r.json() as Promise<T>
}

export function ptyAuth(token: string): Promise<{ ok: boolean }> {
  return fetch('/api/pty/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  }).then(r => ptyJson<{ ok: boolean }>(r))
}

export function listPtySessions(): Promise<{ sessions: string[] }> {
  return fetch('/api/pty/sessions').then(r => ptyJson<{ sessions: string[] }>(r))
}

export function createPtySession(name: string): Promise<{ name: string }> {
  return fetch('/api/pty/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(r => ptyJson<{ name: string }>(r))
}

export function killPtySession(name: string): Promise<{ ok: boolean }> {
  return fetch(`/api/pty/sessions/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  }).then(r => ptyJson<{ ok: boolean }>(r))
}