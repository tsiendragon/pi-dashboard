import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface Binding {
  platform: string
  chatId: string
  /** Topic/thread id (topic-groups); null in one-chat-one-session mode. */
  threadId: string | null
  /** Anchor message id for topic-groups: replies are posted into this thread. */
  replyMessageId?: string
  /** Stable session identity (never processInstanceId). */
  sessionFile: string
  sessionName?: string
  boundAt: string
}

interface MappingFile {
  version: 1
  bindings: Binding[]
}

function key(chatId: string, threadId: string | null): string {
  return threadId ? `${chatId}#${threadId}` : chatId
}

/** Persistent chat <-> session bindings. */
export class Mapping {
  private readonly bindings = new Map<string, Binding>()

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as MappingFile
      if (parsed?.version === 1 && Array.isArray(parsed.bindings)) {
        for (const binding of parsed.bindings) {
          if (binding?.chatId && binding?.sessionFile) {
            this.bindings.set(key(binding.chatId, binding.threadId ?? null), {
              ...binding,
              threadId: binding.threadId ?? null,
              platform: binding.platform || 'lark',
            })
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const payload: MappingFile = { version: 1, bindings: [...this.bindings.values()] }
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await rename(tmp, this.filePath)
  }

  async bind(
    chatId: string,
    sessionFile: string,
    sessionName?: string,
    threadId: string | null = null,
    replyMessageId?: string,
  ): Promise<Binding> {
    const binding: Binding = {
      platform: 'lark',
      chatId,
      threadId,
      // Only a topic-scoped binding anchors its answers to a message. Keeping the
      // anchor for a chat-scoped binding made every answer a `reply_in_thread`
      // reply, which creates a Lark thread the plain chat key cannot follow.
      ...(replyMessageId && threadId ? { replyMessageId } : {}),
      sessionFile,
      ...(sessionName ? { sessionName } : {}),
      boundAt: new Date().toISOString(),
    }
    this.bindings.set(key(chatId, threadId), binding)
    await this.save()
    return binding
  }

  /**
   * Effective binding for an inbound message.
   *
   * A chat-level binding also covers messages sent inside a Lark thread of that
   * chat: replying in a thread sets the message's `thread_id`, so a strict
   * `chat#thread` lookup would miss a plain chat binding. An exact thread
   * binding still wins, which keeps per-topic bindings isolated.
   */
  lookup(chatId: string, threadId: string | null = null): Binding | undefined {
    const exact = this.bindings.get(key(chatId, threadId))
    if (exact) return exact
    return threadId ? this.bindings.get(key(chatId, null)) : undefined
  }

  async unbind(chatId: string, threadId: string | null = null): Promise<boolean> {
    const bound = this.lookup(chatId, threadId)
    if (!bound) return false
    const removed = this.bindings.delete(key(bound.chatId, bound.threadId))
    if (removed) await this.save()
    return removed
  }

  lookupsBySession(sessionFile: string): Binding[] {
    return [...this.bindings.values()].filter(binding => binding.sessionFile === sessionFile)
  }

  list(): Binding[] {
    return [...this.bindings.values()]
  }
}
