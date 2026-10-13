import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { commitDate, commitStamp } from './commitStamp.ts'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const localPacksId = 'virtual:local-packs'
const resolvedLocalPacksId = `\0${localPacksId}`

function readLocalPackFiles(): string[] {
  const dir = path.join(rootDir, 'public/packs')
  if (!fs.existsSync(dir)) return []
  return ['builtin', 'external'].flatMap((folder) => {
    const full = path.join(dir, folder)
    if (!fs.existsSync(full)) return []
    return fs.readdirSync(full, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.siq'))
      .map((entry) => `${folder}/${entry.name}`)
      .sort((left, right) => left.localeCompare(right, 'en'))
  })
}

/** Встроенный демо-пакет и локальные внешние .siq из двух каталогов. */
function localPackCatalog(): Plugin {
  return {
    name: 'local-pack-catalog',
    resolveId(id) {
      if (id === localPacksId) return resolvedLocalPacksId
    },
    load(id) {
      if (id !== resolvedLocalPacksId) return null
      return `export const localPackFiles = ${JSON.stringify(readLocalPackFiles())}\n`
    },
  }
}

// Dev and `npm run look` stay at `/`. The production build is published at
// https://roginvs.github.io/aisigame/, so assets need that project prefix.
export default defineConfig(({ command, mode }) => ({
  base: command === 'build' || mode === 'production' ? '/aisigame/' : '/',
  define: {
    __AISIGAME_COMMIT__: JSON.stringify(commitStamp()),
    __AISIGAME_COMMIT_DATE__: JSON.stringify(commitDate()),
  },
  plugins: [react(), localPackCatalog()],
  server: {
    host: true,
    port: 5173,
  },
}))
