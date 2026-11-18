import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Backend suites plus the Lark channel gateway: `npm test` should cover the
    // gateway's cards/bindings rules, not only the dashboard server.
    include: ['backend/__tests__/**/*.test.{js,ts}', 'channels/lark/src/**/*.test.ts'],
    environment: 'node',
  },
})
