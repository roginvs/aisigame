/**
 * Уровень речи каждого участника (0..1) для полосок на плитках: есть у каждого клиента,
 * у мастера и у игроков одинаково. Свой уровень берётся из локального графа микрофона
 * (компрессор/монитор своей дорожки), чужие — из уровней Jitsi. От фаз партии и «кого
 * слышит модель» не зависит: показывает всех, кто звучит в комнате прямо сейчас.
 * «Что от участника слышит модель» (после микшера с фокусами) — только в шапке мастера
 * через анализатор выхода микшера.
 */
export type TileLevels = { byParticipant: Record<string, number> }

const empty: TileLevels = { byParticipant: {} }

/** Сколько держится последний уровень участника, если его источник перестал слать кадры. */
const HOLD_MS = 600

type Entry = { level: number; at: number }
const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
let current: TileLevels = empty

function notify(): void {
  for (const listener of listeners) listener()
}

function sameLevels(a: TileLevels, b: TileLevels): boolean {
  const keysA = Object.keys(a.byParticipant)
  const keysB = Object.keys(b.byParticipant)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (a.byParticipant[key] !== b.byParticipant[key]) return false
  }
  return true
}

function snapshot(now: number): TileLevels {
  const byParticipant: Record<string, number> = {}
  for (const [id, entry] of entries) {
    if (now - entry.at > HOLD_MS || entry.level <= 0) continue
    byParticipant[id] = entry.level
  }
  return { byParticipant }
}

const clamp = (level: number): number => {
  if (!Number.isFinite(level)) return 0
  return Math.round(Math.min(1, Math.max(0, level)) * 100) / 100
}

/**
 * Кадр уровня участника: свой — RMS локального графа (0..1), чужой — уровень Jitsi
 * (после штатного усиления ×2.5). Пишет поле целиком; уведомляет слушателей, только
 * если видимый снимок изменился.
 */
export function noteTileLevel(participantId: string, level: number): void {
  if (!participantId) return
  const now = Date.now()
  entries.set(participantId, { level: clamp(level), at: now })
  const next = snapshot(now)
  if (!sameLevels(current, next)) {
    current = next
    notify()
  }
}

export function getTileLevels(): TileLevels {
  const now = Date.now()
  const next = snapshot(now)
  if (!sameLevels(current, next)) current = next
  return current
}

export function subscribeTileLevels(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function resetTileLevels(): void {
  entries.clear()
  current = empty
  notify()
}
