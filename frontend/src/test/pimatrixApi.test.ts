import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, cachedGet, invalidatePimatrixCache } from '../../../plugins/pi-matrix/src/api'

beforeEach(() => {
  invalidatePimatrixCache()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('pi-matrix API client', () => {
  it('deduplicates concurrent reads of the same URL', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true, value: 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
    vi.stubGlobal('fetch', fetchMock)
    const [a, b] = await Promise.all([cachedGet('/same-url'), cachedGet('/same-url')])
    expect(a).toEqual({ ok: true, value: 1 })
    expect(b).toEqual({ ok: true, value: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces the sign-in hint on an authentication failure', async () => {
    const hint = '请先在 Live Pi 完成认证'
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'authentication_required', hint }), { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(cachedGet('/auth-required')).rejects.toMatchObject({ message: hint, status: 401 })
    expect(fetchMock).toHaveBeenCalledWith('/auth-required', expect.objectContaining({ credentials: 'same-origin' }))
  })

  it('surfaces an aborted request as a timeout instead of an empty result', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })))
    const promise = cachedGet('/timeout-url')
    const assertion = expect(promise).rejects.toMatchObject({ name: 'ApiError', code: 'timeout' } satisfies Partial<ApiError>)
    await vi.advanceTimersByTimeAsync(40_000)
    await assertion
  })
})
