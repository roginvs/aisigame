import { defineConfig } from 'vitest/config'
import { commitDate, commitStamp } from './commitStamp.ts'

export default defineConfig({
  define: {
    __AISIGAME_COMMIT__: JSON.stringify(commitStamp()),
    __AISIGAME_COMMIT_DATE__: JSON.stringify(commitDate()),
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
