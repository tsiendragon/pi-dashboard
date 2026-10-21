import { describe, expect, it } from 'vitest'
import { remoteForms, scrubRemote } from '../features/repos/api'

describe('scrubRemote', () => {
  it('hides credentials embedded in https remotes', () => {
    expect(scrubRemote('https://u:github_pat_ABC123@github.com/a/b.git')).toBe('https://***@github.com/a/b.git')
    expect(scrubRemote('https://user:pass@gitlab.example.com/a/b.git')).toBe('https://***@gitlab.example.com/a/b.git')
  })

  it('leaves credential-free remotes untouched', () => {
    expect(scrubRemote('git@github.com:a/b.git')).toBe('git@github.com:a/b.git')
    expect(scrubRemote('https://github.com/a/b.git')).toBe('https://github.com/a/b.git')
    expect(scrubRemote('git@your-org:my-library.git')).toBe('git@your-org:my-library.git')
  })
})

describe('remoteForms', () => {
  it('derives both forms from an scp-style ssh remote', () => {
    expect(remoteForms('git@github.com:a/b.git')).toEqual({ ssh: 'git@github.com:a/b.git', https: 'https://github.com/a/b.git' })
  })

  it('derives both forms from an https remote', () => {
    expect(remoteForms('https://github.com/a/b.git')).toEqual({ ssh: 'git@github.com:a/b.git', https: 'https://github.com/a/b.git' })
    expect(remoteForms('https://github.com/a/b')).toEqual({ ssh: 'git@github.com:a/b.git', https: 'https://github.com/a/b.git' })
  })

  it('drops embedded credentials instead of copying them into either form', () => {
    const forms = remoteForms('https://u:github_pat_ABC123@github.com/a/b.git')
    expect(forms).toEqual({ ssh: 'git@github.com:a/b.git', https: 'https://github.com/a/b.git' })
    expect(JSON.stringify(forms)).not.toContain('github_pat_')
  })

  it('keeps an explicit ssh port in the ssh form', () => {
    expect(remoteForms('ssh://git@host:2222/a/b.git')).toEqual({ ssh: 'ssh://git@host:2222/a/b.git', https: 'https://host/a/b.git' })
  })

  it('returns nothing for local paths and empty remotes', () => {
    expect(remoteForms('/home/x/repo')).toEqual({ ssh: null, https: null })
    expect(remoteForms('')).toEqual({ ssh: null, https: null })
    expect(remoteForms('   ')).toEqual({ ssh: null, https: null })
  })
})