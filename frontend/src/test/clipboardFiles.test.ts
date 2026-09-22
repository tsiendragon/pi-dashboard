import { describe, expect, it } from 'vitest'
import { clipboardFiles, pastedFileRef, splitFilesByKind } from '../utils/clipboardFiles'

describe('clipboardFiles', () => {
  it('collects files from kind:file items and ignores text items', () => {
    const md = new File(['# hi'], 'notes.md', { type: 'text/markdown' })
    const files = clipboardFiles({
      items: [
        { kind: 'string', type: 'text/plain', getAsFile: () => null },
        { kind: 'file', type: 'text/markdown', getAsFile: () => md },
      ],
    })
    expect(files).toEqual([md])
  })

  it('falls back to clipboardData.files when items carry no file', () => {
    const json = new File(['{}'], 'config.json', { type: 'application/json' })
    expect(clipboardFiles({ items: [{ kind: 'string', type: 'text/plain' }], files: [json] })).toEqual([json])
  })

  it('returns nothing for a plain text paste', () => {
    expect(clipboardFiles({ items: [{ kind: 'string', type: 'text/plain' }] })).toEqual([])
  })

  it('tolerates a missing clipboard payload', () => {
    expect(clipboardFiles(null)).toEqual([])
    expect(clipboardFiles(undefined)).toEqual([])
  })
})

describe('splitFilesByKind', () => {
  it('routes images inline and every other type to upload', () => {
    const png = new File(['x'], 'shot.png', { type: 'image/png' })
    const md = new File(['# hi'], 'notes.md', { type: 'text/markdown' })
    const unknown = new File(['x'], 'model.onnx', { type: '' })
    const { images, documents } = splitFilesByKind([png, md, unknown])
    expect(images).toEqual([png])
    expect(documents).toEqual([md, unknown])
  })
})

describe('pastedFileRef', () => {
  it('accepts a bare file name pasted by a macOS file manager', () => {
    expect(pastedFileRef({ text: 'Pi_Skill_Forge_Design_2026-09-21.md' })).toBe('Pi_Skill_Forge_Design_2026-09-21.md')
  })

  it('accepts absolute, home and relative paths', () => {
    expect(pastedFileRef({ text: '/tmp/config.json' })).toBe('/tmp/config.json')
    expect(pastedFileRef({ text: '~/notes/todo.md' })).toBe('~/notes/todo.md')
    expect(pastedFileRef({ text: './docs/a.md' })).toBe('./docs/a.md')
  })

  it('prefers a file:// entry from text/uri-list', () => {
    expect(pastedFileRef({ uriList: 'file:///Users/me/Desktop/notes.md', text: 'notes.md' })).toBe('/Users/me/Desktop/notes.md')
    expect(pastedFileRef({ text: 'file:///tmp/a%20b.json' })).toBe('/tmp/a b.json')
  })

  it('ignores prose, multi-line text and web URLs', () => {
    expect(pastedFileRef({ text: 'see notes.md for details' })).toBeNull()
    expect(pastedFileRef({ text: 'first.md\nsecond.md' })).toBeNull()
    expect(pastedFileRef({ text: 'https://example.com/a.md' })).toBeNull()
    expect(pastedFileRef({ text: 'hello world' })).toBeNull()
    expect(pastedFileRef({ uriList: 'https://example.com', text: '' })).toBeNull()
    expect(pastedFileRef({})).toBeNull()
  })
})