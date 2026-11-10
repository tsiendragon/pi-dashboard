import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeExecCount, handleExecConnection, parseExecControl } from '../exec-manager.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

/** Minimal stand-in for the ws server socket: records frames and close(). */
class FakeSocket extends EventEmitter {
  readyState = 1
  readonly sent: any[] = []
  closed = false
  send(payload: string) { this.sent.push(JSON.parse(payload)) }
  close() { this.closed = true; this.readyState = 3; this.emit('close') }
  frames() { return this.sent.map(frame => frame.type) }
  output(): string { return this.sent.filter(frame => frame.type === 'output').map(frame => frame.data).join('') }
}

function connect(clientId = 'browser-a') {
  const socket = new FakeSocket()
  handleExecConnection(socket as never, {} as never, { browserClientId: clientId })
  return socket
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timed out')
}

describe('exec control frames', () => {
  it('accepts only well-formed start/input/resize/signal frames', () => {
    expect(parseExecControl({ type: 'start', command: 'echo hi', cwd: '/tmp', cols: 100, rows: 30 })).toMatchObject({ command: 'echo hi', cwd: '/tmp' })
    expect(parseExecControl({ type: 'start', command: '   ', cwd: '/tmp' })).toBeUndefined()
    expect(parseExecControl({ type: 'start', command: 'echo hi', cwd: 'relative/path' })).toBeUndefined()
    expect(parseExecControl({ type: 'start', command: 'x'.repeat(9 * 1024), cwd: '/tmp' })).toBeUndefined()
    expect(parseExecControl({ type: 'start', command: 'echo', cwd: '/tmp', extra: 1 })).toBeUndefined()
    expect(parseExecControl({ type: 'input', data: 'y\n' })).toEqual({ type: 'input', data: 'y\n' })
    expect(parseExecControl({ type: 'input', data: 'x'.repeat(17 * 1024) })).toBeUndefined()
    expect(parseExecControl({ type: 'resize', cols: 9999, rows: 0 })).toEqual({ type: 'resize', cols: 500, rows: 1 })
    expect(parseExecControl({ type: 'signal', name: 'SIGKILL' })).toBeUndefined()
    expect(parseExecControl({ type: 'exec', command: 'rm -rf /' })).toBeUndefined()
  })
})

describe('interactive command channel', () => {
  it('streams output and reports the exit code', async () => {
    const socket = connect()
    socket.emit('message', JSON.stringify({ type: 'start', command: 'printf "hello"; exit 3', cwd: '/tmp' }))
    await waitFor(() => socket.frames().includes('exit'))
    expect(socket.output()).toContain('hello')
    expect(socket.sent.find(frame => frame.type === 'exit')).toMatchObject({ code: 3 })
    expect(socket.closed).toBe(true)
  })

  it('forwards typed input to a prompt', async () => {
    const socket = connect()
    socket.emit('message', JSON.stringify({ type: 'start', command: 'read -r x; printf "got:%s" "$x"', cwd: '/tmp' }))
    await waitFor(() => socket.frames().includes('started'))
    socket.emit('message', JSON.stringify({ type: 'input', data: 'secret-answer\n' }))
    await waitFor(() => socket.output().includes('got:secret-answer'))
    await waitFor(() => socket.closed)
  })

  it('rejects a missing directory without running anything', async () => {
    const socket = connect()
    socket.emit('message', JSON.stringify({ type: 'start', command: 'echo hi', cwd: '/definitely/not/here' }))
    await waitFor(() => socket.frames().includes('error'))
    expect(socket.sent.find(frame => frame.type === 'error')).toMatchObject({ code: 'invalid_cwd' })
    expect(socket.frames()).not.toContain('started')
  })

  it('refuses malformed frames and never treats them as keystrokes', async () => {
    const socket = connect()
    socket.emit('message', 'not json')
    expect(socket.sent.at(-1)).toMatchObject({ type: 'error', code: 'invalid_frame' })
    socket.emit('message', JSON.stringify({ type: 'input', data: 'ls\n' }))
    expect(socket.sent.at(-1)).toMatchObject({ type: 'error', code: 'not_started' })
  })

  it('caps concurrent commands per browser and frees the slot on close', async () => {
    const first = connect('browser-cap')
    first.emit('message', JSON.stringify({ type: 'start', command: 'read -r x', cwd: '/tmp' }))
    await waitFor(() => first.frames().includes('started'))
    const second = connect('browser-cap')
    second.emit('message', JSON.stringify({ type: 'start', command: 'read -r x', cwd: '/tmp' }))
    await waitFor(() => second.frames().includes('started'))
    const third = connect('browser-cap')
    third.emit('message', JSON.stringify({ type: 'start', command: 'read -r x', cwd: '/tmp' }))
    await waitFor(() => third.frames().includes('started'))

    const fourth = connect('browser-cap')
    await waitFor(() => fourth.frames().includes('error'))
    expect(fourth.sent.find(frame => frame.type === 'error')).toMatchObject({ code: 'too_many_sessions' })
    expect(activeExecCount('browser-cap')).toBe(3)

    first.close()
    await waitFor(() => activeExecCount('browser-cap') === 2)
    second.close()
    third.close()
    await waitFor(() => activeExecCount('browser-cap') === 0)
  })

  it('kills the process when the client goes away', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pidash-exec-'))
    dirs.push(dir)
    const socket = connect('browser-close')
    socket.emit('message', JSON.stringify({ type: 'start', command: 'echo $$; read -r x', cwd: dir }))
    await waitFor(() => socket.output().includes('\n'))
    const pid = Number(socket.output().trim().split('\n')[0])
    socket.close()
    await waitFor(() => {
      try { process.kill(pid, 0); return false } catch { return true }
    })
  })
})