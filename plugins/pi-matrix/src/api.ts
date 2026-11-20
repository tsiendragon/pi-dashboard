// @ts-nocheck — Plugin files are bundled by Vite, not type-checked by the frontend tsc config.
/**
 * Dashboard-side client for the read-only pi-matrix routes.
 *
 * All mathematical status comes from the Python kernel via the backend; this
 * module only transports and caches it. It never derives a proof state.
 */
import { useEffect, useRef, useState } from 'react'
import { store } from '../../../frontend/src/store'
import type {
  PimatrixDoctorResponse,
  PimatrixLogResponse,
  PimatrixProjectsResponse,
  PimatrixSolverResponse,
  PimatrixStatusResponse,
} from '@shared/pimatrix'

const FETCH_TIMEOUT_MS = 40_000
const CACHE_TTL_MS = 4_000

export class ApiError extends Error {
  code?: string
  status?: number
  constructor(message: string, code?: string, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

const cache = new Map<string, { at: number; value: unknown }>()
const inflight = new Map<string, Promise<unknown>>()

async function request<T>(url: string): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || !body || body.ok === false) {
      const hint = response.status === 401 && typeof body?.hint === 'string' ? body.hint : undefined
      throw new ApiError(hint || body?.error || `HTTP ${response.status}`, body?.code, response.status)
    }
    return body as T
  } catch (error) {
    if (timedOut) {
      throw new ApiError(`pi-matrix request timed out after ${Math.round(FETCH_TIMEOUT_MS / 1000)}s`, 'timeout')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Deduplicate concurrent reads and reuse a very short-lived value. */
export async function cachedGet<T>(url: string, ttlMs = CACHE_TTL_MS): Promise<T> {
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T
  const pending = inflight.get(url)
  if (pending) return pending as Promise<T>
  // The request is shared by every caller; a single component unmounting must
  // not abort it for the others. Callers ignore late results via their own flag.
  const promise = request<T>(url).then(value => {
    if (cache.size >= 200) {
      const oldest = cache.keys().next().value
      if (oldest) cache.delete(oldest)
    }
    cache.set(url, { at: Date.now(), value })
    return value
  }).finally(() => {
    if (inflight.get(url) === promise) inflight.delete(url)
  })
  inflight.set(url, promise)
  return promise
}

export function invalidatePimatrixCache(): void {
  cache.clear()
}

function query(params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value) search.set(key, value)
  }
  const suffix = search.toString()
  return suffix ? `?${suffix}` : ''
}

export const statusUrl = (target: { slot?: string | null; path?: string | null }, refresh = false) =>
  '/api/pimatrix/status' + query({ slot: target.slot, path: target.path, refresh: refresh ? '1' : null })
export const logUrl = (target: { slot?: string | null; path?: string | null }, last = 50) =>
  '/api/pimatrix/log' + query({ slot: target.slot, path: target.path, last: String(last) })
export const solverUrl = (target: { slot?: string | null; path?: string | null }, run: string) =>
  '/api/pimatrix/solver' + query({ slot: target.slot, path: target.path, run })
export const projectsUrl = '/api/pimatrix/projects'
export const doctorUrl = (refresh = false) => '/api/pimatrix/doctor' + query({ refresh: refresh ? '1' : null })

function withRefresh(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}refresh=1`
}

/** One active-slot snapshot without subscribing to every Redux update. */
export function activeSlotSnapshot(): { slot: string | null; cwd: string | null } {
  try {
    const state = store.getState()
    const slot = state.chat.activeSlot
    const cwd = state.dashboard.slots.find(entry => entry.key === slot)?.cwd ?? null
    return { slot, cwd }
  } catch {
    return { slot: null, cwd: null }
  }
}

export function useActiveSlot(intervalMs = 2000): { slot: string | null; cwd: string | null } {
  const [value, setValue] = useState(activeSlotSnapshot)
  useEffect(() => {
    if (intervalMs <= 0) return
    const timer = setInterval(() => {
      const next = activeSlotSnapshot()
      setValue(prev => (prev.slot === next.slot && prev.cwd === next.cwd ? prev : next))
    }, intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return value
}

/**
 * Fetch one endpoint. `intervalMs = 0` disables polling (one read per URL).
 * Polling pauses while the tab is hidden and stops on unmount.
 */
export function useEndpoint<T>(url: string | null, intervalMs = 8_000): {
  data: T | null
  error: string | null
  loading: boolean
  reload: (force?: boolean) => void
} {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(!!url)
  const [nonce, setNonce] = useState(0)
  const urlRef = useRef(url)
  urlRef.current = url
  const previousUrl = useRef<string | null>(null)
  const forceNext = useRef(false)

  useEffect(() => {
    if (previousUrl.current !== url) {
      previousUrl.current = url
      setData(null)
      setError(null)
    }
    if (!url) {
      setLoading(false)
      return
    }
    let active = true
    const load = async (force = false) => {
      try {
        const target = force ? withRefresh(url) : url
        const value = await cachedGet<T>(target, intervalMs > 0 ? 2_000 : 10_000)
        if (!active) return
        setData(value)
        setError(null)
      } catch (reason: any) {
        if (!active) return
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (active) setLoading(false)
      }
    }
    const force = forceNext.current
    forceNext.current = false
    setLoading(true)
    void load(force)
    const timer = intervalMs > 0
      ? setInterval(() => {
          if (!document.hidden && urlRef.current === url) void load(false)
        }, intervalMs)
      : null
    return () => {
      active = false
      if (timer) clearInterval(timer)
    }
  }, [url, intervalMs, nonce])

  return {
    data,
    error,
    loading,
    reload: (force = false) => {
      if (force) forceNext.current = true
      setNonce(value => value + 1)
    },
  }
}

export type {
  PimatrixDoctorResponse,
  PimatrixLogResponse,
  PimatrixProjectsResponse,
  PimatrixSolverResponse,
  PimatrixStatusResponse,
}

/** Client-side navigation that keeps BrowserRouter in sync without a reload. */
export function goto(path: string): void {
  if (window.location.pathname === path) return
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function formatTime(value?: string | number | null): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function relativeTime(value?: string | number | null): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86_400)}d ago`
}

export function shortPath(value: string, keep = 3): string {
  const parts = value.split('/').filter(Boolean)
  if (parts.length <= keep) return value
  return '…/' + parts.slice(-keep).join('/')
}
