import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, '../../packages/shared') } },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node'
  }
})
