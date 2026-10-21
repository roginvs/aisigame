import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
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

const relayHostSuffix = '.maas.aliyuncs.com'

/**
 * DashScope не отдаёт браузеру CORS-заголовки (21 октября 2026 проверено на проде),
 * поэтому dev-сервер пересылает SDP-обмен за него: POST /qwen-relay с адресом цели
 * в заголовке X-Qwen-Target. Клиент передаёт свой ключ в Authorization; сервер здесь
 * его не хранит. Такой же пересылкой занимается продовый Worker (relay/worker.js).
 */
function qwenRelay(): Plugin {
  return {
    name: 'qwen-relay',
    configureServer(server) {
      server.middlewares.use('/qwen-relay', (req, res) => {
        void forwardQwenSdp(req, res)
      })
    },
  }
}

async function forwardQwenSdp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const fail = (status: number, message: string) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end(message)
  }
  if (req.method !== 'POST') {
    fail(405, 'Релей понимает только POST')
    return
  }
  const rawTarget = req.headers['x-qwen-target']
  const targetHeader = Array.isArray(rawTarget) ? rawTarget[0] : rawTarget
  let target: URL
  try {
    target = new URL(targetHeader ?? '')
  } catch {
    fail(400, 'В запросе нет адреса X-Qwen-Target')
    return
  }
  if (target.protocol !== 'https:' || !target.hostname.endsWith(relayHostSuffix)) {
    fail(400, `Релей пересылает только на https://*${relayHostSuffix}`)
    return
  }
  const body = await new Promise<Buffer | null>((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', () => resolve(null))
  })
  if (!body) {
    fail(400, 'Не прочитали тело запроса')
    return
  }
  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: { Authorization: req.headers.authorization ?? '', 'Content-Type': 'application/sdp' },
      body: new Uint8Array(body),
    })
    res.statusCode = upstream.status
    res.setHeader('Content-Type', upstream.headers.get('Content-Type') ?? 'text/plain; charset=utf-8')
    res.end(Buffer.from(await upstream.arrayBuffer()))
  } catch {
    fail(502, 'DashScope не ответил')
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
  plugins: [react(), localPackCatalog(), qwenRelay()],
  server: {
    host: true,
    port: 5173,
  },
}))
