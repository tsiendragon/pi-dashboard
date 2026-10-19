import type { Express } from 'express'
import type { LiveSessionBrowserAuth } from '../live-sessions/auth.js'
import { generateMeme, MemeError, memeProviders } from '../memes.js'
import { requireBrowserAuth } from './require-browser-auth.js'

export function registerMemeRoutes({ app, auth }: { app: Express; auth: LiveSessionBrowserAuth }) {
  const authenticate = requireBrowserAuth(auth)
  let generating = false
  app.get('/api/memes/providers', authenticate, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ providers: memeProviders() })
  })
  app.post('/api/memes/generate', authenticate, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (generating) {
      res.status(429).json({ error: '已有一张图片正在生成，请稍后再试。' })
      return
    }
    generating = true
    try {
      res.json(await generateMeme(req.body))
    } catch (error) {
      if (error instanceof MemeError) {
        res.status(error.status).json({ error: error.message })
      } else {
        // Do not log prompts, reference images, provider responses or credentials.
        console.error('[memes] Unexpected image generation failure')
        res.status(500).json({ error: '生成失败，请稍后重试。' })
      }
    } finally {
      generating = false
    }
  })
}
