import { describe, expect, it } from 'vitest'
import { amountWords, appealResultLine } from './appealSpeech.ts'

describe('фразы итога апелляции', () => {
  it('суммы словами, родительный падеж', () => {
    expect(amountWords(-300)).toBe('минус триста')
    expect(amountWords(-300, true)).toBe('минус трёхсот')
    expect(amountWords(1200, true)).toBe('плюс тысячи двухсот')
    expect(amountWords(0, true)).toBe('нуля')
    expect(amountWords(250)).toBe('плюс 250')
  })
  it('не помогла / принята — итог за этот вопрос, замена, а не доплата', () => {
    expect(appealResultLine({ name: 'Вася', amount: -300, previous: -300, accepted: false }))
      .toBe('Апелляция не помогла: за этот вопрос у игрока Вася по-прежнему минус триста.')
    expect(appealResultLine({ name: 'Вася', amount: 300, previous: -300, accepted: true, total: 500 }))
      .toBe('Апелляция принята: за этот вопрос у игрока Вася теперь плюс триста вместо минус трёхсот. Общий счёт 500.')
    expect(appealResultLine({ name: 'Вася', amount: -100, previous: 0, accepted: false }))
      .toBe('Апелляция не помогла: за этот вопрос у игрока Вася теперь минус сто вместо нуля.')
  })
})
