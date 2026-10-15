/**
 * Что ведущая (модель) сейчас воспринимает из речи игрока — только для показа.
 * idle — тишина; hearing — между speech_started и speech_stopped;
 * processing — фраза закончена, ждём текст/решение.
 * Игра это не читает. Таймеров нет: гасят только события игры и сессии
 * (смена состояния, разбор фразы без перехода, речь ведущей, закрытый мик, обрыв).
 */
/** listening — только для показа: мик открыт и ход ждёт речь, но речи ещё нет (в снимке конференции). */
export type HostEar = 'idle' | 'listening' | 'hearing' | 'processing'

let ear: HostEar = 'idle'
/** Растёт на каждой смене: отложенный разбор гасит только «свою» фразу. */
let generation = 0
const listeners = new Set<() => void>()

function set(next: HostEar): void {
  generation += 1
  if (ear === next) return
  ear = next
  for (const listener of listeners) listener()
}

export function hostEarHearing(): void { set('hearing') }
/** speech_stopped без открытого hearing (старт был до смены ситуации) ничего не зажигает. */
export function hostEarProcessing(): number | null {
  if (ear !== 'hearing') return null
  set('processing')
  return generation
}
export function clearHostEar(): void { if (ear !== 'idle') set('idle') }
/** Разбор фразы закончился, а состояние не сменилось: гасим, если с тех пор ничего нового. */
export function settleHostEar(token: number | null): void {
  if (token !== null && token === generation && ear === 'processing') set('idle')
}
/** Микрофон закрыт посреди речи без смены состояния: конца фразы можно не дождаться — гасим. */
export function hostEarMicClosed(): void { if (ear === 'hearing') set('idle') }
/** Ведущая заговорила — значит, уже ответила на фразу. */
export function hostEarHostSpoke(): void { if (ear === 'processing') set('idle') }

export function getHostEar(): HostEar { return ear }
export function subscribeHostEar(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Ухо показываем только в партии: в лобби/подключении/финале нет хода, который его погасит. */
export function hostEarShown(path: string): boolean {
  return !['startMenu', 'lobby', 'connecting', 'restoring', 'finished', 'failed', 'stopped', 'paused'].includes(path)
}

/** Переход, который сам вызван речью: не гасим. Всё прочее — новая ситуация, гасим. */
export function hostEarSurvives(path: string, from = ''): boolean {
  // Из уточнения речь сама возвращает в listening/picking.
  if (from.endsWith('clarifying')) return true
  return path === 'answering.hearing' || path === 'answering.settling' || path === 'judging' || path.endsWith('.resolving') || path === 'finalBets.hearing'
}

export function readHostEar(value: unknown): HostEar | null {
  return value === 'idle' || value === 'listening' || value === 'hearing' || value === 'processing' ? value : null
}
