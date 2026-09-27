import { createHash, randomBytes } from 'node:crypto'
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { noDuplicateKeys } from './machine-connector.js'

const MAX = 100_000
const HASH = /^[0-9a-f]{64}$/
const NAME = 'machine-input-replay.json'
const privateStateDir = () => join(homedir(), '.pi-dashboard-private')
export const machineInputReplayPath = () => join(privateStateDir(), NAME)

function safeDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || (stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid()))
    throw Error('Unsafe replay directory')
}
function filePresent(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
function safeFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1
    || (process.getuid && stat.uid !== process.getuid())) throw Error('Unsafe replay file')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > 7_000_000) throw Error('Unsafe replay file')
  } finally { closeSync(fd) }
}

/** Exclusive process lock: a crashed owner leaves a lock requiring manual review/removal. Never evict IDs. */
export function openMachineInputReplay(path = machineInputReplayPath()) {
  const dir = dirname(path)
  if (dir === privateStateDir()) {
    // The agent config directory can be group-writable; never place an atomic
    // replay journal there. Create a private sibling directly under a safe home.
    safeDirectory(homedir())
    try { mkdirSync(dir, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  safeDirectory(dir)
  if (dir === privateStateDir() && (lstatSync(dir).mode & 0o777) !== 0o700) throw Error('Private replay directory must be mode 0700')
  const lock = `${path}.lock`
  const lockFd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  fchmodSync(lockFd, 0o600)
  const lockStat = fstatSync(lockFd)
  let closed = false
  try {
    if (filePresent(path)) safeFile(path)
    let ids: string[] = []
    if (filePresent(path)) {
      const bytes = readFileSync(path)
      const text = bytes.toString('utf8')
      if (!Buffer.from(text).equals(bytes) || !noDuplicateKeys(text)) throw Error('Corrupt replay state')
      const value: unknown = JSON.parse(text)
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'ids'
        || !Array.isArray((value as { ids: unknown }).ids)) throw Error('Corrupt replay state')
      ids = (value as { ids: string[] }).ids
      if (ids.length > MAX || ids.some(id => typeof id !== 'string' || !HASH.test(id)) || new Set(ids).size !== ids.length)
        throw Error('Corrupt replay state')
    }
    const seen = new Set(ids)
    let expected = filePresent(path) ? JSON.stringify({ ids }) : undefined
    if (expected !== undefined && readFileSync(path, 'utf8') !== expected) throw Error('Corrupt replay state')
    let poisoned = false
    return {
      reserve(clientId: string, requestId: string): boolean {
        if (closed || poisoned) throw Error('Replay store unavailable')
        const id = createHash('sha256').update(JSON.stringify([clientId, requestId])).digest('hex')
        if (seen.has(id)) return false
        if (seen.size >= MAX) throw Error('Replay store full')
        let temp: string | undefined
        try {
          safeDirectory(dir)
          safeFile(lock)
          const currentLock = lstatSync(lock)
          if (currentLock.ino !== lockStat.ino || currentLock.dev !== lockStat.dev) throw Error('Replay lock replaced')
          if (filePresent(path)) {
            safeFile(path)
            if (expected === undefined || readFileSync(path, 'utf8') !== expected) throw Error('Replay file changed')
          } else if (expected !== undefined) throw Error('Replay file missing')
          const next = JSON.stringify({ ids: [...seen, id] })
          temp = join(dir, `.${NAME}.${randomBytes(16).toString('hex')}.tmp`)
          const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
          try { fchmodSync(fd, 0o600); writeFileSync(fd, next); fsyncSync(fd) } finally { closeSync(fd) }
          safeDirectory(dir)
          if (filePresent(path)) {
            safeFile(path)
            if (expected === undefined || readFileSync(path, 'utf8') !== expected) throw Error('Replay file changed')
          } else if (expected !== undefined) throw Error('Replay file missing')
          renameSync(temp, path)
          temp = undefined
          const dirFd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
          try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
          seen.add(id)
          expected = next
          return true
        } catch (error) {
          poisoned = true // including uncertain rename/fsync results: no further dispatch
          throw error
        } finally { if (temp) { try { unlinkSync(temp) } catch { /* fail closed */ } } }
      },
      close(): void {
        if (closed) return
        closed = true
        closeSync(lockFd)
        // Do not remove a replaced lock owned by somebody else.
        try { if (lstatSync(lock).ino === lockStat.ino) unlinkSync(lock) } catch { /* stale lock fails closed */ }
      },
    }
  } catch (error) { closeSync(lockFd); try { unlinkSync(lock) } catch { /* fail closed */ }; throw error }
}
