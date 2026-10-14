import { describe, expect, it } from 'vitest'
import { gameConfig, hostInstructions } from '../config.ts'
import { playNote, spokenPayload } from '../realtime/speechMatch.ts'
import {
  announceInstructions,
  bridgeInstructions,
  buzzerWarningDelay,
  falseStartInstructions,
  finishedInstructions,
  verbatimAnnouncement,
  welcomeInstructions,
} from './controller.ts'
import type { GameContext, Question } from './types.ts'

function context(overrides: Partial<GameContext> = {}): GameContext {
  const question: Question = {
    id: 'q1',
    roundIndex: 0,
    themeId: 't1',
    themeName: 'Б.Б.',
    value: 100,
    text: 'Кто это?',
    answers: ['Боевой Буратино'],
  }
  return {
    players: [
      { id: 1, name: 'Игрок 1', score: 0 },
      { id: 2, name: 'Игрок 2', score: 0 },
      { id: 3, name: 'Игрок 3', score: 0 },
    ],
    packName: 'Пакет',
    rounds: [{ index: 0, name: 'Раунд', kind: 'normal' }],
    roundIndex: 0,
    warnings: [],
    questions: [question],
    playedIds: ['q1'],
    missedIds: [],
    finalists: [],
    finalCursor: 0,
    bets: [],
    betMisses: 0,
    activeStake: null,
    activeQuestionId: 'q1',
    activePlayerId: null,
    chooserId: 1,
    attemptId: 1,
    clarifications: 0,
    spokeWithoutButton: false,
    talkedDuringRead: false,
    sayFalseStart: false,
    wrongHeard: [],
    sayCloseGuess: false,
    heard: '',
    judgmentReason: '',
    judgmentStatus: null,
    announceKind: 'nobody',
    clarifyReason: '',
    error: null,
    resumePath: '',
    resumeStatus: '',
    statusLine: '',
    phaseStartedAt: null,
    phaseDurationMs: null,
    earlyLeftMs: null,
    earlyStartedAt: null,
    pauseStartedAt: null,
    falseStarts: {},
    ...overrides,
  }
}

describe('announceInstructions', () => {
  it('в тишине называет только ответ', () => {
    const sample = context()
    const line = announceInstructions(sample)
    expect(line).toBe('Боевой Буратино')
    expect(verbatimAnnouncement(sample)).toBe(line)
    expect(line).not.toContain('дословно')
    expect(line).not.toContain('произнес')
    expect(line).not.toContain('только после кнопки')
    expect(line).not.toContain('никто не нажал')
    expect(line).not.toContain('выбирайте следующий')
  })

  it('если без кнопки уже говорили, эталон обязателен, а хвост про кнопку — свободный', () => {
    const sample = context({ spokeWithoutButton: true })
    const line = announceInstructions(sample)
    expect(verbatimAnnouncement(sample)).toBeNull()
    expect(line).toContain('Сначала произнеси правильный ответ: «Боевой Буратино»')
    expect(line).toContain('своими словами напомни, что ответ засчитывают только после кнопки')
    expect(line.indexOf('«Боевой Буратино»')).toBeLessThan(line.indexOf('только после кнопки'))
    expect(line).not.toBe('Боевой Буратино. Ответ называют только после кнопки.')
    expect(line).not.toContain('выбирайте следующий')
    expect(line).not.toContain('никто не нажал')
  })

  it('когда ошиблись все, сначала дословный эталон, потом что неверно', () => {
    const line = announceInstructions(context({ announceKind: 'incorrect' }))
    expect(line).toContain('Сначала произнеси правильный ответ: «Боевой Буратино»')
    expect(line).toContain('Другой ответ не придумывай')
    expect(line).toContain('что неверно')
    expect(line).toContain('минус 100')
    expect(line).not.toContain('дословно')
    expect(line.indexOf('«Боевой Буратино»')).toBeLessThan(line.indexOf('неверно'))
    expect(line).not.toContain('без тем и номиналов')
  })

  it('когда у последнего вышло время, сначала дословный эталон, потом что не услышала', () => {
    const line = announceInstructions(context({ announceKind: 'silence' }))
    expect(line).toContain('Сначала произнеси правильный ответ: «Боевой Буратино»')
    expect(line).toContain('ничего не услышала')
    expect(line).toContain('минус')
    expect(line).toContain('минус 100')
    expect(line).not.toContain('дословно')
    expect(line).not.toContain('что неверно')
    expect(line).not.toContain('время на ответ вышло')
    expect(line.indexOf('«Боевой Буратино»')).toBeLessThan(line.indexOf('ничего не услышала'))
  })

  it('молчание с перехватом: свободно что не услышала, не «неверно», минус на месте', () => {
    const line = announceInstructions(
      context({ announceKind: 'silence', playedIds: [], activePlayerId: 1, players: [
        { id: 1, name: 'Маша', score: 0 },
        { id: 2, name: 'Вася', score: 0 },
        { id: 3, name: 'Игрок 3', score: 0 },
      ] }),
    )
    const spoken = spokenPayload(line)
    expect(spoken).toContain('Исход: молчание')
    expect(spoken).toContain('ничего не услышала')
    expect(spoken).toContain('микрофон')
    expect(spoken).toContain('минус 100')
    expect(spoken).toContain('Маша')
    expect(spoken).toContain('Формулировку выбери сам')
    expect(spoken).toContain('Не говори, что ответ неверный')
    expect(spoken).not.toContain('Исход: неверно')
    expect(spoken).not.toContain('Боевой Буратино')
  })

  it('на созвучие просит повторить и не называет эталон', () => {
    const line = announceInstructions(
      context({ announceKind: 'repeat', playedIds: [], judgmentStatus: 'near_miss' }),
    )
    expect(line).toContain('Исход: повтор')
    expect(line).toContain('попроси повторить')
    expect(line).not.toContain('Боевой Буратино')
    expect(line).not.toContain('Исход: неверно')
  })

  it('не разобранный закрытый ответ называет только эталон', () => {
    const sample = context({
      announceKind: 'unclear',
      judgmentStatus: 'unintelligible',
    })
    const line = announceInstructions(sample)
    expect(line).toBe('Боевой Буратино')
    expect(verbatimAnnouncement(sample)).toBe(line)
    expect(line).not.toContain('не засчитан')
  })

  it('не разобранный ответ с несколькими формами читает эталон и коротко закрывает', () => {
    const base = context()
    const sample = context({
      announceKind: 'unclear',
      judgmentStatus: 'unintelligible',
      judgmentReason: 'Реплика обрывочная и не позволяет понять осмысленный ответ.',
      questions: [{ ...base.questions[0], answers: ['Солнце', 'солнечная звезда'] }],
    })
    const line = announceInstructions(sample)
    expect(verbatimAnnouncement(sample)).toBeNull()
    expect(line).toContain('Сначала произнеси один самый очевидный ответ из списка:')
    expect(line).toContain('Назови ровно один вариант')
    expect(line).toContain('«Солнце»')
    expect(line).toContain('не засчитан')
    expect(line).not.toContain('обрывочная')
  })

  it('не разобранный ответ не называет эталон, пока ячейка открыта', () => {
    const sample = context({
      announceKind: 'unclear',
      judgmentStatus: 'unintelligible',
      playedIds: [],
    })
    const line = announceInstructions(sample)
    expect(verbatimAnnouncement(sample)).toBeNull()
    expect(line).not.toContain('Боевой Буратино')
  })

  it('из нескольких ответов просит один очевидный и не велит читать список целиком', () => {
    const base = context()
    const line = announceInstructions(
      context({
        questions: [{ ...base.questions[0], answers: ['Солнце', 'солнечная звезда', 'ближайшая звезда'] }],
      }),
    )
    expect(line).toContain('один самый очевидный')
    expect(line).toContain('«Солнце»')
    expect(line).toContain('«солнечная звезда»')
    expect(line).toContain('Назови ровно один вариант')
    expect(line).not.toContain('дословно')
    expect(line).not.toContain(' или ')
    expect(line).not.toContain('никто не нажал')
  })

  it('у вопроса с вариантами произносит букву вместе с текстом', () => {
    const base = context()
    const line = announceInstructions(
      context({
        questions: [
          {
            ...base.questions[0],
            text: 'Что появилось раньше?',
            answers: ['D', 'Звёздные войны'],
            choices: [
              { label: 'A', text: 'Индиана Джонс', media: [] },
              { label: 'D', text: 'Звёздные войны', media: [] },
            ],
          },
        ],
      }),
    )
    expect(line).toBe('D. Звёздные войны')
    expect(line).toContain('D. Звёздные войны')
    expect(line).not.toContain('Индиана Джонс')
    expect(line).not.toContain('один самый очевидный')
    expect(line).not.toContain('никто не нажал')
  })

  it('если перебили чтение, эталон обязателен, а хвост про кнопку — свободный', () => {
    const sample = context({ talkedDuringRead: true })
    const line = announceInstructions(sample)
    expect(verbatimAnnouncement(sample)).toBeNull()
    expect(line).toContain('Сначала произнеси правильный ответ: «Боевой Буратино»')
    expect(line).toContain('своими словами напомни, что ответ засчитывают только после кнопки')
    expect(line.indexOf('«Боевой Буратино»')).toBeLessThan(line.indexOf('только после кнопки'))
    expect(line).not.toBe('Боевой Буратино. Ответ называют только после кнопки.')
    expect(line).not.toContain('дословно')
    expect(line).not.toContain('выбирайте следующий')
    expect(line).not.toContain('никто не нажал')
  })

  it('предупреждает за две секунды только на полном первом окне кнопки', () => {
    expect(buzzerWarningDelay(gameConfig.buzzerMs)).toBe(gameConfig.buzzerMs - gameConfig.buzzerWarningMs)
    expect(buzzerWarningDelay(gameConfig.stealBuzzerMs)).toBeNull()
  })

  it('если монетка молчит, в тишине по-прежнему только ответ', () => {
    const base = context()
    const sample = context({
      sayCloseGuess: false,
      wrongHeard: ['Братство кольца'],
      questions: [{ ...base.questions[0], answers: ['Властелин колец'] }],
    })
    expect(announceInstructions(sample)).toBe('Властелин колец')
    expect(verbatimAnnouncement(sample)).toBe('Властелин колец')
  })

  it('на закрытии без кнопки монетка может поставить близость перед эталоном', () => {
    const base = context()
    const sample = context({
      sayCloseGuess: true,
      wrongHeard: ['Братство кольца'],
      questions: [{ ...base.questions[0], answers: ['Властелин колец'] }],
    })
    const line = announceInstructions(sample)
    expect(verbatimAnnouncement(sample)).toBeNull()
    expect(line).toContain('Попытки после кнопки, для контекста: «Братство кольца»')
    expect(line).toContain('можешь коротко своими словами сказать, что было близко')
    expect(line).toContain('самой близкой')
    expect(line).toContain('произнеси правильный ответ: «Властелин колец»')
    expect(line).toContain('После ответа больше ничего не добавляй')
    expect(line).toContain('Не говори, что кнопку не нажали')
    expect(line.indexOf('«Братство кольца»')).toBeLessThan(line.indexOf('«Властелин колец»'))
    expect(line).not.toContain('никто не нажал')
    expect(line).not.toContain('выбирайте следующий')
    expect(line).not.toContain('Одна короткая фраза: верно')
  })

  it('в реплику про близость кладёт услышанное как есть и не велит перечислять все попытки', () => {
    const base = context()
    const heard = 'Братство кольца это, по-моему. Ну, Братство кольца, я же отвечаю, что это.'
    const line = announceInstructions(
      context({
        sayCloseGuess: true,
        wrongHeard: [heard, 'Хоббит'],
        questions: [{ ...base.questions[0], answers: ['Властелин колец'] }],
      }),
    )
    expect(line).toContain(`«${heard}»`)
    expect(line).toContain('«Хоббит»')
    expect(line).toContain('самой близкой')
    expect(line).toContain('не перечисляй')
    expect(line.indexOf(heard)).toBeLessThan(line.indexOf('«Властелин колец»'))
  })

  it('пока ячейка открыта, неверная реплика не попадает в объявление', () => {
    const line = announceInstructions(
      context({
        announceKind: 'incorrect',
        playedIds: [],
        sayCloseGuess: true,
        wrongHeard: ['Братство кольца'],
        heard: 'Братство кольца',
      }),
    )
    expect(line).toContain('неверно')
    expect(line).toContain('минус 100')
    expect(line).not.toContain('Братство')
    expect(line).not.toContain('Буратино')
    expect(line).not.toContain('близко')
  })

  it('когда ошиблись все, близость стоит перед эталоном и перед «неверно»', () => {
    const base = context()
    const line = announceInstructions(
      context({
        announceKind: 'incorrect',
        sayCloseGuess: true,
        wrongHeard: ['Братство кольца'],
        questions: [{ ...base.questions[0], answers: ['Властелин колец'] }],
      }),
    )
    expect(line.indexOf('«Братство кольца»')).toBeLessThan(line.indexOf('«Властелин колец»'))
    expect(line.indexOf('«Властелин колец»')).toBeLessThan(line.indexOf('что неверно'))
    expect(line).toContain('минус 100')
    expect(line).not.toContain('нажимать кнопку')
  })

  it('когда у последнего вышло время, близость стоит перед эталоном', () => {
    const base = context()
    const line = announceInstructions(
      context({
        announceKind: 'silence',
        sayCloseGuess: true,
        wrongHeard: ['Братство кольца'],
        questions: [{ ...base.questions[0], answers: ['Властелин колец'] }],
      }),
    )
    expect(line.indexOf('«Братство кольца»')).toBeLessThan(line.indexOf('«Властелин колец»'))
    expect(line.indexOf('«Властелин колец»')).toBeLessThan(line.indexOf('ничего не услышала'))
  })

  it('молчание без попытки и верный ответ близость не упоминают', () => {
    const quiet = announceInstructions(context({ sayCloseGuess: true, wrongHeard: [] }))
    expect(quiet).toBe('Боевой Буратино')
    const right = announceInstructions(
      context({
        announceKind: 'correct',
        playedIds: [],
        sayCloseGuess: true,
        wrongHeard: ['Братство кольца'],
        activePlayerId: 1,
      }),
    )
    expect(right).not.toContain('Братство')
    expect(right).not.toContain('Буратино')
  })

  it('напоминание про кнопку остаётся после ответа', () => {
    const base = context()
    const line = announceInstructions(
      context({
        sayCloseGuess: true,
        wrongHeard: ['Братство кольца'],
        spokeWithoutButton: true,
        questions: [{ ...base.questions[0], answers: ['Властелин колец'] }],
      }),
    )
    expect(line.indexOf('Братство кольца')).toBeLessThan(line.indexOf('Властелин колец'))
    expect(line.indexOf('Властелин колец')).toBeLessThan(line.indexOf('только после кнопки'))
    expect(line).not.toContain('никто не нажал')
  })

  it('в короткой оценке можно назвать игрока', () => {
    const line = announceInstructions(
      context({
        announceKind: 'correct',
        playedIds: [],
        activePlayerId: 1,
        players: [
          { id: 1, name: 'Вася', score: 100 },
          { id: 2, name: 'Маша', score: 0 },
          { id: 3, name: 'Игрок 3', score: 0 },
        ],
      }),
    )
    expect(line).toContain('Вася')
    expect(line).toContain('Исход: верно')
    expect(line).toContain('Ситуация:')
    expect(line).toContain('Цель:')
    expect(line).not.toContain('Боевой Буратино')
    expect(line).not.toContain('синоним вроде')
  })

  it('в словах похвалы нет смешка: звук только в пометке, как сыграть', () => {
    const line = announceInstructions(
      context({
        announceKind: 'correct',
        activePlayerId: 2,
        players: [
          { id: 1, name: 'Вася', score: 0 },
          { id: 2, name: 'Маша', score: 300 },
          { id: 3, name: 'Игрок 3', score: 0 },
        ],
        questions: [
          {
            id: 'q1',
            roundIndex: 0,
            themeId: 't1',
            themeName: 'Б.Б.',
            value: 300,
            text: 'Кто это?',
            answers: ['Боевой Буратино'],
          },
        ],
      }),
    )
    const spoken = spokenPayload(line)
    expect(spoken).toContain('Исход: верно')
    expect(spoken).toContain('плюс 300')
    expect(spoken).toContain('Маша')
    expect(spoken).toContain('дальше')
    expect(spoken).toContain('Ситуация:')
    expect(spoken).not.toContain('смешок')
    expect(spoken).not.toContain('хихикаем')
    expect(spoken).not.toContain('тёпл')
    expect(spoken).not.toContain('хи-хи')
    expect(spoken).not.toContain('Боевой Буратино')
    expect(spoken).not.toContain('синоним вроде')
    const note = playNote(line)
    expect(line).toContain('Как сыграть, вслух не читать')
    expect(note).toContain('хи-хи')
    expect(note).toContain('смешок')
    expect(note).toContain('хихикаем')
    expect(note).toContain('не читай')
  })

  it('неверный ответ без смеха и без слова «сухая» в реплике', () => {
    const line = announceInstructions(context({ announceKind: 'incorrect', playedIds: [] }))
    const spoken = spokenPayload(line)
    expect(spoken).toContain('Исход: неверно')
    expect(spoken).toContain('минус 100')
    expect(spoken).toContain('Ситуация:')
    expect(spoken).not.toContain('смешок')
    expect(spoken).not.toContain('хихи')
    expect(spoken).not.toContain('сух')
    expect(spoken).not.toContain('тёпл')
    expect(spoken).not.toContain('синоним вроде')
    const note = playNote(line)
    expect(note).not.toContain('хи-хи')
    expect(note).not.toContain('хихикаем')
    expect(note).toContain('сухая фраза')
  })
})

describe('welcomeInstructions', () => {
  it('зовёт выбрать вопрос и не перечисляет номиналы', () => {
    const line = welcomeInstructions(
      context({
        packName: 'Демо',
        chooserId: 2,
        players: [
          { id: 1, name: 'Вася', score: 0 },
          { id: 2, name: 'Мотя', score: 0 },
        ],
        questions: [100, 200, 300, 400, 500].map((value) => ({
          id: `q-${value}`,
          roundIndex: 0,
          themeId: 't1',
          themeName: 'Реки',
          value,
          text: 'Кто это?',
          answers: ['Волга'],
        })),
      }),
    )
    expect(line).toContain('Мотя')
    expect(line).toContain('выбрать вопрос')
    expect(line).toContain('Ситуация:')
    expect(line).toContain('Цель:')
    expect(line.toLowerCase()).not.toContain('номинал')
    expect(line).not.toContain('Реки')
    for (const value of [100, 200, 300, 400, 500]) {
      expect(line).not.toContain(String(value))
    }
    expect(hostInstructions).not.toContain('первом приветствии')
    expect(hostInstructions).toContain('Номиналы и цены вопросов не называй')
    expect(hostInstructions).toContain('формулируй сама по ситуации')
    expect(hostInstructions).toContain('текст вопроса')
    expect(hostInstructions).toContain('ответ пакета')
    expect(hostInstructions).not.toContain('«ах»')
    const spoken = spokenPayload(line)
    expect(spoken).toContain('поприветствуй')
    expect(spoken).not.toContain('смешок')
    expect(spoken).not.toContain('хихикаем')
    expect(spoken).not.toContain('тёпл')
    expect(playNote(line)).toContain('хи-хи')
  })
})

describe('finishedInstructions', () => {
  it('в итоге звук смеха не входит в слова счёта', () => {
    const line = finishedInstructions(
      context({
        players: [
          { id: 1, name: 'Вася', score: 100 },
          { id: 2, name: 'Маша', score: 0 },
        ],
      }),
    )
    const spoken = spokenPayload(line)
    expect(spoken).toContain('Вася — 100')
    expect(spoken).toContain('Победил Вася')
    expect(spoken).toContain('Ситуация:')
    expect(spoken).not.toContain('смешок')
    expect(spoken).not.toContain('хихикаем')
    expect(spoken).not.toContain('улыб')
    expect(spoken).not.toContain('тёпл')
    expect(playNote(line)).toContain('хи-хи')
  })
})

describe('bridgeInstructions', () => {
  it('между раундами называет имя и счёт каждого, без списка тем', () => {
    const line = bridgeInstructions(
      context({
        players: [
          { id: 1, name: 'Вася', score: 100 },
          { id: 2, name: 'Маша', score: -20 },
        ],
        rounds: [
          { index: 0, name: 'Первый', kind: 'normal' },
          { index: 1, name: 'Второй', kind: 'normal' },
        ],
        roundIndex: 1,
        chooserId: 2,
      }),
    )
    expect(line).toContain('Вася — 100')
    expect(line).toContain('Маша — -20')
    expect(line).toContain('Маша')
    expect(line).toContain('Второй')
    expect(line).not.toContain('Б.Б.')
  })

  it('перед финалом тоже называет счёт', () => {
    const line = bridgeInstructions(
      context({
        players: [
          { id: 1, name: 'Вася', score: 40 },
          { id: 2, name: 'Маша', score: 10 },
        ],
        rounds: [
          { index: 0, name: 'Первый', kind: 'normal' },
          { index: 1, name: 'Финал', kind: 'final' },
        ],
        roundIndex: 1,
        chooserId: 2,
      }),
    )
    expect(line).toContain('Вася — 40')
    expect(line).toContain('Маша — 10')
    expect(line).toContain('финал')
    expect(line).not.toContain('Б.Б.')
  })
})

describe('falseStartInstructions', () => {
  it('называет имена и не называет ответ', () => {
    const one = falseStartInstructions(
      context({
        players: [
          { id: 1, name: 'Вася', score: 0 },
          { id: 2, name: 'Маша', score: 0 },
        ],
        falseStarts: { 1: 1 },
      }),
    )
    expect(one).toContain('Ситуация:')
    expect(one).toContain('Вася')
    expect(one).toContain('фальстарт')
    expect(one).not.toContain('Пример тона')
    expect(one).not.toContain('фальстарт»')
    expect(one).toContain('каждый раз по-новому')
    expect(one).not.toContain('Боевой Буратино')
    const two = falseStartInstructions(
      context({
        players: [
          { id: 1, name: 'Маша', score: 0 },
          { id: 2, name: 'Вася', score: 0 },
        ],
        falseStarts: { 2: 2, 1: 1 },
      }),
    )
    expect(two).toContain('Маша')
    expect(two).toContain('Вася')
    expect(two).not.toContain('Ого')
    expect(two).not.toContain('Боевой Буратино')
  })
})
