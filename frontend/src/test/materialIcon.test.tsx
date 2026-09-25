import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import MaterialIcon from '../components/MaterialIcon'

describe('MaterialIcon', () => {
  it('renders the Material Design path for the requested icon', () => {
    const { container } = render(<MaterialIcon name="mic" />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24')
    expect(svg?.querySelector('path')?.getAttribute('d')).toMatch(/^M12 14c/)
  })

  it('is decorative by default and inherits the text colour', () => {
    const { container } = render(<MaterialIcon name="stop" />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveAttribute('focusable', 'false')
    expect(svg?.getAttribute('class')).toContain('fill-current')
  })

  it('accepts size overrides and an optional spin animation', () => {
    const { container } = render(<MaterialIcon name="sync" className="h-3 w-3" spin />)
    const className = container.querySelector('svg')?.getAttribute('class') ?? ''
    expect(className).toContain('h-3 w-3')
    expect(className).toContain('animate-spin')
  })
})