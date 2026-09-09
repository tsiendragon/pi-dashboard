// Minimal service worker for PWA installability.
// Network-first: always fetch from server, fall back to cache for offline shell.
// Cache version updated at build time — forces re-cache on deploy.

const CACHE = 'pi-dash-' + Date.now()
const SHELL = ['/', '/index.html']

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', e => {
  // Delete all old caches
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    ))
  )
  self.clients.claim()
})

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return
  const url = new URL(e.request.url)
  // Leave cross-origin requests under the browser's normal CORS handling.
  if (url.origin !== self.location.origin) return
  // Skip API, WebSocket, and dynamic requests from caching
  if (url.pathname.startsWith('/api')) return
  if (url.pathname.startsWith('/ws')) return
  // Skip Vite hashed assets — they have unique filenames already
  if (url.pathname.startsWith('/assets/')) return

  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r.ok) {
          const clone = r.clone()
          caches.open(CACHE).then(c => c.put(e.request, clone))
        }
        return r
      })
      .catch(async () => {
        const cached = await caches.match(e.request)
        if (cached) return cached
        if (e.request.mode === 'navigate') {
          return (await caches.match('/index.html')) || (await caches.match('/')) || Response.error()
        }
        return Response.error()
      })
  )
})
