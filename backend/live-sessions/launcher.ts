import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { PiManager } from '../pi-manager.js'
import type { PiSession } from '../pi-session.js'
import { LiveSessionPathPolicy } from './path-policy.js'

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export interface LivePiStartOptions {
  cwd: string
  modelProvider?: string
  modelId?: string
  thinkingLevel?: string
  title?: string
}

export class LivePiLauncher {
  private readonly pathPolicy: LiveSessionPathPolicy

  constructor(
    private readonly manager: PiManager,
    roots: readonly string[],
    private readonly wireInteraction?: (pi: PiSession, slotKey: string) => void,
  ) {
    this.pathPolicy = new LiveSessionPathPolicy(roots)
  }

  async start(options: LivePiStartOptions): Promise<{ slotKey: string; cwd: string; title: string }> {
    const rawCwd = options.cwd === '~'
      ? os.homedir()
      : options.cwd.startsWith('~/') ? path.join(os.homedir(), options.cwd.slice(2)) : options.cwd
    const decision = await this.pathPolicy.authorize(rawCwd)
    if (!decision.allowed || !decision.canonicalCwd) throw new Error(decision.message || 'cwd is outside configured live session roots')
    if (options.thinkingLevel && !THINKING_LEVELS.has(options.thinkingLevel)) throw new Error('invalid_thinking_level')
    if (options.modelProvider && !options.modelId) throw new Error('model_id_required')
    if (options.modelId && !options.modelProvider) throw new Error('model_provider_required')

    const title = options.title?.trim().slice(0, 120) || `Live · ${path.basename(decision.canonicalCwd)}`
    const slotKey = `live-${randomUUID()}`
    const slot = this.manager.createSlot(title, null, {
      key: slotKey,
      cwd: decision.canonicalCwd,
      modelProvider: options.modelProvider || null,
      modelId: options.modelId || null,
      thinkingLevel: options.thinkingLevel || null,
      transport: 'rpc',
      runtime: 'live',
    })
    const pi = this.manager.ensureRunning(slot.key)
    if (!pi) throw new Error('live_pi_start_failed')
    this.wireInteraction?.(pi, slot.key)
    return { slotKey: slot.key, cwd: decision.canonicalCwd, title }
  }

  async stop(): Promise<void> {
    await this.manager.gracefulShutdown()
    await this.pathPolicy.stop()
  }
}
