import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import SettingsPage from '../pages/SettingsPage'
import { setLocale } from '../utils/i18n'

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('mc-settings-tab', 'model')
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/pi/settings') return new Response(JSON.stringify({ defaultThinkingLevel: 'low' }))
    return new Response(JSON.stringify({ models: [] }))
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setLocale('zh') })

describe('SettingsPage language switch', () => {
  it('shows the nav in English after switching to EN', async () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>)
    const nav = screen.getByRole('navigation')
    expect(within(nav).getByText('设置')).toBeInTheDocument()
    expect(within(nav).getByText('模型列表')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('radio', { name: 'EN' })[0])

    await waitFor(() => expect(within(nav).getByText('Settings')).toBeInTheDocument())
    expect(within(nav).getByText('Model List')).toBeInTheDocument()
    expect(within(nav).getByText('Behavior')).toBeInTheDocument()
    expect(within(nav).getByText('Resources & Integrations')).toBeInTheDocument()
    expect(within(nav).queryByText('模型列表')).not.toBeInTheDocument()
    expect(localStorage.getItem('pi-dashboard:locale')).toBe('en')
  })
})
