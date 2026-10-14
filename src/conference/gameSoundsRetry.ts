import { gameSoundsRetryDelaysMs } from '../options.ts'

/** Следующая пауза перед попыткой: 1 с, 2 с, 5 с, дальше каждые 10 с. */
export function gameSoundsRetryDelayMs(attempt: number): number {
  const last = gameSoundsRetryDelaysMs[gameSoundsRetryDelaysMs.length - 1]!
  return gameSoundsRetryDelaysMs[Math.min(attempt, gameSoundsRetryDelaysMs.length - 1)] ?? last
}

export const gameSoundsRestoredText = 'Звук игры восстановлен.'
