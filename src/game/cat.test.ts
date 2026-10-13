import { describe, expect, it } from 'vitest'
import { autoCatRecipient, catStakeOptions, matchCatStake, nextInCircle } from './cat.ts'
import { matchSpokenPlayer, nameHints } from './nameMatch.ts'
import { parseCatPrice } from './siq.ts'

describe('цена кота', () => {
  it('по SIGame: число — фиксированная, 0/пусто/мусор — мин/макс раунда, диапазон', () => {
    expect(parseCatPrice('300')).toEqual({ kind: 'fixed', value: 300 })
    expect(parseCatPrice('0')).toEqual({ kind: 'roundMinMax' })
    expect(parseCatPrice('')).toEqual({ kind: 'roundMinMax' })
    expect(parseCatPrice('abc')).toEqual({ kind: 'roundMinMax' })
    expect(parseCatPrice('[100;500]/100')).toEqual({ kind: 'range', min: 100, max: 500, step: 100 })
    expect(parseCatPrice('[200;200]')).toEqual({ kind: 'fixed', value: 200 })
  })
  it('варианты: фиксированная одна, иначе минимум и максимум; равные — одна', () => {
    expect(catStakeOptions({ kind: 'fixed', value: 300 }, { min: 100, max: 500 })).toEqual([300])
    expect(catStakeOptions({ kind: 'roundMinMax' }, { min: 100, max: 500 })).toEqual([100, 500])
    expect(catStakeOptions({ kind: 'roundMinMax' }, { min: 200, max: 200 })).toEqual([200])
    expect(catStakeOptions({ kind: 'range', min: 100, max: 900, step: 100 }, { min: 1, max: 2 })).toEqual([100, 900])
  })
  it('ставка голосом: только минимум или максимум', () => {
    expect(matchCatStake('сто', [100, 500])).toBe(100)
    expect(matchCatStake('500', [100, 500])).toBe(500)
    expect(matchCatStake('минимум', [100, 500])).toBe(100)
    expect(matchCatStake('давай максимальную', [100, 500])).toBe(500)
    expect(matchCatStake('триста', [100, 500])).toBeNull()
    expect(matchCatStake('', [100, 500])).toBeNull()
  })
})

describe('получатель кота', () => {
  const players = [{ id: 1, name: 'Матвей' }, { id: 2, name: 'Маша' }, { id: 3, name: 'Вася' }, { id: 4, name: 'Игрок 4' }]
  it('падежи имён', () => {
    expect(matchSpokenPlayer('Матвею', players)).toBe(1)
    expect(matchSpokenPlayer('отдаю Маше', players)).toBe(2)
    expect(matchSpokenPlayer('Васе!', players)).toBe(3)
    expect(matchSpokenPlayer('игроку 4', players)).toBe(4)
    expect(matchSpokenPlayer('четвертому', players)).toBe(4)
  })
  it('неоднозначность, два одинаковых имени, никого — null', () => {
    expect(matchSpokenPlayer('Маше или Васе', players)).toBeNull()
    expect(matchSpokenPlayer('Маше', [{ id: 1, name: 'Маша' }, { id: 2, name: 'Маша' }])).toBeNull()
    expect(matchSpokenPlayer('Пете', players)).toBeNull()
  })
  it('сам выбравший не кандидат', () => {
    expect(matchSpokenPlayer('Матвею', players.filter((player) => player.id !== 1))).toBeNull()
  })
  it('1 игрок — сам, 2 — другой, 3+ — выбор', () => {
    expect(autoCatRecipient([{ id: 1 }], 1)).toBe(1)
    expect(autoCatRecipient([{ id: 1 }, { id: 2 }], 1)).toBe(2)
    expect(autoCatRecipient([{ id: 1 }, { id: 2 }, { id: 3 }], 1)).toBeNull()
  })
  it('следующий по кругу', () => {
    expect(nextInCircle([{ id: 1 }, { id: 2 }, { id: 3 }], 3)).toBe(1)
    expect(nextInCircle([{ id: 1 }, { id: 2 }, { id: 3 }], 1, [2])).toBe(3)
  })
  it('подсказка ASR с падежами', () => {
    expect(nameHints(['Маша', 'Матвей'])).toContain('Маше')
    expect(nameHints(['Маша', 'Матвей'])).toContain('Матвею')
  })
})
