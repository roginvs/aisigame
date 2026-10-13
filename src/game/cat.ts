/** Кот в мешке: варианты цены и разбор ставки голосом (docs/CAT.md). */
import { parseBet } from './bet.ts'
import type { CatPrice, PlayerId } from './types.ts'

/** Варианты ставки: одна цена — фиксированная, без выбора; две — минимум и максимум. */
export function catStakeOptions(price: CatPrice, round: { min: number; max: number }): number[] {
  if (price.kind === 'fixed') return [price.value]
  const [min, max] = price.kind === 'range' ? [price.min, price.max] : [round.min, round.max]
  return min === max ? [min] : [min, max]
}

const minWords = /минимум|минимальн|меньш|поменьше|минималк/
const maxWords = /максимум|максимальн|больш|побольше/

/** Голос → одна из сумм вариантов, иначе null. Промежуточные суммы не принимаются. */
export function matchCatStake(text: string, options: number[]): number | null {
  const clean = text.toLowerCase().replaceAll('ё', 'е')
  if (!clean.trim() || options.length === 0) return null
  const low = Math.min(...options)
  const high = Math.max(...options)
  const saysMin = minWords.test(clean)
  const saysMax = maxWords.test(clean)
  if (saysMin !== saysMax) return saysMin ? low : high
  const amount = parseBet(clean, Number.MAX_SAFE_INTEGER)
  return amount !== null && options.includes(amount) ? amount : null
}

/** Кому достаётся кот без выбора: 1 игрок — сам, 2 — второй; иначе null (нужен выбор). */
export function autoCatRecipient(players: Array<{ id: PlayerId }>, giverId: PlayerId): PlayerId | null {
  if (players.length === 1) return players[0]!.id
  if (players.length === 2) return players.find((player) => player.id !== giverId)?.id ?? null
  return null
}

/** Следующий по кругу после `afterId`, кроме исключённых. */
export function nextInCircle(players: Array<{ id: PlayerId }>, afterId: PlayerId, skip: PlayerId[] = []): PlayerId | null {
  const start = players.findIndex((player) => player.id === afterId)
  for (let offset = 1; offset <= players.length; offset += 1) {
    const player = players[(start + offset) % players.length]
    if (player && !skip.includes(player.id) && player.id !== afterId) return player.id
  }
  return null
}
