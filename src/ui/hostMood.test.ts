import { describe, expect, it } from 'vitest'
import { hostCaption, hostCopy, hostMood } from './hostMood.ts'

const quiet = { host: 'idle' as const, mic: 'muted' as const }
const open = { host: 'idle' as const, mic: 'live' as const }
const talking = { host: 'speaking' as const, mic: 'muted' as const }

describe('hostMood', () => {
  it('lets players talk only while she is listening for a choice or an answer', () => {
    expect(hostMood('choosing.listening', open)).toBe('listen')
    expect(hostMood('choosing.clarifying', open)).toBe('listen')
    expect(hostMood('choosing.clarifying', talking)).toBe('speak')
    expect(hostMood('answering.waiting', open)).toBe('listen')
    expect(hostMood('answering.hearing', open)).toBe('listen')
    expect(hostMood('answering.waiting', quiet)).toBe('think')
  })

  it('keeps the speaking portrait while her line is still playing', () => {
    expect(hostMood('buzzing', talking)).toBe('speak')
    expect(hostMood('reading', talking)).toBe('speak')
    expect(hostMood('reading', quiet)).toBe('speak')
    expect(hostMood('reading.armed', talking)).toBe('buzz')
    expect(hostMood('reading.armed', quiet)).toBe('buzz')
    expect(hostMood('reading.sealed', talking)).toBe('speak')
    expect(hostMood('reading.sealed', quiet)).toBe('speak')
    expect(hostMood('announcing', quiet)).toBe('speak')
    expect(hostMood('announcing.speaking', quiet)).toBe('speak')
    expect(hostMood('announcing.holding', quiet)).toBe('think')
  })

  it('asks for a button instead of speech, and shows thinking otherwise', () => {
    expect(hostMood('buzzing', quiet)).toBe('buzz')
    expect(hostMood('buzzing', open)).toBe('buzz')
    expect(hostCopy.buzz.hint).toContain('кнопки')
    expect(hostMood('judging', quiet)).toBe('think')
    expect(hostMood('choosing.resolving', quiet)).toBe('think')
  })
})

describe('hostCaption', () => {
  const think = hostCopy.think
  const speak = hostCopy.speak
  const listen = hostCopy.listen
  const buzz = hostCopy.buzz

  it('puts the concrete phase under the instruction and drops the same-meaning hint', () => {
    expect(hostCaption({ ...think, status: 'Ведущая оценивает ответ' })).toEqual({
      title: 'Не говорите',
      lines: ['Ведущая оценивает ответ'],
    })
    expect(hostCaption({ ...think, status: 'Ведущая разбирает выбор' }).lines).toEqual(['Ведущая разбирает выбор'])
    expect(hostCaption({ ...think, status: 'Ведущая задумалась' }).lines).toEqual(['Ведущая задумалась'])
    expect(hostCaption({ ...speak, status: 'Ведущая читает вопрос' }).lines).toEqual(['Ведущая читает вопрос'])
    expect(hostCaption({ ...listen, status: 'назовите тему и стоимость' }).lines).toEqual([
      'назовите тему и стоимость',
    ])
  })

  it('keeps a hint that says something the title does not', () => {
    expect(hostCaption({ ...buzz, status: 'Жмите свою кнопку' })).toEqual({
      title: 'Жмите кнопку',
      lines: ['Слышу вас, засчитаю только после кнопки'],
    })
    expect(hostCaption({ ...think, status: '' }).lines).toEqual(['Ведущая думает'])
    expect(hostCaption({ ...speak, status: 'Верно' }).lines).toEqual(['Верно'])
    expect(hostCaption({ ...listen, status: 'Отвечает игрок 2' }).lines).toEqual(['Отвечает игрок 2'])
  })

  it('does not repeat pause or stop, and allows a second detail when it is a different fact', () => {
    expect(
      hostCaption({
        title: 'Пауза',
        hint: 'Микрофон выключен, ведущая не ждёт',
        status: 'Пауза. Микрофон выключен, ведущая не ждёт',
      }).lines,
    ).toEqual(['Микрофон выключен, ведущая не ждёт'])
    expect(
      hostCaption({
        title: 'Остановлена',
        hint: 'Сессия закрыта, ведущая не ждёт',
        status: 'Остановлена',
      }).lines,
    ).toEqual(['Сессия закрыта, ведущая не ждёт'])
    expect(hostCaption({ ...buzz, status: 'Время вышло' }).lines).toEqual([
      'Слышу вас, засчитаю только после кнопки',
      'Время вышло',
    ])
  })
})
