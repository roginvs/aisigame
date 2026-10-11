const clientIdKey = 'aisigame.clientId'
const conferenceNameKey = 'aisigame.conferenceName'
const jitsiUrlKey = 'aisigame.jitsiUrl'
const matchModeKey = 'aisigame.matchMode'

export const defaultJitsiBase = 'https://fallout-nevada.ru/jitsi'

export type MatchMode = 'table' | 'conference'

export function readClientId(storage: Storage = localStorage): string {
  const existing = storage.getItem(clientIdKey)?.trim()
  if (existing) return existing
  const id = crypto.randomUUID()
  storage.setItem(clientIdKey, id)
  return id
}

/** Отдельный id вкладки игрока: не совпадает с мастером в том же браузере. */
const joinClientIdKey = 'aisigame.joinClientId'
const joinAuthTokenKey = 'aisigame.joinAuthToken'
const masterAuthorityTokenKey = 'aisigame.masterAuthorityToken'
const masterRoomIdKey = 'aisigame.masterRoomId'

export function readJoinClientId(session: Storage = sessionStorage): string {
  const existing = session.getItem(joinClientIdKey)?.trim()
  if (existing) return existing
  const id = crypto.randomUUID()
  session.setItem(joinClientIdKey, id)
  return id
}

/** Секрет вкладки позволяет безопасно перепривязать clientId после реконнекта Jitsi. */
export function readJoinAuthToken(session: Storage = sessionStorage): string {
  const existing = session.getItem(joinAuthTokenKey)?.trim()
  if (existing) return existing
  const token = crypto.randomUUID()
  session.setItem(joinAuthTokenKey, token)
  return token
}

/** Устойчивая идентичность мастера переживает перезагрузку и переподключение к комнате. */
export function readMasterAuthorityToken(storage: Storage = localStorage): string {
  const existing = storage.getItem(masterAuthorityTokenKey)?.trim()
  if (existing) return existing
  const token = crypto.randomUUID()
  storage.setItem(masterAuthorityTokenKey, token)
  return token
}

/** Комната мастера привязана к вкладке: соседняя вкладка по приглашению остаётся игроком. */
export function readMasterRoomId(session: Storage = sessionStorage): string {
  return session.getItem(masterRoomIdKey)?.trim() ?? ''
}

export function writeMasterRoomId(roomId: string, session: Storage = sessionStorage): void {
  const clean = roomId.trim()
  if (clean) session.setItem(masterRoomIdKey, clean)
  else session.removeItem(masterRoomIdKey)
}

export function readConferenceName(storage: Storage = localStorage): string {
  return storage.getItem(conferenceNameKey)?.trim() ?? ''
}

export function writeConferenceName(name: string, storage: Storage = localStorage): void {
  const clean = name.trim()
  if (clean) storage.setItem(conferenceNameKey, clean)
  else storage.removeItem(conferenceNameKey)
}

export function readJitsiUrl(storage: Storage = localStorage): string {
  return storage.getItem(jitsiUrlKey)?.trim() || defaultJitsiBase
}

export function writeJitsiUrl(url: string, storage: Storage = localStorage): void {
  const clean = url.trim().replace(/\/+$/, '') || defaultJitsiBase
  storage.setItem(jitsiUrlKey, clean)
}

export function readStartMatchMode(storage: Storage = localStorage): MatchMode {
  const value = storage.getItem(matchModeKey)
  return value === 'conference' ? 'conference' : 'table'
}

export function writeStartMatchMode(mode: MatchMode, storage: Storage = localStorage): void {
  storage.setItem(matchModeKey, mode)
}
