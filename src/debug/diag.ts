import { pushTrace } from './trace.ts'

/**
 * Компактная диагностика для дебаг-дампа: одна строка `note` с меткой области в квадратных скобках.
 * Области (см. docs/DEBUG.md): звук, ведущая-звук, обрыв, слух, чат, снимок, микрофон, окно.
 */
export type DiagArea = 'звук' | 'ведущая-звук' | 'обрыв' | 'слух' | 'чат' | 'снимок' | 'микрофон' | 'окно'

export function diag(area: DiagArea, title: string, detail?: unknown | (() => unknown)): void {
  // Диагностика никогда не роняет игру: деталь можно передать функцией, её ошибка глотается.
  let value: unknown
  try {
    value = typeof detail === 'function' ? (detail as () => unknown)() : detail
  } catch (error) {
    value = { diagError: String(error) }
  }
  pushTrace('note', `[${area}] ${title}`, value)
}

/** Снимок звукового окружения устройства: Android, AudioContext, сколько `<audio>` и что в них играет. */
export function audioEnvironment(ctx?: AudioContext | null): Record<string, unknown> {
  const doc = typeof document === 'undefined' ? null : document
  let elements: HTMLAudioElement[] = []
  try {
    elements = doc && typeof doc.querySelectorAll === 'function' ? [...doc.querySelectorAll('audio')] : []
  } catch {
    elements = []
  }
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const session = typeof navigator === 'undefined' ? undefined : (navigator as { audioSession?: { type?: string } }).audioSession
  return {
    android: /Android/i.test(ua),
    ios: /iPhone|iPad|iPod/i.test(ua),
    audioSession: session?.type ?? null,
    context: ctx ? { state: ctx.state, sampleRate: ctx.sampleRate, sinkId: (ctx as { sinkId?: unknown }).sinkId ?? null } : null,
    audioElements: elements.length,
    playing: elements.filter((el) => !el.paused && el.srcObject).length,
    muted: elements.filter((el) => el.muted).length,
  }
}

/**
 * Счётчик частых событий (снимки состояния): вместо строки на каждое событие —
 * одна сводка не чаще `everyMs`. Возвращает функцию «добавить замер».
 */
export function createDiagSummary(
  area: DiagArea,
  title: string,
  everyMs: number,
  now: () => number = () => Date.now(),
): (value: number, tag?: string) => void {
  let count = 0
  let sum = 0
  let max = 0
  let since = now()
  const tags: Record<string, number> = {}
  return (value, tag) => {
    count += 1
    sum += value
    max = Math.max(max, value)
    if (tag) tags[tag] = (tags[tag] ?? 0) + 1
    const at = now()
    if (at - since < everyMs) return
    diag(area, title, { count, avg: Math.round(sum / count), max: Math.round(max), ...(Object.keys(tags).length ? { tags: { ...tags } } : {}) })
    count = 0
    sum = 0
    max = 0
    since = at
    for (const key of Object.keys(tags)) delete tags[key]
  }
}
