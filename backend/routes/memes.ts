import type { Express } from 'express'
import type { LiveSessionBrowserAuth } from '../live-sessions/auth.js'
import { MemeError, memeProviders, prepareMeme } from '../memes.js'
import {
  activeMemeJob, getMemeJob, listMemeJobs, memeImageFile, memeJobView, startMemeJob,
} from '../meme-jobs.js'
import { requireBrowserAuth } from './require-browser-auth.js'

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

export function registerMemeRoutes({ app, auth }: { app: Express; auth: LiveSessionBrowserAuth }) {
  const authenticate = requireBrowserAuth(auth)

  app.get('/api/memes/providers', authenticate, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ providers: memeProviders() })
  })

  // History survives reloads, navigation and server restarts (the index is on disk).
  app.get('/api/memes/jobs', authenticate, (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const requested = Number(req.query.limit)
    res.json(listMemeJobs(Number.isFinite(requested) && requested > 0 ? requested : 100))
  })

  app.get('/api/memes/jobs/:id', authenticate, (req, res) => {
    const job = getMemeJob(String(req.params.id))
    if (!job) {
      res.status(404).json({ error: '找不到这次生成记录。' })
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    res.json({ job: memeJobView(job) })
  })

  app.get('/api/memes/images/:id', authenticate, (req, res) => {
    const file = memeImageFile(String(req.params.id))
    if (!file) {
      res.status(404).json({ error: '图片不存在或已被清理。' })
      return
    }
    const extension = EXTENSION_BY_MIME[file.mime] ?? 'png'
    res.setHeader('Content-Type', file.mime)
    res.setHeader('Content-Length', String(file.bytes))
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    res.setHeader(
      'Content-Disposition',
      `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="meme-${String(req.params.id)}.${extension}"`,
    )
    res.sendFile(file.path, error => {
      if (error && !res.headersSent) res.status(404).json({ error: '图片不存在或已被清理。' })
    })
  })

  // Accepts the job immediately and keeps generating after the browser leaves the page.
  app.post('/api/memes/generate', authenticate, (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const job = startMemeJob(prepareMeme(req.body))
      res.status(202).json({ job: memeJobView(job) })
    } catch (error) {
      if (error instanceof MemeError) {
        const active = activeMemeJob()
        res.status(error.status).json({ error: error.message, ...(active ? { job: memeJobView(active) } : {}) })
        return
      }
      console.error('[memes] Unexpected failure while starting generation')
      res.status(500).json({ error: '生成失败，请稍后重试。' })
    }
  })
}