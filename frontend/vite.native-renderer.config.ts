import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Builds the offline transcript renderer straight into the APK assets.
 *
 * `base: './'` keeps every URL relative so the page works from
 * `file:///android_asset/…` without a server; `assetsInlineLimit` stays small so
 * mermaid/highlight chunks load as local files instead of one huge data URL.
 */
export default defineConfig({
  root: path.join(here, 'native-renderer'),
  base: './',
  plugins: [react()],
  resolve: { alias: { '@shared': path.join(here, '../shared/src') } },
  build: {
    outDir: path.join(here, '../android/app/src/main/assets/native-renderer'),
    emptyOutDir: true,
    target: 'es2020',
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 4096,
  },
})