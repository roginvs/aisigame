import { pushSystemLine, pushTrace } from './trace.ts'

/**
 * Проверки «подозрительно»: дежурные инварианты ситуации в контроллере. Логику игры не меняют:
 * только строка в лог (легко ищется по слову «подозрительно», формат «подозрительно · уровень: …»)
 * и короткая техническая строка в чат у мастера (роль system, модель её не получает).
 */
export type SuspicionLevel = 'слегка' | 'сильно'

/** Повторы одной и той же заметки не раньше cooldown (мс), чтобы чат не заливало. */
const cooldowns = new Map<string, number>()

/** Счётчик неудачных попыток одного игрока на вопросе подряд (детектор повторов). */
const failures = { key: '', player: -1 as number | null, count: 0 }

/**
 * Неудачная попытка ответа: две подряд у одного игрока на вопросе — «слегка»,
 * три и больше — «сильно». Смена вопроса или игрока пересчитывает заново
 * (дамп 17.10: «Зубы», три «Ш-ш-ш» подряд у одного игрока).
 */
export function failedAttempts(questionId: string, playerId: number | null, why: string, detail: Record<string, unknown> = {}): void {
  if (questionId !== failures.key || playerId !== failures.player) {
    failures.key = questionId
    failures.player = playerId
    failures.count = 0
  }
  failures.count += 1
  const source = { questionId, playerId, ...detail }
  if (failures.count === 2) {
    suspicious('слегка', `две неудачные попытки ответа подряд: ${why}`, source)
    return
  }
  if (failures.count >= 3) {
    suspicious('сильно', `неудачных попыток ответа подряд: ${failures.count} (${why})`, source)
  }
}

/** Верная попытка обнуляет счёт неудачных. */
export function resetFailedAttempts(): void {
  failures.key = ''
  failures.player = null
  failures.count = 0
}

/** Новая партия не наследует заметки и счётчик неудач прошлой. */
export function resetSuspiciousState(): void {
  cooldowns.clear()
  resetFailedAttempts()
}

export function suspicious(level: SuspicionLevel, text: string, detail?: Record<string, unknown>): void {
  const clean = text.trim()
  if (!clean) return
  pushTrace('note', `подозрительно · ${level}: ${clean}`, detail)
  pushSystemLine(`подозрительно (${level}): ${clean}`)
}

/** true — заметка прозвучала, false — тот же ключ недавно уже был. */
export function suspiciousOnce(
  level: SuspicionLevel,
  key: string,
  cooldownMs: number,
  text: string,
  detail?: Record<string, unknown>,
): boolean {
  const now = Date.now()
  if (cooldowns.get(key) !== undefined && now - cooldowns.get(key)! < cooldownMs) return false
  cooldowns.set(key, now)
  if (cooldowns.size > 100) {
    for (const entryKey of cooldowns.keys()) {
      if (cooldowns.size <= 100) break
      cooldowns.delete(entryKey)
    }
  }
  suspicious(level, text, detail)
  return true
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

export type LeakTarget = {
  questionId: string
  answers: readonly string[]
  /** Ячейка закрыта (сыграна): эталон в свободной реплике уже не утечка. */
  closed: boolean
}

let leakTarget: (() => LeakTarget | null) | null = null

/** Контроллер регистрирует источник текущего вопроса (эталоны + открыта ячейка или нет). */
export function setLeakTarget(source: (() => LeakTarget | null) | null): void {
  leakTarget = source
}

/**
 * Утечка: эталон активного вопроса прозвучал в свободной реплике ведущей, пока ячейку можно
 * перехватить (не сыграна). В реплики чтения/объявлений попадает честно по правилам, поэтому
 * проверка только по тексту строки, а фазы отсекает контроллер в источнике (типа вопроса).
 */
export function checkHostUtterance(text: string): void {
  const target = leakTarget?.()
  if (!target || target.closed || target.answers.length === 0) return
  const said = normalizeText(text)
  if (!said) return
  for (const answer of target.answers) {
    const clean = answer.trim()
    // Короткие эталоны («да», «нет», числа) дают слишком много ложных совпадений — не проверяем.
    if ([...clean].length < 4) continue
    const whole = normalizeText(clean)
    const words = whole.split(' ').filter((word) => [...word].length >= 6)
    if (whole && said.includes(whole)) {
      suspiciousOnce('сильно', `leak:${target.questionId}:${whole}`, 20_000, 'эталон открытого вопроса прозвучал в свободной реплике ведущей', { questionId: target.questionId, answer: clean })
      return
    }
    for (const word of words) {
      if (!said.includes(word)) continue
      suspiciousOnce('сильно', `leak:${target.questionId}:${word}`, 20_000, 'слово эталона открытого вопроса прозвучало в свободной реплике ведущей', { questionId: target.questionId, answer: clean, word })
      return
    }
  }
}
