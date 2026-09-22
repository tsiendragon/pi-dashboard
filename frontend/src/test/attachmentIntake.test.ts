import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import { resolveFileRef, uploadAttachedFiles, withAttachedFile } from '../utils/attachmentIntake'

afterEach(() => vi.restoreAllMocks())

describe('uploadAttachedFiles', () => {
  it('sends base64 payloads and keeps the original file names', async () => {
    const upload = vi.spyOn(api, 'uploadFiles').mockResolvedValue({ ok: true, paths: ['/tmp/u/1-notes.md'] })
    const file = new File(['# hi'], 'notes.md', { type: 'text/markdown' })

    expect(await uploadAttachedFiles([file])).toEqual([{ name: 'notes.md', path: '/tmp/u/1-notes.md' }])
    const payload = upload.mock.calls[0][0]
    expect(payload).toHaveLength(1)
    expect(payload[0].name).toBe('notes.md')
    expect(payload[0].data).not.toContain('data:')
  })

  it('rejects when the server returns no path', async () => {
    vi.spyOn(api, 'uploadFiles').mockResolvedValue({ ok: false, paths: [] })
    await expect(uploadAttachedFiles([new File(['x'], 'x.txt')])).rejects.toThrow()
  })

  it('does nothing without files', async () => {
    const upload = vi.spyOn(api, 'uploadFiles')
    expect(await uploadAttachedFiles([])).toEqual([])
    expect(upload).not.toHaveBeenCalled()
  })
})

describe('resolveFileRef', () => {
  it('resolves an absolute path from its parent directory listing', async () => {
    vi.spyOn(api, 'browseFiles').mockResolvedValue({
      path: '/repo/docs', parent: '/repo', entries: [{ name: 'a.md', path: '/repo/docs/a.md', isDir: false }],
    })
    expect(await resolveFileRef('/repo/docs/a.md')).toEqual({ name: 'a.md', path: '/repo/docs/a.md' })
  })

  it('resolves a bare file name against the workspace cwd', async () => {
    const browse = vi.spyOn(api, 'browseFiles').mockResolvedValue({
      path: '/repo', parent: '/', entries: [{ name: 'notes.md', path: '/repo/notes.md', isDir: false }],
    })
    expect(await resolveFileRef('notes.md', '/repo')).toEqual({ name: 'notes.md', path: '/repo/notes.md' })
    expect(browse).toHaveBeenCalledWith('/repo')
  })

  it('ignores directories that share the name', async () => {
    vi.spyOn(api, 'browseFiles').mockResolvedValue({
      path: '/repo', parent: '/', entries: [{ name: 'notes.md', path: '/repo/notes.md', isDir: true }],
    })
    vi.spyOn(api, 'fileSearch').mockResolvedValue({ entries: [] })
    expect(await resolveFileRef('notes.md', '/repo')).toBeNull()
  })

  it('falls back to a unique exact-name search', async () => {
    vi.spyOn(api, 'browseFiles').mockRejectedValue(new Error('ENOENT'))
    vi.spyOn(api, 'fileSearch').mockResolvedValue({
      entries: [{ name: 'notes.md', path: '/home/me/Desktop/notes.md', isDir: false }],
    })
    expect(await resolveFileRef('notes.md', '/repo')).toEqual({ name: 'notes.md', path: '/home/me/Desktop/notes.md' })
  })

  it('prefers the workspace copy when the name exists in several places', async () => {
    vi.spyOn(api, 'browseFiles').mockRejectedValue(new Error('ENOENT'))
    vi.spyOn(api, 'fileSearch').mockResolvedValue({
      entries: [
        { name: 'notes.md', path: '/home/me/notes.md', isDir: false },
        { name: 'notes.md', path: '/repo/notes.md', isDir: false },
      ],
    })
    expect(await resolveFileRef('notes.md', '/repo')).toEqual({ name: 'notes.md', path: '/repo/notes.md' })
  })

  it('never guesses between same-named files outside the workspace', async () => {
    vi.spyOn(api, 'browseFiles').mockRejectedValue(new Error('ENOENT'))
    vi.spyOn(api, 'fileSearch').mockResolvedValue({
      entries: [
        { name: 'notes.md', path: '/home/me/a/notes.md', isDir: false },
        { name: 'notes.md', path: '/home/me/b/notes.md', isDir: false },
      ],
    })
    expect(await resolveFileRef('notes.md', '/repo')).toBeNull()
  })

  it('does not search the host for a foreign absolute path', async () => {
    vi.spyOn(api, 'browseFiles').mockRejectedValue(new Error('ENOENT'))
    const search = vi.spyOn(api, 'fileSearch')
    expect(await resolveFileRef('/Users/me/Desktop/notes.md')).toBeNull()
    expect(search).not.toHaveBeenCalled()
  })
})

describe('withAttachedFile', () => {
  const notes = { name: 'notes.md', path: '/repo/notes.md' }

  it('appends new attachments and dedupes by path', () => {
    expect(withAttachedFile([], notes)).toEqual([notes])
    expect(withAttachedFile([notes], notes)).toEqual([notes])
    expect(withAttachedFile([notes], { name: 'other.md', path: '/repo/other.md' })).toHaveLength(2)
  })
})