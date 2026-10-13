/** Аукцион: варианты ставки и разбор голоса (docs/AUCTION.md). Без React и XState. */
import { auctionOpenMultipliers, auctionRaiseSteps } from '../options.ts'
import { parseBet } from './bet.ts'
import type { AuctionOption, PlayerId } from './types.ts'

export function auctionOptions(input: {
  nominal: number
  money: number
  current: number | null
  currentAllIn: boolean
  opening: boolean
}): { auto?: number; options: AuctionOption[] } {
  const { nominal, money, current, currentAllIn, opening } = input
  if (opening) {
    if (money <= nominal) return { auto: nominal, options: [] }
    const amounts = auctionOpenMultipliers.map((k) => nominal * k).filter((amount) => amount < money)
    return { options: [...amounts.map((amount) => ({ kind: 'stake' as const, amount })), { kind: 'allIn', amount: money }] }
  }
  const bid = current ?? nominal
  if (money <= bid) return { options: [{ kind: 'pass' }] }
  if (currentAllIn) return { options: [{ kind: 'pass' }, { kind: 'allIn', amount: money }] }
  const amounts = auctionRaiseSteps.map((k) => bid + nominal * k).filter((amount) => amount < money)
  return { options: [{ kind: 'pass' }, ...amounts.map((amount) => ({ kind: 'stake' as const, amount })), { kind: 'allIn', amount: money }] }
}

export function optionAmount(option: AuctionOption): number | null {
  return option.kind === 'pass' ? null : option.amount
}

export function optionLabel(option: AuctionOption): string {
  if (option.kind === 'pass') return 'Пас'
  if (option.kind === 'allIn') return `Ва-банк ${option.amount}`
  return String(option.amount)
}

export function sameOption(a: AuctionOption, b: AuctionOption): boolean {
  return a.kind === b.kind && optionAmount(a) === optionAmount(b)
}

const passWords = /(^|\s)(пас|пасую|нет|не буду|не участвую|пропускаю|пропуск|мимо|не перекупаю|не перекуплю|без меня|не хочу)(\s|$)/
const allInWords = /ва[-\s]?банк|ол-?ин|all-?in|(^|\s)(на )?все( деньги)?(\s|$)|(^|\s)всё(\s|$)/
const minWords = /номинал|минимум|минимальн|по минимуму/
const multipliers: Array<[RegExp, number]> = [
  [/удва|вдвое|в два раза|x ?2|× ?2/, 2],
  [/утра|втрое|в три раза|x ?3|× ?3/, 3],
  [/вчетверо|в четыре раза|x ?4|× ?4/, 4],
]

function normalize(text: string): string {
  return text.toLowerCase().replaceAll('ё', 'е').replace(/[.,!?;:«»"]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Голос → ровно один из вариантов, иначе null. */
export function matchAuctionSpeech(text: string, ctx: { options: AuctionOption[]; nominal: number; current: number | null; money: number }): AuctionOption | null {
  const clean = normalize(text)
  if (!clean) return null
  const found: AuctionOption[] = []
  const add = (option: AuctionOption | undefined) => { if (option && !found.some((item) => sameOption(item, option))) found.push(option) }
  const byAmount = (amount: number) => ctx.options.find((option) => option.kind !== 'pass' && option.amount === amount)
  if (allInWords.test(clean)) add(ctx.options.find((option) => option.kind === 'allIn'))
  else if (passWords.test(clean)) add(ctx.options.find((option) => option.kind === 'pass'))
  else if (minWords.test(clean)) {
    const stakes = ctx.options.filter((option) => option.kind !== 'pass')
    add(stakes.sort((a, b) => (optionAmount(a) ?? 0) - (optionAmount(b) ?? 0))[0])
  } else {
    const multiplier = multipliers.find(([pattern]) => pattern.test(clean))
    const plus = /(^|\s)(плюс|\+|еще|поднимаю на|подниму на|добавляю)\s?/.exec(clean)
    if (multiplier) add(byAmount((ctx.current ?? ctx.nominal) * multiplier[1]))
    else if (plus) {
      const amount = parseBet(clean.slice(plus.index + plus[0].length), Number.MAX_SAFE_INTEGER)
      if (amount !== null) add(byAmount((ctx.current ?? 0) + amount))
    } else {
      const amount = parseBet(clean, Number.MAX_SAFE_INTEGER)
      if (amount !== null) add(byAmount(amount))
    }
  }
  return found.length === 1 ? found[0]! : null
}

/** Следующий участник торгов после `fromId` по кругу; кто не может перебить — автопас. */
export function nextAuctionBidder(input: {
  order: PlayerId[]
  fromId: PlayerId
  leaderId: PlayerId | null
  passed: PlayerId[]
  scoreOf: (id: PlayerId) => number
  nominal: number
  bid: number | null
  allIn: boolean
}): { bidderId: PlayerId | null; options: AuctionOption[]; autoPassed: PlayerId[] } {
  const { order } = input
  const start = order.indexOf(input.fromId)
  const autoPassed: PlayerId[] = []
  for (let offset = 1; offset <= order.length; offset += 1) {
    const id = order[(start + offset) % order.length]!
    if (id === input.leaderId || input.passed.includes(id) || autoPassed.includes(id)) continue
    const { options } = auctionOptions({ nominal: input.nominal, money: input.scoreOf(id), current: input.bid, currentAllIn: input.allIn, opening: false })
    if (options.every((option) => option.kind === 'pass')) { autoPassed.push(id); continue }
    return { bidderId: id, options, autoPassed }
  }
  return { bidderId: null, options: [], autoPassed }
}
