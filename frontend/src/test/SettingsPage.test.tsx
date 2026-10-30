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

  it('renders default thinking level as a touch-friendly segmented radiogroup and shows real model metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/pi/settings' && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ defaultThinkingLevel: 'low', enabledModels: ['anthropic/claude-sonnet-4'] }))
      }
      if (url === '/api/pi/settings' && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }))
      }
      if (url === '/api/models/catalog' || url === '/api/models') {
        return new Response(JSON.stringify({
          models: [
            { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic', reasoning: true, contextWindow: 200_000 },
            { id: 'gpt-4o-mini', name: 'GPT-4o mini', provider: 'openai', reasoning: false },
          ],
        }))
      }
      return new Response(JSON.stringify({}))
    }))

    render(<MemoryRouter><SettingsPage /></MemoryRouter>)
    const thinkingGroup = await screen.findByRole('radiogroup', { name: '默认思考强度' })
    expect(within(thinkingGroup).getByRole('radio', { name: '低' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(thinkingGroup).getByRole('radio', { name: '高' }))
    await waitFor(() => expect(within(thinkingGroup).getByRole('radio', { name: '高' })).toHaveAttribute('aria-checked', 'true'))

    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: '模型列表' }))
    expect(await screen.findByText('思考 4 档')).toBeInTheDocument()
    expect(screen.getByText('200k')).toBeInTheDocument()
  })
})
