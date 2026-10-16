import { describe, expect, it } from 'vitest'
import { hostCaption, hostCopy, hostMood, listeningPaths, publicHostEar } from './hostMood.ts'

const quiet = { host: 'idle' as const, mic: 'muted' as const }
const open = { host: 'idle' as const, mic: 'live' as const }
const talking = { host: 'speaking' as const, mic: 'muted' as const }

describe('hostMood', () => {
  it('hear/process выше listen/think, ниже речи ведущей и окна кнопки', () => {
    expect(hostMood('choosing.listening', open, 'hearing')).toBe('hear')
    expect(hostMood('choosing.resolving', quiet, 'processing')).toBe('process')
    expect(hostMood('judging', quiet, 'processing')).toBe('process')
    expect(hostMood('cat.picking', open, 'hearing')).toBe('hear')
    expect(hostMood('choosing.listening', talking, 'hearing')).toBe('speak')
    expect(hostMood('reading.sealed', open, 'hearing')).toBe('speak')
    expect(hostMood('reading.armed', open, 'hearing')).toBe('buzz')
    expect(hostMood('buzzing.open', open, 'hearing')).toBe('buzz')
    expect(hostMood('choosing.listening', open, 'idle')).toBe('listen')
    expect(hostCopy.hear.title).toBe('Слышу…')
    expect(hostCopy.process.title).toBe('Поняла, думаю…')
  })

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
    expect(hostCaption({ ...listen, status: 'Отвечает Маша' }).lines).toEqual(['Отвечает Маша'])
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

describe('cat/auction listening', () => {
  const catAuction = ['cat.picking', 'cat.clarifying', 'cat.staking.listening', 'cat.staking.clarifying', 'auction.listening', 'auction.clarifying']
  it('карточка «Можно говорить» и ухо «listening» у гостей — как на выборе', () => {
    for (const path of catAuction) {
      expect(listeningPaths.has(path)).toBe(true)
      expect(hostMood(path, open, 'idle')).toBe('listen')
      expect(hostMood(path, open, 'listening')).toBe('listen')
      expect(hostMood(path, quiet, 'idle')).toBe('think')
      expect(hostMood(path, talking, 'idle')).toBe('speak')
      expect(publicHostEar(path, open, 'idle', true)).toBe('listening')
      expect(publicHostEar(path, quiet, 'idle', true)).toBe('idle')
    }
  })
  it('паритет: снимок гостя даёт то же настроение, что у мастера', () => {
    for (const path of [...listeningPaths, 'cat.resolving', 'auction.asking', 'auction.resolving', 'judging', 'buzzing.open']) {
      for (const link of [open, quiet, talking]) {
        expect(hostMood(path, link, publicHostEar(path, link, 'idle', true))).toBe(hostMood(path, link, 'idle'))
      }
    }
  })
  it('неслушающие фазы кота/аукциона не открывают ухо', () => {
    for (const path of ['cat.announcing', 'cat.resolving', 'cat.staking.asking', 'auction.announcing', 'auction.asking', 'auction.resolving']) {
      expect(publicHostEar(path, open, 'idle', true)).toBe('idle')
    }
    expect(publicHostEar('cat.picking', open, 'idle', false)).toBe('idle')
  })
})
