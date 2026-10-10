import { describe, expect, it } from 'vitest'
import { blurtGate, choiceGate } from './heard.ts'

describe('choiceGate', () => {
  it('accepts a phrase that could be a cell', () => {
    expect(choiceGate('история за двести', 1400)).toBe('select')
    expect(choiceGate('космос', 700)).toBe('select')
  })

  it('drops a cough or an empty blip', () => {
    expect(choiceGate('', 250)).toBe('ignore')
    expect(choiceGate('кхе', 400)).toBe('ignore')
  })

  it('asks to repeat a longer sound that still is not a choice', () => {
    expect(choiceGate('', 1600)).toBe('ask-again')
    expect(choiceGate('мм', 1200)).toBe('ask-again')
  })
})

describe('blurtGate', () => {
  it('игнорирует кашель, пока ждут кнопку', () => {
    expect(blurtGate('кхе', 400)).toBe('ignore')
    expect(blurtGate('', 200)).toBe('ignore')
  })

  it('запоминает фразу без кнопки и не считает длинный шум фразой', () => {
    expect(blurtGate('Тибр', 700)).toBe('talk')
    expect(blurtGate('Каспийское море', 1500)).toBe('talk')
    expect(blurtGate('кхе', 1500)).toBe('ignore')
    expect(blurtGate('мм', 2000)).toBe('ignore')
  })
})