export const PRESENCE_HEARTBEAT_MS = 3000
export const PRESENCE_STALE_MS = 10_000
export const PRESENCE_HIDE_MS = 60_000

export type PresenceEntry = {
  clientId: string
  name: string
  lastSeen: number
  score: number
  playerId: number
}

export type PresenceView = PresenceEntry & {
  stale: boolean
  hidden: boolean
}

type RememberedPlayer = {
  playerId: number
  score: number
  name: string
}

const remembered = new Map<string, RememberedPlayer>()

export function rememberPlayer(input: {
  clientId: string
  playerId: number
  score: number
  name: string
}): void {
  remembered.set(input.clientId, {
    playerId: input.playerId,
    score: input.score,
    name: input.name,
  })
}

export function lookupRememberedPlayer(clientId: string): RememberedPlayer | null {
  return remembered.get(clientId) ?? null
}

const lastSeenByClient = new Map<string, number>()

export function touch(clientId: string, now: number): void {
  lastSeenByClient.set(clientId, now)
}

export function readLastSeen(clientId: string): number | undefined {
  return lastSeenByClient.get(clientId)
}

export function applyPresence(entries: PresenceEntry[], now: number): PresenceView[] {
  return entries.map((entry) => {
    const age = now - entry.lastSeen
    const hidden = age >= PRESENCE_HIDE_MS
    const stale = !hidden && age >= PRESENCE_STALE_MS
    return { ...entry, stale, hidden }
  })
}

/** Возвращает игрока с тем же clientId: id и счёт из памяти, hidden сбрасывается через lastSeen. */
export function mergeReturningPlayer(
  clientId: string,
  name: string,
  now: number,
): { playerId: number; score: number; name: string; lastSeen: number } | null {
  const prev = remembered.get(clientId)
  if (!prev) return null
  return {
    playerId: prev.playerId,
    score: prev.score,
    name: name.trim() || prev.name,
    lastSeen: now,
  }
}

/** Участник ушёл: место и отметка жизни не копятся до конца сессии. */
export function forgetPlayer(clientId: string): void {
  remembered.delete(clientId)
  lastSeenByClient.delete(clientId)
}

export function clearRememberedPlayersForTests(): void {
  remembered.clear()
  lastSeenByClient.clear()
}

/** Мастер замеряет RTT до каждого клиента примерно раз в 3 с. */
export const PING_INTERVAL_MS = 3_000
