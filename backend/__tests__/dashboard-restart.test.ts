import { describe, expect, it, vi } from 'vitest'
import { createDashboardRestartControl } from '../dashboard-restart.js'

describe('createDashboardRestartControl', () => {
  it('only supports processes carrying a systemd invocation id', () => {
    expect(createDashboardRestartControl({ env: {} }).supported).toBe(false)
    expect(createDashboardRestartControl({ env: { INVOCATION_ID: 'boot-1' } }).supported).toBe(true)
  })

  it('queues one SIGTERM and does not schedule a second restart', () => {
    const callbacks: (() => void)[] = []
    const kill = vi.fn()
    const control = createDashboardRestartControl({
      env: { INVOCATION_ID: 'boot-1' },
      pid: 1234,
      schedule: callback => {
        callbacks.push(callback)
        return {}
      },
      kill,
    })

    expect(control.request()).toBe(true)
    expect(control.request()).toBe(false)
    expect(callbacks).toHaveLength(1)
    expect(kill).not.toHaveBeenCalled()

    callbacks[0]()
    expect(kill).toHaveBeenCalledOnce()
    expect(kill).toHaveBeenCalledWith(1234, 'SIGTERM')
  })
})
