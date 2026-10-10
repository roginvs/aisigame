import { describe, expect, it } from 'vitest'
import { parseBet } from './bet.ts'

describe('parseBet', () => {
  it('reads digits, words and all-in within the score', () => {
    expect(parseBet('ставлю 300', 500)).toBe(300)
    expect(parseBet('пятьсот', 800)).toBe(500)
    expect(parseBet('две тысячи сто', 3000)).toBe(2100)
    expect(parseBet('ва-банк', 450)).toBe(450)
  })

  it('rejects zero, overflow and noise', () => {
    expect(parseBet('ноль', 100)).toBeNull()
    expect(parseBet('600', 500)).toBeNull()
    expect(parseBet('кхе', 100)).toBeNull()
  })
})