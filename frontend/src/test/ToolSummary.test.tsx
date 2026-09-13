import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ToolSummaryLine, formatToolTimestamp, summarizeToolCommand } from '../components/ToolSummary'

describe('ToolSummary', () => {
  it('summarizes read paths with a human-readable tool label', () => {
    expect(summarizeToolCommand('read', JSON.stringify({ path: '/workspace/project/src/index.ts' }))).toEqual({
      label: 'Read',
      command: 'read /workspace/project/src/index.ts',
    })
  })

  it('uses the main shell command as the label', () => {
    expect(summarizeToolCommand('bash', JSON.stringify({ command: 'git status --short' }))).toEqual({
      label: 'git status',
      command: 'git status --short',
    })
  })

  it('renders status, timestamp, and command in one summary line', () => {
    const timestamp = new Date(2026, 8, 10, 23, 48).getTime()
    render(<ToolSummaryLine toolName="bash" args={JSON.stringify({ command: 'git status --short' })} timestamp={timestamp} status="success" />)
    expect(screen.getByLabelText('成功')).toBeInTheDocument()
    expect(screen.getByText('git status')).toBeInTheDocument()
    expect(screen.getByText('git status --short')).toBeInTheDocument()
    expect(screen.getByText(formatToolTimestamp(timestamp))).toBeInTheDocument()
  })
})
