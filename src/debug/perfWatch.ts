import { pushTrace } from './trace.ts'

/**
 * Наблюдение за главным потоком страницы: длинные задачи (longtask) пишутся в trace,
 * суммарно за минуту — строкой-сводкой. Нужен, чтобы дамп дебага отвечал на вопрос
 * «что именно грузит главный поток у мастера»: рядом с каждой задачей в минуту
 * оказываются остальные события trace (фазы, снимки, звук).
 */

const LONG_TASK_MS = 64
/** Строки про каждую задачу глушим: чаще раза в 500 мс заметку не пишем. */
const NOTE_GAP_MS = 500
const MINUTE_MS = 60_000

type MinuteStats = { count: number; totalMs: number; maxMs: number }

let active = false
let minute: MinuteStats = { count: 0, totalMs: 0, maxMs: 0 }
let allTime = { count: 0, totalMs: 0, maxMs: 0 }
let lastNoteAt = 0
let minuteStartedAt = 0
let observer: PerformanceObserver | null = null

function summaryText(kind: string, stats: MinuteStats, label: string): string {
  const longest = `${stats.maxMs} мс`
  const avg = stats.count > 0 ? Math.round(stats.totalMs / stats.count) : 0
  return `${kind} ${label}: ${stats.count} шт, всего ${stats.totalMs} мс, в среднем ${avg} мс, самая длинная ${longest}`
}

export function startPerfWatch(): void {
  if (active) return
  if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return
  try {
    observer = new PerformanceObserver((list) => {
      if (!minuteStartedAt) minuteStartedAt = performance.now()
      for (const entry of list.getEntries()) {
        if (entry.duration < LONG_TASK_MS) continue
        const at = Date.now()
        minute.count += 1
        minute.totalMs += entry.duration
        minute.maxMs = Math.max(minute.maxMs, entry.duration)
        allTime.count += 1
        allTime.totalMs += entry.duration
        allTime.maxMs = Math.max(allTime.maxMs, entry.duration)
        if (at - lastNoteAt >= NOTE_GAP_MS) {
          lastNoteAt = at
          pushTrace('note', `долгая задача главного потока: ${Math.round(entry.duration)} мс`)
        }
      }
      // Сводка за минуту с начала наблюдения.
      if (performance.now() - minuteStartedAt >= MINUTE_MS) {
        if (minute.count > 0) pushTrace('note', summaryText('длинные задачи', minute, 'за минуту'))
        minute = { count: 0, totalMs: 0, maxMs: 0 }
        minuteStartedAt = performance.now()
      }
    })
    observer.observe({ type: 'longtask', buffered: true })
    active = true
  } catch {
    // longtask не поддержан браузером — наблюдения нет, всё работает как раньше.
  }
}

/** Строка для «Скопировать дебаг»: сколько вообще было длинных задач за сессию. */
export function perfWatchSummary(): string | null {
  if (!active) return null
  return summaryText('длинные задачи', allTime, 'за всю сессию страницы')
}
