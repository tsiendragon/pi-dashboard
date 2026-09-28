import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useArmedConfirm } from '../hooks/useArmedConfirm'

describe('useArmedConfirm', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('proceeds only on the second press', () => {
    const { result } = renderHook(() => useArmedConfirm())

    let proceed = true
    act(() => { proceed = result.current.confirm() })
    expect(proceed).toBe(false)
    expect(result.current.armed).toBe(true)

    act(() => { proceed = result.current.confirm() })
    expect(proceed).toBe(true)
    expect(result.current.armed).toBe(false)
  })

  it('disarms itself after the timeout so a stale arm cannot fire later', () => {
    const { result } = renderHook(() => useArmedConfirm(1000))

    act(() => { result.current.confirm() })
    expect(result.current.armed).toBe(true)

    act(() => { vi.advanceTimersByTime(1000) })
    expect(result.current.armed).toBe(false)

    let proceed = true
    act(() => { proceed = result.current.confirm() })
    expect(proceed).toBe(false)
  })

  it('disarm() drops a pending confirmation', () => {
    const { result } = renderHook(() => useArmedConfirm())

    act(() => { result.current.confirm() })
    act(() => { result.current.disarm() })
    expect(result.current.armed).toBe(false)
  })
})