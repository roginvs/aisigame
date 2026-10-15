import { describe, expect, it } from 'vitest'
import { fitFontSize } from './questionFit.ts'

describe('fitFontSize', () => {
  it('влезает как есть — размер CSS не трогаем', () => {
    expect(fitFontSize(38, 18, () => true)).toEqual({ size: 38, fits: true })
  })
  it('находит наибольший влезающий размер', () => {
    const r = fitFontSize(38, 18, (size) => size <= 25.3)
    expect(r.fits).toBe(true)
    expect(r.size).toBeLessThanOrEqual(25.3)
    expect(r.size).toBeGreaterThan(25)
  })
  it('не влезает даже минимальный — минимум и прокрутка', () => {
    expect(fitFontSize(38, 18, () => false)).toEqual({ size: 18, fits: false })
  })
})
