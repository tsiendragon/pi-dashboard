import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// Isolated frontend checks: do not run the app's source-generating plugin.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': fileURLToPath(new URL('../../../../shared/src', import.meta.url)) } },
  test: { environment: 'jsdom', globals: true, setupFiles: './src/test/setup.ts', include: ['src/test/supervisor*.test.tsx'] },
})
