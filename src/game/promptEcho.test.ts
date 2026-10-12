import { describe, expect, it } from 'vitest'
import { echoesTranscriptionPrompt } from './promptEcho.ts'

describe('echoesTranscriptionPrompt', () => {
  it('ловит дословное эхо подсказки кнопки и чтения', () => {
    const buzzer = 'Человек говорит, пока нужно нажать кнопку. Это ещё не ответ на вопрос.'
    expect(echoesTranscriptionPrompt(buzzer, buzzer)).toBe(true)
    expect(echoesTranscriptionPrompt(`${buzzer}.`, buzzer)).toBe(true)
    const reading = 'Пока ведущая читает вопрос, в комнате могут говорить. Это не ответ и не выбор ячейки.'
    expect(echoesTranscriptionPrompt(reading, reading)).toBe(true)
    expect(echoesTranscriptionPrompt('Ньютон', buzzer)).toBe(false)
    expect(echoesTranscriptionPrompt('Фотосинтез', reading)).toBe(false)
  })
})
