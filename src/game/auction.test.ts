import { describe, expect, it } from 'vitest'
import { auctionOptions, matchAuctionSpeech, nextAuctionBidder, optionLabel } from './auction.ts'
import type { AuctionOption } from './types.ts'

const labels = (options: AuctionOption[]) => options.map(optionLabel)

describe('auctionOptions', () => {
  it('примеры автора: номинал 40, текущая 80', () => {
    const at = (money: number) => labels(auctionOptions({ nominal: 40, money, current: 80, currentAllIn: false, opening: false }).options)
    expect(at(100)).toEqual(['Пас', 'Ва-банк 100'])
    expect(at(150)).toEqual(['Пас', '120', 'Ва-банк 150'])
    expect(at(200)).toEqual(['Пас', '120', '160', 'Ва-банк 200'])
  })
  it('открытие: ×1–4 до денег и ва-банк, без паса', () => {
    expect(labels(auctionOptions({ nominal: 100, money: 1000, current: null, currentAllIn: false, opening: true }).options))
      .toEqual(['100', '200', '300', '400', 'Ва-банк 1000'])
    expect(labels(auctionOptions({ nominal: 100, money: 250, current: null, currentAllIn: false, opening: true }).options))
      .toEqual(['100', '200', 'Ва-банк 250'])
    // Дубль суммы с ва-банком сворачивается.
    expect(labels(auctionOptions({ nominal: 100, money: 300, current: null, currentAllIn: false, opening: true }).options))
      .toEqual(['100', '200', 'Ва-банк 300'])
  })
  it('денег не больше номинала (и в минусе) — автоматически номинал', () => {
    expect(auctionOptions({ nominal: 100, money: 50, current: null, currentAllIn: false, opening: true })).toEqual({ auto: 100, options: [] })
    expect(auctionOptions({ nominal: 100, money: 100, current: null, currentAllIn: false, opening: true }).auto).toBe(100)
    expect(auctionOptions({ nominal: 100, money: -300, current: null, currentAllIn: false, opening: true }).auto).toBe(100)
  })
  it('после ва-банка — только пас или свой ва-банк больше', () => {
    expect(labels(auctionOptions({ nominal: 40, money: 1000, current: 100, currentAllIn: true, opening: false }).options)).toEqual(['Пас', 'Ва-банк 1000'])
    expect(labels(auctionOptions({ nominal: 40, money: 100, current: 100, currentAllIn: true, opening: false }).options)).toEqual(['Пас'])
  })
})

describe('matchAuctionSpeech', () => {
  const options = auctionOptions({ nominal: 40, money: 200, current: 80, currentAllIn: false, opening: false }).options
  const ctx = { options, nominal: 40, current: 80, money: 200 }
  it('пас, ва-банк, суммы', () => {
    expect(matchAuctionSpeech('пас', ctx)).toEqual({ kind: 'pass' })
    expect(matchAuctionSpeech('Нет, не буду', ctx)).toEqual({ kind: 'pass' })
    expect(matchAuctionSpeech('ва-банк!', ctx)).toEqual({ kind: 'allIn', amount: 200 })
    expect(matchAuctionSpeech('на все деньги', ctx)).toEqual({ kind: 'allIn', amount: 200 })
    expect(matchAuctionSpeech('сто двадцать', ctx)).toEqual({ kind: 'stake', amount: 120 })
    expect(matchAuctionSpeech('160', ctx)).toEqual({ kind: 'stake', amount: 160 })
    expect(matchAuctionSpeech('двести', ctx)).toEqual({ kind: 'allIn', amount: 200 })
    expect(matchAuctionSpeech('плюс сорок', ctx)).toEqual({ kind: 'stake', amount: 120 })
    expect(matchAuctionSpeech('удваиваю', ctx)).toEqual({ kind: 'stake', amount: 160 })
  })
  it('промежуточная сумма и мусор — null', () => {
    expect(matchAuctionSpeech('сто тридцать', ctx)).toBeNull()
    expect(matchAuctionSpeech('ну не знаю даже', ctx)).toBeNull()
    expect(matchAuctionSpeech('', ctx)).toBeNull()
  })
  it('минимум на открытии — номинал', () => {
    const open = auctionOptions({ nominal: 100, money: 1000, current: null, currentAllIn: false, opening: true }).options
    expect(matchAuctionSpeech('по номиналу', { options: open, nominal: 100, current: null, money: 1000 })).toEqual({ kind: 'stake', amount: 100 })
    expect(matchAuctionSpeech('удваиваю', { options: open, nominal: 100, current: null, money: 1000 })).toEqual({ kind: 'stake', amount: 200 })
  })
})

describe('nextAuctionBidder', () => {
  const scores: Record<number, number> = { 1: 500, 2: 50, 3: 1000 }
  it('бедный автопас, следующий богатый спрашивается', () => {
    const next = nextAuctionBidder({ order: [1, 2, 3], fromId: 1, leaderId: 1, passed: [], scoreOf: (id) => scores[id] ?? 0, nominal: 100, bid: 100, allIn: false })
    expect(next.bidderId).toBe(3)
    expect(next.autoPassed).toEqual([2])
  })
  it('никого — торги окончены; перекупленный выбравший снова ходит', () => {
    expect(nextAuctionBidder({ order: [1, 2, 3], fromId: 3, leaderId: 3, passed: [2], scoreOf: (id) => scores[id] ?? 0, nominal: 100, bid: 1000, allIn: true }).bidderId).toBeNull()
    expect(nextAuctionBidder({ order: [1, 2, 3], fromId: 3, leaderId: 3, passed: [2], scoreOf: (id) => scores[id] ?? 0, nominal: 100, bid: 300, allIn: false }).bidderId).toBe(1)
  })
})
