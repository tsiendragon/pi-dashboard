import { describe, expect, it } from 'vitest'
import { TransportManager } from './transportManager.js'
import type { ImTransport } from './transport.js'

function fakeTransport(sent: string[]): ImTransport {
  return {
    async start() {},
    async stop() {},
    async sendText(_chatId, _threadId, text) {
      sent.push(text)
    },
  }
}

describe('TransportManager', () => {
  it('refuses to pretend a reply was sent while no transport is active', async () => {
    const manager = new TransportManager()
    await expect(manager.sendText('chat', null, 'hello')).rejects.toThrow(/no active transport/)
  })

  it('delegates to the active transport and stops delegating after stop', async () => {
    const sent: string[] = []
    const manager = new TransportManager()
    await manager.start(() => {})
    await manager.activate(fakeTransport(sent))

    await manager.sendText('chat', null, 'hello')
    expect(sent).toEqual(['hello'])

    await manager.stop()
    await expect(manager.sendText('chat', null, 'again')).rejects.toThrow(/no active transport/)
  })
})
