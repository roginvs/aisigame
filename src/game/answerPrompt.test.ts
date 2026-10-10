import { describe, expect, it } from 'vitest'
import { answerListeningPrompt, echoesAnswerPrompt } from './answerPrompt.ts'

const buzzerPrompt = 'Человек говорит, пока нужно нажать кнопку. Это ещё не ответ на вопрос.'

describe('answerListeningPrompt', () => {
  it('передаёт ответы ячейки и не совпадает с подсказкой до кнопки', () => {
    const prompt = answerListeningPrompt(['Пылесосел', 'Утюгусь', 'Пылесосел'])
    expect(prompt).toContain('«Пылесосел»')
    expect(prompt).toContain('«Утюгусь»')
    expect(prompt).toContain('на слоги')
    expect(prompt.split('«Пылесосел»')).toHaveLength(2)
    expect(prompt).not.toContain('Шлакоблокунь')
    expect(prompt).not.toContain('договор')
    expect(prompt.length).toBeLessThanOrEqual(1024)
    expect(buzzerPrompt).not.toContain('Пылесосел')
    expect(echoesAnswerPrompt(prompt, buzzerPrompt)).toBe(false)
  })

  it('отбрасывает эхо подсказки и оставляет само слово эталона', () => {
    const prompt = answerListeningPrompt(['Пылесосел', 'Утюгусь'])
    expect(echoesAnswerPrompt(prompt, prompt)).toBe(true)
    expect(echoesAnswerPrompt(`Возможные ответы: «Пылесосел» / «Утюгусь».`, prompt)).toBe(true)
    expect(echoesAnswerPrompt('Игрок называет ответ. Может сказать редкое или выдуманное слово.', prompt)).toBe(true)
    expect(echoesAnswerPrompt('пылесосел', prompt)).toBe(false)
    expect(echoesAnswerPrompt('Пылесосел.', prompt)).toBe(false)
    expect(echoesAnswerPrompt('Утюгусь', prompt)).toBe(false)
    expect(echoesAnswerPrompt('пы ле со сел', prompt)).toBe(false)
  })
})
