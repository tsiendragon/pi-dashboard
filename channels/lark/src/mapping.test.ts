import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Mapping } from './mapping.js'

async function mappingAt(): Promise<{ mapping: Mapping; file: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lark-mapping-'))
  const file = path.join(directory, 'mapping.json')
  const mapping = new Mapping(file)
  await mapping.load()
  return { mapping, file }
}

describe('Mapping scope', () => {
  /**
   * Lark gives a message a `thread_id` as soon as it is posted inside a thread,
   * so a chat-level binding has to cover its threads too — otherwise a reply in
   * the thread of an answer reads as "尚未绑定会话".
   */
  it('applies a chat-level binding to messages sent inside a thread', async () => {
    const { mapping } = await mappingAt()
    await mapping.bind('chat-1', '/tmp/session.jsonl', 'demo')

    expect(mapping.lookup('chat-1', null)?.sessionFile).toBe('/tmp/session.jsonl')
    expect(mapping.lookup('chat-1', 'omt_19b15bb9')?.sessionFile).toBe('/tmp/session.jsonl')
  })

  it('prefers an exact thread binding over the chat-level one', async () => {
    const { mapping } = await mappingAt()
    await mapping.bind('chat-1', '/tmp/chat.jsonl', 'chat')
    await mapping.bind('chat-1', '/tmp/topic.jsonl', 'topic', 'omt_1')

    expect(mapping.lookup('chat-1', 'omt_1')?.sessionFile).toBe('/tmp/topic.jsonl')
    expect(mapping.lookup('chat-1', null)?.sessionFile).toBe('/tmp/chat.jsonl')
    // A different topic still falls back to the chat-level binding.
    expect(mapping.lookup('chat-1', 'omt_2')?.sessionFile).toBe('/tmp/chat.jsonl')
  })

  /** The anchor only makes sense inside a topic; on a plain chat it creates one. */
  it('stores the reply anchor only for a topic-scoped binding', async () => {
    const { mapping, file } = await mappingAt()
    await mapping.bind('chat-1', '/tmp/session.jsonl', 'demo', null, 'om_chat_anchor')
    await mapping.bind('chat-1', '/tmp/session.jsonl', 'demo', 'omt_1', 'om_thread_anchor')

    const saved = JSON.parse(await readFile(file, 'utf8')) as {
      bindings: { threadId: string | null; replyMessageId?: string }[]
    }
    expect(saved.bindings.find(binding => binding.threadId === null)?.replyMessageId).toBeUndefined()
    expect(saved.bindings.find(binding => binding.threadId === 'omt_1')?.replyMessageId).toBe('om_thread_anchor')
  })

  it('unbinds the effective binding when asked from inside a thread', async () => {
    const { mapping } = await mappingAt()
    await mapping.bind('chat-1', '/tmp/session.jsonl', 'demo')

    expect(await mapping.unbind('chat-1', 'omt_1')).toBe(true)
    expect(mapping.lookup('chat-1', null)).toBeUndefined()
  })

  it('leaves the chat-level binding alone when a topic has its own', async () => {
    const { mapping } = await mappingAt()
    await mapping.bind('chat-1', '/tmp/chat.jsonl', 'chat')
    await mapping.bind('chat-1', '/tmp/topic.jsonl', 'topic', 'omt_1')

    expect(await mapping.unbind('chat-1', 'omt_1')).toBe(true)
    expect(mapping.lookup('chat-1', 'omt_1')?.sessionFile).toBe('/tmp/chat.jsonl')
  })
})
