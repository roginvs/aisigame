import { describe, expect, it } from 'vitest'
import { meterLevel } from './meterDraw.ts'

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
