import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const localPacksId = 'virtual:local-packs'
const resolvedLocalPacksId = `\0${localPacksId}`

function readLocalPackFiles(): string[] {
  const dir = path.join(rootDir, 'public/packs')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.siq'))
    .sort((left, right) => left.localeCompare(right, 'en'))
}

/** Стартовый список — каждый .siq, который реально лежит в public/packs, включая локальные. */
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
  plugins: [react(), localPackCatalog()],
  server: {
    host: true,
    port: 5173,
  },
}))
