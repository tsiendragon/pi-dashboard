import { describe, expect, it } from 'vitest'
import { compactBrowserMessage, compactDetail } from '../live-sessions/compact.js'
import { LiveSessionRegistry } from '../live-sessions/registry.js'

const image = { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }
const omittedImage = { type: 'image', mimeType: 'image/png', piImageOmitted: true }

function detailWithImage() {
  return {
    summary: { processInstanceId: 'process-a', sessionId: 'session-a' },
    entries: [
      { type: 'message', id: 'image-message', message: { role: 'user', content: [
        { type: 'text', text: 'look at this' }, image,
      ] } },
    ],
  }
}

describe('compact live detail images', () => {
  it('strips image data and marks images omitted on both message and entry', () => {
    const compact = compactDetail(detailWithImage()) as any
    const entry = compact.entries[0]
    expect(entry.message.content).toEqual([{ type: 'text', text: 'look at this' }, omittedImage])
    expect(entry.message.piOmitted).toMatchObject({ images: true })
    expect(entry.piOmitted).toMatchObject({ images: true })
    expect(JSON.stringify(compact)).not.toContain(image.data)
  })

  it('leaves messages without images otherwise unchanged', () => {
    const full = {
      entries: [{ type: 'message', id: 'plain', message: { role: 'assistant', content: [
        { type: 'text', text: 'plain answer' },
      ] } }],
    }
    const compact = compactDetail(full) as any
    expect(compact.entries[0]).toEqual(full.entries[0])
    expect(compact.entries[0].piOmitted).toBeUndefined()
  })

  it('keeps image payloads intact in the non-compact registry detail', async () => {
    const registry = new LiveSessionRegistry({ goalFileSyncIntervalMs: 0, resyncRetryIntervalMs: 0 })
    try {
      const transport = { send() {} }
      const full = detailWithImage()
      registry.connect({
        type: 'hello', protocolVersion: 2, brokerToken: 'token',
        processInstanceId: 'process-a', pid: 4242, cwd: '/tmp/root/task',
        mode: 'tui', sessionId: 'session-a',
      }, '/tmp/root/task', transport)
      registry.applySnapshot({
        type: 'snapshot', processInstanceId: 'process-a', revision: 1, sequence: 0,
        summary: {
          processInstanceId: 'process-a', sessionId: 'session-a', pid: 4242,
          cwd: '/tmp/root/task', canonicalCwd: '/tmp/root/task', mode: 'tui',
          status: 'idle', claim: { state: 'unclaimed' }, startedAt: 1,
          lastActivityAt: 2, revision: 1, eventSequence: 0,
        },
        entries: full.entries,
      }, transport, '/tmp/root/task')

      const detail = registry.get('process-a') as any
      expect(detail.compact).toBeUndefined()
      expect(detail.entries[0].message.content[1]).toEqual(image)
      expect(detail.entries[0].message.piOmitted).toBeUndefined()
    } finally {
      await registry.stop()
    }
  })

  it('does not mutate the source detail', () => {
    const full = detailWithImage()
    const before = structuredClone(full)
    compactDetail(full)
    expect(full).toEqual(before)
    expect(full.entries[0].message.content[1]).toEqual(image)
  })

  it('compacts streamed images and retains tool-result image placeholders', () => {
    const event = compactBrowserMessage({
      type: 'live_session_event',
      data: { event: { type: 'message_end', data: { message: { role: 'user', content: [image] } } } },
    }) as any
    expect(event.data.event.data.message.content).toEqual([omittedImage])
    expect(event.data.event.piOmitted).toMatchObject({ images: true })

    const tool = compactDetail({ entries: [{ type: 'message', message: {
      role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text: 'private output' }, image],
    } }] }) as any
    expect(tool.entries[0].message.content).toEqual([omittedImage])
    expect(tool.entries[0].message.piOmitted).toMatchObject({ output: true, images: true })
    expect(tool.entries[0].piOmitted).toMatchObject({ output: true, images: true })
    expect(JSON.stringify(tool)).not.toContain('private output')
  })
})
