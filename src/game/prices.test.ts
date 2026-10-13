import { describe, expect, it } from 'vitest'
import { median, nicePrice, questionNominal, roundPriceRange, type PriceGrid } from './prices.ts'

const round = (...themes: number[][]) => ({ final: false, themes })

describe('roundPriceRange', () => {
  it('берёт мин/макс раунда; одна цена — min == max без запасного алгоритма', () => {
    expect(roundPriceRange([round([100, 200, 300, 400, 500])], 0)).toEqual({ min: 100, max: 500, derived: false })
    expect(roundPriceRange([round([200], [200])], 0)).toEqual({ min: 200, max: 200, derived: false })
  })
  it('раунд без цен: сначала предыдущий, потом следующий; пакет без цен — 100/500', () => {
    const grid: PriceGrid = [round([100, 500]), round([0, 0]), round([200, 1000])]
    expect(roundPriceRange(grid, 1)).toEqual({ min: 100, max: 500, derived: true })
    expect(roundPriceRange([round([0]), round([200, 1000])], 0)).toEqual({ min: 200, max: 1000, derived: true })
    expect(roundPriceRange([round([0])], 0)).toEqual({ min: 100, max: 500, derived: true })
  })
  it('финальный раунд не служит соседом', () => {
    expect(roundPriceRange([round([0]), { final: true, themes: [[900]] }], 0)).toEqual({ min: 100, max: 500, derived: true })
  })
})

describe('questionNominal', () => {
  it('свой номинал остаётся', () => {
    expect(questionNominal([round([100, 200])], 0, 0, 1)).toEqual({ value: 200, derived: false })
  })
  it('та же позиция в других темах — медиана', () => {
    expect(questionNominal([round([100, 200, 0], [100, 200, 300], [100, 200, 300], [100, 200, 400])], 0, 0, 2).value).toBe(300)
  })
  it('соседи в теме: среднее; последняя позиция — экстраполяция по шагу', () => {
    expect(questionNominal([round([100, 200, 0, 400])], 0, 0, 2).value).toBe(300)
    expect(questionNominal([round([200, 400, 0])], 0, 0, 2).value).toBe(600)
  })
  it('одиночный вопрос в теме — медиана раунда; пакет без цен — 100', () => {
    expect(questionNominal([round([0], [0, 100, 300, 500, 700])], 0, 0, 0).value).toBe(300)
    expect(questionNominal([round([0])], 0, 0, 0)).toEqual({ value: 100, derived: true })
  })
  it('соседний раунд: та же позиция', () => {
    expect(questionNominal([round([300, 600]), round([0])], 1, 0, 0).value).toBe(300)
  })
  it('детерминизм', () => {
    const grid: PriceGrid = [round([100, 0, 300], [100, 250, 0])]
    expect(questionNominal(grid, 0, 0, 1)).toEqual(questionNominal(grid, 0, 0, 1))
  })
})

describe('median и nicePrice', () => {
  it('нижняя из двух средних', () => {
    expect(median([100, 200, 300, 400])).toBe(200)
    expect(median([300])).toBe(300)
  })
  it('округление шагами 10/50/100', () => {
    expect(nicePrice(137)).toBe(140)
    expect(nicePrice(275)).toBe(300)
    expect(nicePrice(1234)).toBe(1200)
    expect(nicePrice(3)).toBe(10)
  })
})
