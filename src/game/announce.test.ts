import { describe, expect, it } from 'vitest'
import { gameConfig, hostInstructions } from '../config.ts'
import {
  announceInstructions,
  bridgeInstructions,
  buzzerWarningDelay,
  falseStartInstructions,
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

  it('если без кнопки уже говорили, после ответа просит нажимать кнопку', () => {
    const line = announceInstructions(context({ spokeWithoutButton: true }))
    expect(line).toBe('Боевой Буратино. Ответ называют только после кнопки.')
    expect(line.indexOf('Боевой Буратино')).toBeLessThan(line.indexOf('только после кнопки'))
    expect(line).not.toContain('выбирайте следующий')
    expect(line).not.toContain('никто не нажал')
    expect(line).not.toContain('произнес')
  })

  it('когда ошиблись все, сначала дословный эталон, потом что неверно', () => {
    const line = announceInstructions(context({ announceKind: 'incorrect' }))
    expect(line).toBe(
      'Сначала произнеси правильный ответ: «Боевой Буратино». Другой ответ не придумывай. Только после этого коротко скажи, что неверно. Сразу назови очки: минус 100.',
    )
    expect(line).not.toContain('дословно')
    expect(line.indexOf('«Боевой Буратино»')).toBeLessThan(line.indexOf('неверно'))
    expect(line).not.toContain('без тем и номиналов')
  })

  it('когда у последнего вышло время, сначала дословный эталон', () => {
    const line = announceInstructions(context({ announceKind: 'silence' }))
    expect(line).toBe(
      'Сначала произнеси правильный ответ: «Боевой Буратино». Другой ответ не придумывай. Только после этого коротко скажи, что время на ответ вышло. Сразу назови очки: минус 100.',
    )
    expect(line).not.toContain('дословно')
    expect(line.indexOf('«Боевой Буратино»')).toBeLessThan(line.indexOf('время на ответ вышло'))
  })

  it('на созвучие просит повторить и не называет эталон', () => {
    const line = announceInstructions(
      context({ announceKind: 'repeat', playedIds: [], judgmentStatus: 'near_miss' }),
    )
    expect(line).toContain('Повторите, пожалуйста')
    expect(line).not.toContain('Боевой Буратино')
    expect(line).not.toContain('неверно')
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
    expect(line).toContain('Близкие синонимы')
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

  it('если перебили чтение, после ответа напоминает про кнопку', () => {
    const line = announceInstructions(context({ talkedDuringRead: true }))
    expect(line).toBe('Боевой Буратино. Ответ называют только после кнопки.')
    expect(line.indexOf('Боевой Буратино')).toBeLessThan(line.indexOf('только после кнопки'))
    expect(line).not.toContain('дословно')
    expect(line).not.toContain('выбирайте следующий')
    expect(line).not.toContain('никто не нажал')
  })

  it('предупреждает за две секунды только на десятисекундном окне', () => {
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
    expect(line).toBe(
      [
        'Попытки после кнопки, коротко: «Братство кольца».',
        'Если одна явно называет то же, что эталон, только соседним заголовком — часть цикла вместо всего произведения, узкое название той же истории, персонаж вместо произведения — начни ровно с одной короткой фразы, что это было близко, словами игрока.',
        'Новое название не придумывай: верное имя только из эталона, следом.',
        'Несколько попыток не перечисляй: хватит одной, самой близкой.',
        'Созвучие и совсем другой ответ не упоминай: тогда этой фразы нет.',
        'Затем, или сразу если фразы про близость нет, произнеси правильный ответ: «Властелин колец».',
        'Другой ответ не придумывай.',
        'После ответа больше ничего не добавляй.',
        'Не говори, что кнопку не нажали, и не предлагай выбирать следующий.',
        'Не пересказывай задание.',
        'Не произноси названия тем и цены.',
      ].join(' '),
    )
    expect(line.indexOf('«Братство кольца»')).toBeLessThan(line.indexOf('«Властелин колец»'))
    expect(line).not.toContain('никто не нажал')
    expect(line).not.toContain('выбирайте следующий')
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
    expect(line.indexOf('«Властелин колец»')).toBeLessThan(line.indexOf('время на ответ вышло'))
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
    expect(line).toContain('верно')
    expect(line).not.toContain('Боевой Буратино')
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
    expect(line.toLowerCase()).not.toContain('номинал')
    expect(line).not.toContain('Реки')
    for (const value of [100, 200, 300, 400, 500]) {
      expect(line).not.toContain(String(value))
    }
    expect(hostInstructions).not.toContain('первом приветствии')
    expect(hostInstructions).toContain('Номиналы и цены вопросов не называй')
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
    expect(one).toContain('«Вася, фальстарт»')
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
    expect(two).toContain('«Ого, Маша и Вася, фальстарт»')
    expect(two).not.toContain('Боевой Буратино')
  })
})
