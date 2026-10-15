/**
 * Что слышит модель: уровни ПОСЛЕ микшера мастера (после гейна фокуса / «Меньше слышать» / mute).
 * total — шина, которая уходит в модель; byParticipant — вклад каждого Jitsi-участника в эту шину.
 * Мастер пишет сюда из микшера и рассылает (`modelLevels`), игроки пишут полученное — индикатор
 * у всех рисуется из одного и того же.
 */
export type ModelLevels = { total: number; byParticipant: Record<string, number> }

const empty: ModelLevels = { total: 0, byParticipant: {} }
let current: ModelLevels = empty
const listeners = new Set<() => void>()

/** RMS (0..1) → уровень индикатора 0..1 с усилением для речи, округлён до 0.01. */
export function displayLevel(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0
  return Math.round(Math.min(1, rms * 4) * 100) / 100
}

export function getModelLevels(): ModelLevels {
  return current
}

export function setModelLevels(next: ModelLevels): void {
  current = next
  for (const listener of listeners) listener()
}

export function resetModelLevels(): void {
  setModelLevels(empty)
}

export function subscribeModelLevels(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Одинаковы ли уровни (чтобы не слать повтор тишины). */
export function sameModelLevels(a: ModelLevels, b: ModelLevels): boolean {
  if (a.total !== b.total) return false
  const keys = new Set([...Object.keys(a.byParticipant), ...Object.keys(b.byParticipant)])
  for (const key of keys) if ((a.byParticipant[key] ?? 0) !== (b.byParticipant[key] ?? 0)) return false
  return true
}

/** Проверка входящего сообщения: числа 0..1, не больше 32 участников. */
export function validModelLevels(value: unknown): value is ModelLevels {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const level = (item: unknown) => typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 1
  if (!level(record.total)) return false
  const by = record.byParticipant
  if (!by || typeof by !== 'object') return false
  const entries = Object.entries(by as Record<string, unknown>)
  return entries.length <= 32 && entries.every(([key, item]) => key.length <= 200 && level(item))
}
