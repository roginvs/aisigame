import { describe, expect, it } from 'vitest'
import {
  earlyBuzzerCharsPerSec,
  earlyBuzzerJitterMs,
  earlyBuzzerMaxMs,
  earlyBuzzerMinMs,
  earlyBuzzerMs,
} from '../options.ts'
import { earlyBuzzerMsFor } from './earlyBuzzer.ts'

describe('earlyBuzzerMsFor', () => {
  it('короткий текст ближе к минимуму, длинный — к максимуму, пустой берёт запасной срок', () => {
    expect(earlyBuzzerMsFor('', 0.5)).toBe(earlyBuzzerMs)
    expect(earlyBuzzerMsFor('Кто?', 0.5)).toBe(earlyBuzzerMinMs)
    expect(earlyBuzzerMsFor('x'.repeat(earlyBuzzerCharsPerSec * 3), 0.5)).toBe(earlyBuzzerMinMs)
    expect(earlyBuzzerMsFor('x'.repeat(earlyBuzzerCharsPerSec * 5), 0.5)).toBe(5_000)
    expect(earlyBuzzerMsFor('x'.repeat(earlyBuzzerCharsPerSec * 10), 0.5)).toBe(earlyBuzzerMaxMs)
  })

  it('разброс двигает оценку, но не выходит за min…max', () => {
    const text = 'x'.repeat(earlyBuzzerCharsPerSec * 5)
    expect(earlyBuzzerMsFor(text, 0)).toBe(5_000 - earlyBuzzerJitterMs)
    expect(earlyBuzzerMsFor(text, 1)).toBe(5_000 + earlyBuzzerJitterMs)
    expect(earlyBuzzerMsFor('Кто?', 0)).toBe(earlyBuzzerMinMs)
    expect(earlyBuzzerMsFor('x'.repeat(400), 1)).toBe(earlyBuzzerMaxMs)
  })
})
