import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TimelineEntry } from '../features/live-sessions/LiveSessionPage'

const ERROR = '400: Input image data may contain inappropriate content.'
const failedAssistantMessage = {
  role: 'assistant',
  stopReason: 'error',
  errorMessage: ERROR,
  content: [],
}

const renderEntry = (entry: unknown) => render(
  <TimelineEntry entry={entry} onFileOpen={() => {}} toolStates={new Map()} />,
)

describe('live-session provider failures', () => {
  it.each([
    ['wrapped message_end event', {
      type: 'message_end',
      data: { message: failedAssistantMessage },
    }],
    ['raw message_end event', {
      type: 'message_end',
      message: failedAssistantMessage,
    }],
    ['saved message entry', {
      type: 'message',
      message: failedAssistantMessage,
    }],
  ])('shows the provider error from a %s', (_source, entry) => {
    renderEntry(entry)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('模型请求失败')
    expect(alert).toHaveTextContent(ERROR)
  })

  it.each([
    ['wrapped auto_retry_start event', {
      type: 'auto_retry_start',
      data: { attempt: 1, maxAttempts: 3, errorMessage: ERROR },
    }],
    ['raw auto_retry_start event', {
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      errorMessage: ERROR,
    }],
  ])('shows retry details from a %s', (_source, entry) => {
    renderEntry(entry)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('自动重试（1/3）')
    expect(alert).toHaveTextContent(ERROR)
  })

  it.each([
    ['wrapped', { type: 'auto_retry_end', data: { success: false, attempt: 3, finalError: ERROR } }],
    ['raw', { type: 'auto_retry_end', success: false, attempt: 3, finalError: ERROR }],
  ])('shows the final error from a %s auto_retry_end event', (_source, entry) => {
    renderEntry(entry)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('自动重试最终失败')
    expect(alert).toHaveTextContent(ERROR)
  })

  it.each([
    ['wrapped', { type: 'agent_end', data: { messages: [failedAssistantMessage] } }],
    ['raw', { type: 'agent_end', messages: [failedAssistantMessage] }],
    ['normal', { type: 'agent_end', data: { messages: [] } }],
  ])('does not render an %s agent_end as a duplicate transcript message', (_source, entry) => {
    const { container } = renderEntry(entry)

    expect(container.firstChild).toBeNull()
  })
})
