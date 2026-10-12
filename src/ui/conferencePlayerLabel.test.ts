import { describe, expect, it } from 'vitest'
import { conferencePlayerLabel } from './conferencePlayerLabel.ts'

describe('conferencePlayerLabel', () => {
  it('без данных партии не показывает заглушки Игрок 1', () => {
    expect(conferencePlayerLabel('Игрок 1', false)).toBe('нет данных')
    expect(conferencePlayerLabel('Player 2', false)).toBe('нет данных')
    expect(conferencePlayerLabel('', false)).toBe('нет данных')
  })

  it('с данными партии оставляет настоящее имя', () => {
    expect(conferencePlayerLabel('Вася', true)).toBe('Вася')
    expect(conferencePlayerLabel('Игрок 1', true)).toBe('Игрок 1')
    expect(conferencePlayerLabel('  ', true)).toBe('нет данных')
  })
})
