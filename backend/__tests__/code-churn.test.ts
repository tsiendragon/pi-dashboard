import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { CodeChurnLedger } from '../code-churn.js'

const NOW = Date.now()
const MONTH = new Date(NOW).toISOString().slice(0, 7)

function toolCallLine(timestamp: number, name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'message',
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: 'assistant',
      timestamp,
      content: [{ type: 'toolCall', name, arguments: args }],
    },
  })
}

async function waitForReport(ledger: CodeChurnLedger, month: string, timezone: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const report = await ledger.getReport(month, timezone)
    if (!report.scanning) return report
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('churn scan did not finish')
}

async function seedSessions(lines: string[]): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-churn-'))
  const project = path.join(root, '--home-tsien-repos-demo--')
  await mkdir(project)
  await writeFile(path.join(project, 'session.jsonl'), `${lines.join('\n')}\n`)
  return root
}

describe('CodeChurnLedger', () => {
  it('counts added and removed lines per day and splits code from docs', async () => {
    const root = await seedSessions([
      toolCallLine(NOW, 'write', { path: '/repo/a.ts', content: 'one\ntwo\nthree' }),
      toolCallLine(NOW, 'edit', { path: '/repo/a.ts', edits: [{ oldText: 'one\ntwo', newText: 'one\nTWO\nextra\nfour' }] }),
      toolCallLine(NOW, 'write', { path: '/repo/notes.md', content: 'a\nb\nc\nd\ne' }),
      toolCallLine(NOW, 'write', { path: '/repo/notes.md', content: 'a\nb' }),
    ])
    const ledger = new CodeChurnLedger({ sessionsRoot: root, timezone: 'UTC' })
    const report = await waitForReport(ledger, MONTH, 'UTC')

    expect(report.scanning).toBe(false)
    expect(report.filesScanned).toBe(1)
    expect(report.total).toMatchObject({
      // write 3 lines; edit adds 4 and removes 2; first md write 5; rewrite shrinks by 3.
      added: 12,
      removed: 5,
      codeAdded: 7,
      codeRemoved: 2,
      docAdded: 5,
      docRemoved: 3,
      calls: 4,
      files: 2,
    })
    expect(report.days).toHaveLength(new Date(Date.UTC(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5, 7)), 0)).getUTCDate())
    const activeDay = report.days.find(day => day.calls > 0)
    expect(activeDay).toMatchObject({ added: 12, removed: 5 })
  })

  it('ignores non-write tools, malformed lines, and caches per file version', async () => {
    const root = await seedSessions([
      toolCallLine(NOW, 'read', { path: '/repo/a.ts' }),
      toolCallLine(NOW, 'bash', { command: 'echo hi' }),
      '{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","name":"edit"',
      toolCallLine(NOW, 'edit', { path: '/repo/b.py', edits: [{ oldText: 'x', newText: 'x\ny' }] }),
    ])
    const ledger = new CodeChurnLedger({ sessionsRoot: root, timezone: 'UTC' })
    const first = await waitForReport(ledger, MONTH, 'UTC')
    expect(first.total).toMatchObject({ added: 2, removed: 1, codeAdded: 2, codeRemoved: 1, calls: 1, files: 1 })

    const second = await ledger.getReport(MONTH, 'UTC')
    expect(second.scanning).toBe(false)
    expect(second.total).toEqual(first.total)
  })

  it('rejects a month that is not YYYY-MM', async () => {
    const root = await seedSessions([])
    const ledger = new CodeChurnLedger({ sessionsRoot: root, timezone: 'UTC' })
    await expect(ledger.getReport('2026-13', 'UTC')).rejects.toThrow('month must use YYYY-MM format')
    await expect(ledger.getReport('September', 'UTC')).rejects.toThrow('month must use YYYY-MM format')
  })
})