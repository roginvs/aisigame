/**
 * Что ведущая (модель) сейчас воспринимает из речи игрока — только для показа.
 * idle — тишина; hearing — между speech_started и speech_stopped;
 * processing — фраза закончена, ждём текст/решение.
 * Игра это не читает. Застрять нельзя: каждое состояние гаснет по страховочному таймеру.
 */
export type HostEar = 'idle' | 'hearing' | 'processing'

/** Дольше любой реплики в игре (ответ 10 с + терпение semantic_vad low ~8 с). */
export const HOST_EAR_HEARING_MAX_MS = 25_000
/** Распознавание обычно < 1 с; дальше честнее показать обычное «думает». */
export const HOST_EAR_PROCESSING_MAX_MS = 6_000

let ear: HostEar = 'idle'
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function set(next: HostEar, maxMs: number | null): void {
  if (timer !== null) clearTimeout(timer)
  timer = maxMs === null ? null : setTimeout(() => {
    timer = null
    set('idle', null)
  }, maxMs)
  if (ear === next) return
  ear = next
  for (const listener of listeners) listener()
}

export function hostEarHearing(): void { set('hearing', HOST_EAR_HEARING_MAX_MS) }
/** speech_stopped без открытого hearing (старт был до смены ситуации) ничего не зажигает. */
export function hostEarProcessing(): void { if (ear === 'hearing') set('processing', HOST_EAR_PROCESSING_MAX_MS) }
export function clearHostEar(): void { set('idle', null) }
/** Микрофон закрыт посреди речи: новой речи не будет, услышанное ещё разбирается. */
export function hostEarMicClosed(): void { hostEarProcessing() }

export function getHostEar(): HostEar { return ear }
export function subscribeHostEar(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Переход, который сам вызван речью: не гасим. Всё прочее — новая ситуация, гасим. */
export function hostEarSurvives(path: string, from = ''): boolean {
  // Из уточнения речь сама возвращает в listening/picking.
  if (from.endsWith('clarifying')) return true
  return path === 'answering.hearing' || path === 'judging' || path.endsWith('.resolving') || path === 'finalBets.hearing'
}

export function readHostEar(value: unknown): HostEar | null {
  return value === 'idle' || value === 'hearing' || value === 'processing' ? value : null
}
