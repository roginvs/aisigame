import { describe, expect, it } from 'vitest'
import { countLevelSamples, levelUiSampleMs } from '../options.ts'
import { HEIGHT, INPUT_BAND_H, INPUT_CLOSED_COLOR, INPUT_OPEN_COLOR, inputBandColor, meterFramePlan, meterLevel, modelInputOpen } from './meterDraw.ts'

describe('уровни UI в ожидании', () => {
  it('кадры 60 Гц дают около 10 замеров в секунду, не по кадру', () => {
    const frames = Array.from({ length: 60 }, (_, index) => index * (1000 / 60))
    const samples = countLevelSamples(frames)
    expect(levelUiSampleMs).toBe(100)
    expect(samples).toBeGreaterThanOrEqual(9)
    expect(samples).toBeLessThanOrEqual(11)
    expect(samples).toBeLessThan(20)
  })
})

describe('кадр индикатора модели', () => {
  it('скрытая вкладка не рисует, видимая сдвигает слепок', () => {
    expect(meterFramePlan(true, true)).toBe('skip')
    expect(meterFramePlan(true, false)).toBe('skip')
    expect(meterFramePlan(false, false)).toBe('full')
    expect(meterFramePlan(false, true)).toBe('shift')
  })
})

describe('meterLevel', () => {
  it('тишина — 0, громкий сигнал — до 1', () => {
    expect(meterLevel(new Uint8Array(64).fill(128))).toBe(0)
    expect(meterLevel(new Uint8Array(0))).toBe(0)
    const loud = Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 255 : 0))
    expect(meterLevel(loud)).toBe(1)
    const quiet = Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 136 : 120))
    expect(meterLevel(quiet)).toBeGreaterThan(0)
    expect(meterLevel(quiet)).toBeLessThan(0.5)
  })
})

describe('постоянный след «что слышит модель» (дамп 16-16-30, решение автора)', () => {
  it('светлая полоса при живом входе, серая при закрытом, у нижнего края', () => {
    expect(inputBandColor(true)).toBe(INPUT_OPEN_COLOR)
    expect(inputBandColor(false)).toBe(INPUT_CLOSED_COLOR)
    expect(INPUT_BAND_H).toBeGreaterThan(0)
    expect(HEIGHT - INPUT_BAND_H).toBeGreaterThan(0)
    // След рисуется из состояния входа, не из trace: mic 'live' — единственный открытый.
    expect(modelInputOpen('live')).toBe(true)
    for (const mic of ['muted', 'idle', 'dead']) expect(modelInputOpen(mic)).toBe(false)
  })
})
