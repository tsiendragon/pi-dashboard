import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MobilePairingButton from '../features/live-sessions/MobilePairingButton'
import { liveSessionApi } from '../features/live-sessions/api'

vi.mock('../features/live-sessions/api', () => ({ liveSessionApi: { pairingCode: vi.fn() } }))
const code = 'a'.repeat(32) // synthetic fixture
const api = vi.mocked(liveSessionApi.pairingCode)

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear() })
afterEach(() => { cleanup(); vi.useRealTimers() })
function open() { fireEvent.click(screen.getByRole('button', { name: '手机配对' })) }
function generate() { fireEvent.click(screen.getByRole('button', { name: '生成一次性配对码' })) }

describe('explicit ephemeral mobile pairing', () => {
  it('does not mint on render/open; clears on close, never persists or adds code to URL', async () => {
    api.mockResolvedValue({ code, expiresAt: Date.now() + 180_000 })
    const location = window.location.href
    render(<MobilePairingButton />)
    expect(api).not.toHaveBeenCalled()
    open()
    expect(api).not.toHaveBeenCalled()
    generate()
    expect(await screen.findByDisplayValue(code)).toBeTruthy()
    expect(api).toHaveBeenCalledTimes(1)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(window.location.href).toBe(location)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByDisplayValue(code)).toBeNull()
    open()
    expect(screen.queryByDisplayValue(code)).toBeNull()
    expect(api).toHaveBeenCalledTimes(1)
  })
  it('shows failure without an automatic retry or fake code', async () => {
    api.mockRejectedValueOnce(new Error('配对接口未更新'))
    render(<MobilePairingButton />); open(); generate()
    expect(await screen.findByRole('alert')).toHaveTextContent('配对接口未更新')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(api).toHaveBeenCalledTimes(1)
  })
  it('ignores late response after close and reopen', async () => {
    let resolve!: (value: { code: string; expiresAt: number }) => void
    api.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    render(<MobilePairingButton />); open(); generate()
    fireEvent.click(screen.getByRole('button', { name: '关闭' })); open()
    await act(async () => { resolve({ code, expiresAt: Date.now() + 180_000 }) })
    expect(screen.queryByDisplayValue(code)).toBeNull()
    expect(api).toHaveBeenCalledTimes(1)
  })
  it('removes an expired code, without generating a replacement automatically', async () => {
    vi.useFakeTimers()
    api.mockResolvedValueOnce({ code, expiresAt: Date.now() + 2000 })
    render(<MobilePairingButton />); open()
    await act(async () => { generate() })
    expect(screen.getByDisplayValue(code)).toBeTruthy()
    act(() => { vi.advanceTimersByTime(3000) })
    expect(screen.queryByDisplayValue(code)).toBeNull()
    expect(screen.getByText('配对码已过期，请重新生成。')).toBeTruthy()
    expect(api).toHaveBeenCalledTimes(1)
  })
})
