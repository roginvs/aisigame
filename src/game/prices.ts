/** Запасные цены для кота и аукциона (план docs/CAT.md, «Запасная цена»). Чистые и детерминированные. */
import { defaultQuestionPrice, defaultRoundPrices } from '../options.ts'

/** Сырые цены пакета до фильтрации: раунд → темы → цены по позициям (0 — нет цены). */
export type PriceRound = { final: boolean; themes: number[][] }
export type PriceGrid = PriceRound[]

function usable(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

function roundPrices(round: PriceRound | undefined): number[] {
  return round ? round.themes.flat().filter(usable) : []
}

/** Медиана; при чётном числе — нижняя из двух средних (реальное значение пакета). */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0
}

/** Шаг 10 до 200, 50 до 1000, 100 дальше; половина вверх; не меньше шага. */
export function nicePrice(x: number): number {
  const step = x < 200 ? 10 : x < 1000 ? 50 : 100
  return Math.max(step, Math.floor(x / step + 0.5) * step)
}

/** Соседние обычные раунды по удалённости: r−1, r+1, r−2, r+2… */
function neighbours(grid: PriceGrid, roundIndex: number): number[] {
  const order: number[] = []
  for (let d = 1; d < grid.length; d += 1) {
    for (const r of [roundIndex - d, roundIndex + d]) if (r >= 0 && r < grid.length && !grid[r]?.final) order.push(r)
  }
  return order
}

export function roundPriceRange(grid: PriceGrid, roundIndex: number): { min: number; max: number; derived: boolean } {
  const own = roundPrices(grid[roundIndex])
  if (own.length) return { min: Math.min(...own), max: Math.max(...own), derived: false }
  for (const r of neighbours(grid, roundIndex)) {
    const prices = roundPrices(grid[r])
    if (prices.length) return { min: Math.min(...prices), max: Math.max(...prices), derived: true }
  }
  return { min: defaultRoundPrices.min, max: defaultRoundPrices.max, derived: true }
}

export function questionNominal(grid: PriceGrid, roundIndex: number, themeIndex: number, questionIndex: number): { value: number; derived: boolean } {
  const round = grid[roundIndex]
  const theme = round?.themes[themeIndex] ?? []
  const own = theme[questionIndex] ?? 0
  if (usable(own)) return { value: own, derived: false }
  // 1. та же позиция в других темах раунда
  const column = (round?.themes ?? []).filter((_, t) => t !== themeIndex).map((row) => row[questionIndex] ?? 0).filter(usable)
  if (column.length) return { value: median(column), derived: true }
  // 2. соседи в своей теме
  const before = theme.slice(0, questionIndex).filter(usable)
  const after = theme.slice(questionIndex + 1).filter(usable)
  const prev = before.at(-1)
  const next = after[0]
  if (prev !== undefined && next !== undefined) return { value: nicePrice((prev + next) / 2), derived: true }
  if (prev !== undefined && before.length >= 2) return { value: nicePrice(prev + (prev - (before.at(-2) ?? prev))), derived: true }
  if (next !== undefined && after.length >= 2) return { value: nicePrice(Math.max(1, next - ((after[1] ?? next) - next))), derived: true }
  if (prev !== undefined) return { value: prev, derived: true }
  if (next !== undefined) return { value: next, derived: true }
  // 3. все цены раунда
  const all = roundPrices(round)
  if (all.length) return { value: median(all), derived: true }
  // 4. та же позиция в соседних раундах, затем все цены первого соседа с ценами
  const near = neighbours(grid, roundIndex)
  for (const r of near) {
    const same = (grid[r]?.themes ?? []).map((row) => row[questionIndex] ?? 0).filter(usable)
    if (same.length) return { value: median(same), derived: true }
  }
  for (const r of near) {
    const prices = roundPrices(grid[r])
    if (prices.length) return { value: median(prices), derived: true }
  }
  // 5. все цены пакета
  const pack = grid.flatMap((r) => roundPrices(r))
  if (pack.length) return { value: median(pack), derived: true }
  return { value: defaultQuestionPrice, derived: true }
}
