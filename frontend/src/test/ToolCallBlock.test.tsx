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
})
