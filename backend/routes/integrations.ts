import type { Request, Response } from 'express'
import { isDashboardFeatureName, type DashboardFeatureName } from '../../shared/src/extension-bridge.js'
import type { RouteDeps } from './types.js'
import { extensionBridgeRegistry } from '../extension-bridge/registry.js'

const MAX_COMMAND_BYTES = 1024 * 1024

const ALLOWED_COMMANDS: Record<DashboardFeatureName, ReadonlySet<string>> = {
  'subagent-workbench': new Set(['refresh', 'start-agent', 'start-workflow', 'send-agent', 'interrupt-agent', 'interrupt-workflow']),
  btw: new Set(['open', 'submit', 'abort', 'refresh-parent', 'close']),
  'background-commands': new Set(['refresh', 'output', 'cancel', 'background']),
}

function commandType(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return typeof (value as { type?: unknown }).type === 'string' ? (value as { type: string }).type : undefined
}

export function validateCommand(feature: DashboardFeatureName, command: unknown): string | undefined {
  let bytes = 0
  try { bytes = Buffer.byteLength(JSON.stringify(command), 'utf8') } catch { return 'command must be JSON serializable' }
  if (bytes > MAX_COMMAND_BYTES) return 'command exceeds 1 MiB'
  const type = commandType(command)
  if (!type || !ALLOWED_COMMANDS[feature].has(type)) return `unsupported ${feature} command`
  if (feature === 'background-commands' && type === 'cancel') {
    const taskId = (command as any).taskId
    if (typeof taskId !== 'string' || !/^bash-[a-z0-9]{4,16}$/.test(taskId)) return 'invalid background task id'
  }
  if (feature === 'background-commands' && type === 'background') {
    const toolCallId = (command as any).toolCallId
    if (typeof toolCallId !== 'string' || !toolCallId.trim() || toolCallId.length > 256) return 'invalid tool call id'
  }
  if (feature === 'background-commands' && type === 'output') {
    const taskId = (command as any).taskId
    const tailLines = (command as any).tailLines
    if (typeof taskId !== 'string' || !/^bash-[a-z0-9]{4,16}$/.test(taskId)) return 'invalid background task id'
    if (tailLines !== undefined && (!Number.isInteger(tailLines) || tailLines < 1 || tailLines > 2000)) return 'tailLines must be between 1 and 2000'
  }
  return undefined
}

export function registerIntegrationRoutes(deps: RouteDeps): void {
  const { app, manager, wireSlotEvents } = deps

  const ensureSlot = (slot: string) => {
    const pi = manager.ensureRunning(slot)
    if (pi && !pi._wired) {
      wireSlotEvents(pi, slot)
      pi._wired = true
    }
    return pi
  }

  app.get('/api/chat/slots/:slot/integrations', (req: Request, res: Response) => {
    const slot = req.params.slot as string
    if (!ensureSlot(slot)) return res.status(404).json({ error: 'slot not found' })
    res.json({ integrations: extensionBridgeRegistry.list(slot) })
  })

  app.get('/api/chat/slots/:slot/integrations/:feature', (req: Request, res: Response) => {
    const slot = req.params.slot as string
    const feature = req.params.feature
    if (!ensureSlot(slot)) return res.status(404).json({ error: 'slot not found' })
    if (!isDashboardFeatureName(feature)) return res.status(404).json({ error: 'unknown integration' })
    const snapshot = extensionBridgeRegistry.get(slot, feature)
    if (!snapshot) return res.status(409).json({ error: 'integration_unavailable', feature })
    res.json(snapshot)
  })

  app.post('/api/chat/slots/:slot/integrations/:feature/commands', async (req: Request, res: Response) => {
    const slot = req.params.slot as string
    const feature = req.params.feature
    if (!ensureSlot(slot)) return res.status(404).json({ error: 'slot not found' })
    if (!isDashboardFeatureName(feature)) return res.status(404).json({ error: 'unknown integration' })
    const command = req.body?.command
    const validationError = validateCommand(feature, command)
    if (validationError) return res.status(400).json({ error: 'invalid_integration_command', message: validationError })
    try {
      const result = await extensionBridgeRegistry.dispatch(slot, feature, command)
      res.json({ ok: true, result })
    } catch (error: any) {
      const code = error?.code || 'integration_command_failed'
      const status = code === 'integration_unavailable' ? 409 : code === 'integration_timeout' ? 504 : 500
      res.status(status).json({ error: code, message: error?.message || String(error) })
    }
  })
}
