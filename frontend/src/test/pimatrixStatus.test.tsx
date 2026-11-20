import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { parseStatusText, PimatrixStatusMessage } from '../../../plugins/pi-matrix/src/messages'

const STATUS_TEXT = [
  'pi-matrix status — pimatrix-cqc-2x3 (ledger: 36 events)',
  'TARGET T: OPEN [alignment unconfirmed] — For every density operator rho …',
  '  open: T — no live proof route: prove, try to refute, split into lemmas, or cite',
  '  open: L0 — prove the support lemma',
  'claims by tier: conjecture 5, draft 10',
  'LOW_YIELD: 5 work events without any claim improving.',
  'warning: target T: statement alignment not confirmed by a human (/proof-align T)',
].join('\n')

describe('parseStatusText', () => {
  it('reads the ledger projection without inventing fields', () => {
    const parsed = parseStatusText(STATUS_TEXT)
    expect(parsed.project).toBe('pimatrix-cqc-2x3')
    expect(parsed.events).toBe(36)
    expect(parsed.targets).toHaveLength(1)
    expect(parsed.targets[0]).toMatchObject({ id: 'T', status: 'open', aligned: false })
    expect(parsed.targets[0].frontier.map(item => item.claim)).toEqual(['T', 'L0'])
    expect(parsed.tiers).toBe('conjecture 5, draft 10')
    expect(parsed.lowYield).toContain('5 work events')
    expect(parsed.warnings).toHaveLength(1)
  })

  it('treats a target without the unconfirmed marker as aligned', () => {
    const parsed = parseStatusText('pi-matrix status — demo (ledger: 1 events)\nTARGET T: PROVED — done')
    expect(parsed.targets[0]).toMatchObject({ id: 'T', status: 'proved', aligned: true })
  })

  it('ignores the extension injection prefix before the ledger header', () => {
    const parsed = parseStatusText(`[ledger status, derived by pimatrix — authoritative]\n${STATUS_TEXT}`)
    expect(parsed.project).toBe('pimatrix-cqc-2x3')
    expect(parsed.events).toBe(36)
    expect(parsed.targets).toHaveLength(1)
  })

  it('keeps unstructured output for the raw fallback', () => {
    const parsed = parseStatusText('[pimatrix status unavailable: timed out]')
    expect(parsed.targets).toHaveLength(0)
  })
})

describe('PimatrixStatusMessage', () => {
  it('renders the collapsed header and the expanded target chips', () => {
    render(<PimatrixStatusMessage content={STATUS_TEXT} />)
    expect(screen.getByText('pimatrix-cqc-2x3')).toBeTruthy()
    expect(screen.getByText('36 ledger events')).toBeTruthy()
    expect(screen.getByText('1 warning(s)')).toBeTruthy()
    expect(screen.getByText('LOW_YIELD')).toBeTruthy()
    fireEvent.click(screen.getByText('pimatrix-cqc-2x3').closest('button')!)
    expect(screen.getByText('OPEN')).toBeTruthy()
    expect(screen.getByText('alignment unconfirmed')).toBeTruthy()
    expect(screen.getByText('2 open')).toBeTruthy()
  })
})
