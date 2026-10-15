import { describe, expect, it } from 'vitest'
import { falseStartCooling } from '../game/machine.ts'
import { buzzerLabel, falseStartLabel } from './buzzerLabel.ts'

describe('buzzerLabel', () => {
  it('во время штрафа — «Фальстарт», после — обычная подпись', () => {
    expect(buzzerLabel({ cooling: true, normal: 'Жмите' })).toBe(falseStartLabel)
    expect(buzzerLabel({ cooling: false, normal: 'Жмите' })).toBe('Жмите')
  })

  it('держится, пока falseStartCooling истинно (по часам штрафа)', () => {
    const stamp = 1000
    const during = falseStartCooling(stamp, stamp + 10)
    expect(buzzerLabel({ cooling: during, normal: 'Вася' })).toBe('Фальстарт')
    const after = falseStartCooling(stamp, stamp + 60_000)
    expect(buzzerLabel({ cooling: after, normal: 'Вася' })).toBe('Вася')
  })

  it('подпись апелляции важнее', () => {
    expect(buzzerLabel({ appealLabel: 'Апелляция', cooling: true, normal: 'Жмите' })).toBe('Апелляция')
  })
})
