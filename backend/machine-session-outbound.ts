import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connectMachine, noDuplicateKeys, validateMachineConfig, type MachineConnection, type MachineConnectorConfig, type MachineControl, type InputReservation, type PreviewLookup, type SessionRow } from './machine-connector.js'

/** File presence opts in; no environment variable contains the secret. Invalid files disable the link. */
export const machineConfigPath = () => join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'machine-connector.json')

export async function readMachineConfig(path: string): Promise<MachineConnectorConfig | undefined> {
  let file
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('Machine connector configuration unavailable')
  }
  try {
    const stat = await file.stat()
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid()) || stat.size > 2048 || stat.size === 0)
      throw new Error('Machine connector configuration permissions or size invalid')
    const bytes = await file.readFile()
    const text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes) || !noDuplicateKeys(text)) throw Error('Invalid machine config')
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid machine config')
    const fields = value as Record<string, unknown>
    if (Object.keys(fields).sort().join(',') !== 'endpoint,key,machineId'
      || typeof fields.endpoint !== 'string' || typeof fields.key !== 'string' || typeof fields.machineId !== 'string')
      throw Error('Invalid machine config')
    const config = fields as unknown as MachineConnectorConfig
    validateMachineConfig(config)
    return config
  } finally { await file.close() }
}

/** Bounded exponential retry; stop aborts even an in-progress handshake. No reconnect after shutdown. */
export function startMachineOutbound(config: MachineConnectorConfig, list: () => readonly SessionRow[],
  connect: typeof connectMachine = connectMachine,
  delay: (ms: number, signal: AbortSignal) => Promise<void> = (ms, signal) => new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(finish, ms)
    function finish() { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    signal.addEventListener('abort', finish, { once: true })
  }), control?: MachineControl, reserve?: InputReservation, preview?: PreviewLookup) {
  if (control && !reserve) throw Error('Machine control requires durable input reservation')
  const aborter = new AbortController()
  let current: MachineConnection | undefined
  const done = (async () => {
    for (let attempt = 0; !aborter.signal.aborted; attempt = Math.min(attempt + 1, 5)) {
      try {
        current = await connect(config, list, aborter.signal, control, reserve, preview)
        attempt = 0 // a previously healthy connection should not inherit old failure backoff
        await current.closed
      } catch { /* no endpoint, key, or remote data in logs */ }
      finally { current = undefined }
      if (aborter.signal.aborted) break
      await delay(Math.min(30_000, 1000 * 2 ** attempt), aborter.signal)
    }
  })()
  return { stop: async () => { aborter.abort(); current?.close(); await done }, done }
}
