import { useCallback, useEffect, useRef, useState } from 'react'
import type { Comment } from './usePanelState'
import { loadCurrentFileVersion, loadFileComments, saveFileComments } from '../api/fileComments'

export interface DocumentComments {
  comments: Comment[]
  addComment: (startLine: number, endLine: number, content: string, quote?: string) => void
  editComment: (id: string, content: string) => void
  deleteComment: (id: string) => void
  removeComments: (ids: string[]) => void
}

/**
 * Comment state for a file rendered outside the side panel (the full-screen
 * preview modal). Loads the same `.‹name›.comments.json` sidecar the side panel
 * uses, so both surfaces share one comment list.
 */
export function useDocumentComments(filePath: string | null): DocumentComments {
  const [comments, setComments] = useState<Comment[]>([])
  const versionRef = useRef(1)

  useEffect(() => {
    setComments([])
    versionRef.current = 1
    if (!filePath) return
    let cancelled = false
    void loadFileComments(filePath).then(loaded => { if (!cancelled) setComments(loaded) })
    void loadCurrentFileVersion(filePath).then(version => { if (!cancelled) versionRef.current = version })
    return () => { cancelled = true }
  }, [filePath])

  const persist = useCallback((next: Comment[]) => {
    setComments(next)
    if (!filePath) return
    void saveFileComments(filePath, next).catch(error => console.warn('[file-comments] save failed', error))
  }, [filePath])

  const addComment = useCallback((startLine: number, endLine: number, content: string, quote?: string) => {
    const comment: Comment = {
      id: crypto.randomUUID(),
      startLine,
      endLine,
      content,
      ...(quote ? { quote } : {}),
      version: versionRef.current,
      createdAt: new Date().toISOString(),
    }
    persist([...comments, comment])
  }, [comments, persist])

  const editComment = useCallback((id: string, content: string) => {
    persist(comments.map(c => (c.id === id ? { ...c, content } : c)))
  }, [comments, persist])

  const deleteComment = useCallback((id: string) => {
    persist(comments.filter(c => c.id !== id))
  }, [comments, persist])

  const removeComments = useCallback((ids: string[]) => {
    persist(comments.filter(c => !ids.includes(c.id)))
  }, [comments, persist])

  return { comments, addComment, editComment, deleteComment, removeComments }
}