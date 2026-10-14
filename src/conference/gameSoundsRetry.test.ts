import { describe, expect, it } from 'vitest'
import { gameSoundsRetryDelayMs, gameSoundsRestoredText } from './gameSoundsRetry.ts'
import { gameSoundsRetryDelaysMs } from '../options.ts'

describe('повтор «Звуки игры»', () => {
  it('паузы: 1 с, 2 с, 5 с, дальше каждые 10 с', () => {
    expect(gameSoundsRetryDelaysMs).toEqual([1000, 2000, 5000, 10_000])
    expect(gameSoundsRetryDelayMs(0)).toBe(1000)
    expect(gameSoundsRetryDelayMs(1)).toBe(2000)
    expect(gameSoundsRetryDelayMs(2)).toBe(5000)
    expect(gameSoundsRetryDelayMs(3)).toBe(10_000)
    expect(gameSoundsRetryDelayMs(99)).toBe(10_000)
  })

  it('текст восстановления короткий', () => {
    expect(gameSoundsRestoredText).toContain('восстановлен')
  })
})
