import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ContextUsagePanel from '../features/live-sessions/ContextUsagePanel'

describe('context usage (not accumulated billing tokens)', () => {
  it('shows full current token counts and updates from new telemetry', () => {
    const view = render(<ContextUsagePanel usage={{ tokens: 123456, contextWindow: 1000000, percent: 12.3456 }} />)
    expect(screen.getByText('123,456 / 1,000,000 tokens')).toBeInTheDocument()
    expect(screen.getByText('上下文 · 12.3%')).toBeInTheDocument()
    view.rerender(<ContextUsagePanel usage={{ tokens: 500000, contextWindow: 1000000, percent: 50 }} />)
    expect(screen.getByText('500,000 / 1,000,000 tokens')).toBeInTheDocument()
  })
  it('unknown data never becomes zero', () => {
    render(<ContextUsagePanel />)
    expect(screen.getByText('上下文 · 占用待上报')).toBeInTheDocument()
    expect(screen.getByText('tokens 与窗口尚未上报')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })
  it('preserves actual zero and can derive percent from known counts', () => {
    const view = render(<ContextUsagePanel usage={{ tokens: 0, contextWindow: 100, percent: null }} />)
    expect(screen.getByText('上下文 · 0.0%')).toBeInTheDocument()
    view.rerender(<ContextUsagePanel usage={{ tokens: 50, contextWindow: 100, percent: null }} />)
    expect(screen.getByText('上下文 · 50.0%')).toBeInTheDocument()
  })
  it('does not infer tokens from a percent and labels stale estimates', () => {
    render(<ContextUsagePanel usage={{ tokens: null, contextWindow: 1000000, percent: 20 }} stale />)
    expect(screen.getByText('tokens 未上报 / 窗口 1,000,000')).toBeInTheDocument()
    expect(screen.getByText(/正在重连，最近上报可能过期/)).toBeInTheDocument()
  })
  it('keeps overflow visible while bounding the progress bar', () => {
    render(<ContextUsagePanel usage={{ tokens: 150, contextWindow: 100, percent: 150 }} />)
    expect(screen.getByText('上下文 · 150.0%')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '150.0%')
  })
  it('invalid numbers do not invent usage', () => {
    render(<ContextUsagePanel usage={{ tokens: -1, contextWindow: 0, percent: Number.NaN }} />)
    expect(screen.getByText('上下文 · 占用待上报')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })
})
