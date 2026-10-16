import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import MuyuIcon from '../components/MuyuIcon'

describe('MuyuIcon', () => {
  it('gives every instance its own mouth mask so several glyphs can share a page', () => {
    const { container, getAllByTestId } = render(<><MuyuIcon /><MuyuIcon className="working-muyu-row" /></>)
    const masks = [...container.querySelectorAll('mask')].map(mask => mask.id)
    expect(masks).toHaveLength(2)
    expect(new Set(masks).size).toBe(2)
    masks.forEach(id => expect(id).toMatch(/^[A-Za-z0-9_-]+$/))
    container.querySelectorAll('.working-muyu-body').forEach((body, i) => expect(body.getAttribute('mask')).toBe(`url(#${masks[i]})`))
    expect(getAllByTestId('working-muyu')[1]).toHaveClass('working-muyu', 'working-muyu-row')
  })

  it('is decorative: hidden from assistive tech, "+1" included', () => {
    const { getByTestId } = render(<MuyuIcon />)
    expect(getByTestId('working-muyu')).toHaveAttribute('aria-hidden', 'true')
    expect(getByTestId('working-muyu')).toHaveTextContent('+1')
  })
})
