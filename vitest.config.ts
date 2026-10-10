import { defineConfig } from 'vitest/config'
import { commitStamp } from './commitStamp.ts'

export default defineConfig({
  define: {
    __AISIGAME_COMMIT__: JSON.stringify(commitStamp()),
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
