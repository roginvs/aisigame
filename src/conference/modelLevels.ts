/**
 * Что слышит модель: уровни ПОСЛЕ микшера мастера (после гейна фокуса / «Меньше слышать» / mute).
 * total — шина, которая уходит в модель; byParticipant — вклад каждого Jitsi-участника в эту шину.
 * Только у мастера: игрокам не рассылается, у них индикатора нет.
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

