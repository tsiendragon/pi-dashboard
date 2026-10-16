import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithProviders } from './helpers'
import SessionOverviewPage from '../features/live-sessions/SessionOverviewPage'

vi.mock('../features/live-sessions/LiveSessionGalleryPage', () => ({
  default: () => <div>卡片内容</div>,
}))
vi.mock('../features/live-sessions/graph/SessionGraphPage', () => ({
  default: () => <div>图谱内容</div>,
}))

describe('会话总览', () => {
  it('在同一入口切换卡片与图谱', () => {
    renderWithProviders(<SessionOverviewPage />, { route: '/live-sessions/gallery' })
    expect(screen.getByText('卡片内容')).toBeTruthy()
    fireEvent.click(screen.getByRole('link', { name: '家族图谱' }))
    expect(screen.getByText('图谱内容')).toBeTruthy()
    expect(screen.getByRole('link', { name: '家族图谱' }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(screen.getByRole('link', { name: '会话卡片' }))
    expect(screen.getByText('卡片内容')).toBeTruthy()
  })

  it('保留旧图谱网址及指定会话参数', () => {
    renderWithProviders(<SessionOverviewPage />, { route: '/live-sessions/graph?file=session.jsonl' })
    expect(screen.getByText('图谱内容')).toBeTruthy()
    fireEvent.click(screen.getByRole('link', { name: '会话卡片' }))
    expect(screen.getByRole('link', { name: '家族图谱' }).getAttribute('href')).toBe('/live-sessions/graph?file=session.jsonl')
  })
})
