export type InviteParams = {
  origin: string
  /** Vite BASE_URL: `/aisigame/` или `/` */
  base: string
  roomId: string
  jitsiBase: string
  /** Явный локальный transport для Playwright/dev; не зависит от voice model. */
  transport?: 'broadcast'
}

function normalizeOrigin(origin: string): string {
  const normalized = origin.replace(/\/+$/, '')
  if (normalized === 'http://127.0.0.1:5173') return 'https://dev.fallout-nevada.ru'
  return normalized
}

function normalizeBase(base: string): string {
  if (!base || base === '/') return '/'
  const trimmed = base.replace(/^\/+|\/+$/g, '')
  return trimmed ? `/${trimmed}/` : '/'
}

export function buildInviteUrl(params: InviteParams): string {
  const origin = normalizeOrigin(params.origin)
  const base = normalizeBase(params.base)
  const path = base === '/' ? '/' : base
  const url = new URL(path, `${origin}/`)
  url.searchParams.set('join', params.roomId)
  url.searchParams.set('jitsi', params.jitsiBase)
  if (params.transport === 'broadcast') url.searchParams.set('transport', 'broadcast')
  return url.href
}

export type ParsedInvite = {
  roomId: string
  jitsiBase: string
  transport: 'jitsi' | 'broadcast'
}

export function parseInvite(search: string): ParsedInvite | null {
  const query = search.startsWith('?') ? search.slice(1) : search
  const params = new URLSearchParams(query)
  const roomId = params.get('join')?.trim() ?? ''
  const jitsiBase = params.get('jitsi')?.trim() ?? ''
  if (!roomId || !jitsiBase) return null
  return { roomId, jitsiBase, transport: params.get('transport') === 'broadcast' ? 'broadcast' : 'jitsi' }
}
