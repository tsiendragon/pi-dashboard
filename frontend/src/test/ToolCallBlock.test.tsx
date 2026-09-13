import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ToolCallBlock from '../pages/chat/ToolCallBlock'
import { renderWithProviders } from './helpers'

describe('ToolCallBlock compact display', () => {
  it('keeps arguments and result hidden until the one-line row is clicked', () => {
    renderWithProviders(
      <ToolCallBlock
        content="🔧 bash"
        meta={{ toolName: 'bash', args: JSON.stringify({ command: 'npm test' }), result: 'tests passed' }}
      />,
    )

    expect(screen.getByText('npm test')).toBeInTheDocument()
    expect(screen.queryByText('Arguments')).not.toBeInTheDocument()
    expect(screen.queryByText('tests passed')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /bash/i }))

    expect(screen.getByText('Arguments')).toBeInTheDocument()
    expect(screen.getByText('tests passed')).toBeInTheDocument()
  })

  it('shows TUI-like edit stats and opens the diff in split view', () => {
    renderWithProviders(
      <ToolCallBlock
        content="🔧 edit"
        meta={{
          toolName: 'edit',
          args: JSON.stringify({ path: '/tmp/contract.md', edits: [{ oldText: 'old', newText: 'new' }] }),
          result: 'updated',
        }}
      />,
    )

    expect(screen.getByText('↳ diff')).toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('-1')).toBeInTheDocument()
    expect(screen.queryByText('unified')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /edit/i }))

    expect(screen.getByText('unified')).toBeInTheDocument()
    expect(screen.getByText('new')).toBeInTheDocument()
  })
})
