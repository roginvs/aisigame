import { describe, expect, it } from 'vitest'
import { cutCaption, HostPace } from './hostCaption.ts'

describe('cutCaption', () => {
  it('режет по сыгранной позиции, недоигранное слово не показывает', () => {
    expect(cutCaption('Вася, выбери ячейку ещё раз.', 9 * 90, 90)).toBe('Вася…')
    expect(cutCaption('Вася, выбери ячейку ещё раз.', 12 * 90, 90)).toBe('Вася, выбери…')
  })
  it('сыграно всё — текст целиком, без «…»', () => {
    expect(cutCaption('Вася, выбери.', 60_000, 90)).toBe('Вася, выбери.')
  })
  it('ни одного целого слова — пусто', () => {
    expect(cutCaption('Игорь, выберите', 60, 90)).toBe('')
  })
})

describe('HostPace', () => {
  it('учится на доигранных репликах, странные замеры игнорирует', () => {
    const pace = new HostPace()
    pace.note(7000, 'x'.repeat(100))
    expect(pace.msPerChar).toBe(70)
    pace.note(100, 'x'.repeat(100))
    pace.note(5000, 'коротко')
    expect(pace.msPerChar).toBe(70)
  })
})
