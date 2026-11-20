import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidatePimatrixCache } from '../../../plugins/pi-matrix/src/api'
import { ProofSettings } from '../../../plugins/pi-matrix/src/panels'

beforeEach(() => {
  invalidatePimatrixCache()
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
    ok: true,
    kernel: { packageRoot: '/home/me/repos/pi_matrix', python: '/home/me/repos/pi_matrix/verifier/.venv/bin/python' },
    meta: { readAt: new Date().toISOString(), elapsedMs: 12 },
    doctor: {
      ok: false,
      python: '/usr/bin/python3',
      capabilities: {
        python_core: { available: true },
        lean_kernel: { available: false, reason: 'pinned Lean is not installed' },
        pi_roles: { available: null, reason: 'Not tested' },
      },
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }))))
})

afterEach(() => vi.unstubAllGlobals())

describe('ProofSettings', () => {
  it('renders object-shaped capabilities instead of raw JSON', async () => {
    render(<ProofSettings />)
    expect(await screen.findByText('pi-matrix')).toBeTruthy()
    expect(await screen.findByText('python_core')).toBeTruthy()
    expect(screen.getAllByText('ok').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('lean_kernel')).toBeTruthy()
    expect(screen.getByText('unavailable')).toBeTruthy()
    expect(screen.getByText('pi_roles')).toBeTruthy()
    expect(screen.getByText('n/a')).toBeTruthy()
    expect(screen.getByText('doctor failed')).toBeTruthy()
  })
})
