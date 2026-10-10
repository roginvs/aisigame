import { createActor } from 'xstate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gameConfig } from '../config.ts'
import { announceInstructions } from './controller.ts'
import { earlyBuzzerRoll } from './earlyBuzzer.ts'
import { closeGuessCoin, falseStartCoin, gameMachine, phoneticRetryReason, statePath } from './machine.ts'
import { nextInCell } from './pack.ts'
import { playersFromNames } from './players.ts'
import { demoPack } from './questions.ts'
import type { QuestionPack } from './types.ts'

function earlyMs(actor: ReturnType<typeof createActor<typeof gameMachine>>): number {
  return actor.getSnapshot().context.earlyLeftMs ?? gameConfig.earlyBuzzerMs
}

function reachReading() {
  const actor = createActor(gameMachine)
  actor.start()
  actor.send({ type: 'START_GAME', pack: demoPack })
  actor.send({ type: 'CONNECTED' })
  actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
  actor.send({ type: 'QUESTION_SELECTED', themeId: 'history', value: 100 })
  vi.advanceTimersByTime(gameConfig.cellFlashMs)
  return actor
}

function reachBuzzing() {
  const actor = createActor(gameMachine)
  actor.start()
  actor.send({ type: 'START_GAME', pack: demoPack })
  actor.send({ type: 'CONNECTED' })
  actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
  actor.send({ type: 'QUESTION_SELECTED', themeId: 'history', value: 100 })
  vi.advanceTimersByTime(gameConfig.cellFlashMs)
  actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
  return actor
}

function playerScore(actor: ReturnType<typeof reachBuzzing>, playerId: 1 | 2 | 3) {
  return actor.getSnapshot().context.players.find((player) => player.id === playerId)?.score
}

const originalFalseStartFlip = falseStartCoin.flip
const originalCloseGuessFlip = closeGuessCoin.flip
const originalEarlyUnit = earlyBuzzerRoll.unit

describe('game machine', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    earlyBuzzerRoll.unit = () => 0.5
  })
  afterEach(() => {
    falseStartCoin.flip = originalFalseStartFlip
    closeGuessCoin.flip = originalCloseGuessFlip
    earlyBuzzerRoll.unit = originalEarlyUnit
    vi.useRealTimers()
  })

  it('даёт право ответа только первому нажатию', () => {
    const actor = reachBuzzing()
    actor.send({ type: 'BUZZER_PRESSED', playerId: 2 })
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(actor.getSnapshot().context.falseStarts).toEqual({})
    expect(actor.getSnapshot().context.activePlayerId).toBe(2)
    expect(actor.getSnapshot().context.attemptId).toBe(1)
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
  })

  it('не меняет счёт, если верный статус пришёл с чужим id вопроса', () => {
    const actor = reachBuzzing()
    actor.send({ type: 'BUZZER_PRESSED', playerId: 2 })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'r0-t1-200-2',
        playerId: 2,
        attemptId: 1,
        status: 'correct',
        heard: 'Бетховен',
        reason: 'Лунная соната',
      },
    })
    expect(playerScore(actor, 2)).toBe(0)
    expect(statePath(actor.getSnapshot().value)).toBe('judging')
    expect(actor.getSnapshot().context.playedIds).not.toContain('history-100')
  })

  it('начисляет номинал за верный ответ и игнорирует чужую попытку', () => {
    const actor = reachBuzzing()
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'history-100',
        playerId: 1,
        attemptId: 1,
        status: 'correct',
        heard: 'Август',
        reason: 'смысл совпал',
      },
    })
    expect(playerScore(actor, 1)).toBe(100)
    expect(statePath(actor.getSnapshot().value)).toBe('announcing')

    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'space', value: 200 })
    vi.advanceTimersByTime(gameConfig.cellFlashMs)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    actor.send({ type: 'BUZZER_PRESSED', playerId: 3 })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'history-100',
        playerId: 1,
        attemptId: 1,
        status: 'correct',
        heard: 'поздно',
        reason: 'старая попытка',
      },
    })
    expect(playerScore(actor, 1)).toBe(100)
    expect(playerScore(actor, 3)).toBe(0)
    expect(statePath(actor.getSnapshot().value)).toBe('judging')
  })

  it('списывает номинал за неверный ответ', () => {
    const actor = reachBuzzing()
    actor.send({ type: 'BUZZER_PRESSED', playerId: 2 })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'history-100',
        playerId: 2,
        attemptId: 1,
        status: 'incorrect',
        heard: 'Цезарь',
        reason: 'другой человек',
      },
    })
    expect(playerScore(actor, 2)).toBe(-100)
    expect(actor.getSnapshot().context.playedIds).not.toContain('history-100')
    expect(actor.getSnapshot().context.missedIds).toEqual([2])
    expect(actor.getSnapshot().context.statusLine).toBe('Неверно')
    expect(statePath(actor.getSnapshot().value)).toBe('announcing')

    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    actor.send({ type: 'BUZZER_PRESSED', playerId: 2 })
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'history-100',
        playerId: 1,
        attemptId: 2,
        status: 'correct',
        heard: 'Август',
        reason: 'смысл совпал',
      },
    })
    expect(playerScore(actor, 1)).toBe(100)
    expect(playerScore(actor, 2)).toBe(-100)
    expect(actor.getSnapshot().context.playedIds).toContain('history-100')
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
  })

  it('созвучие просит того же игрока повторить, а второй раз списывает номинал', () => {
    const actor = reachBuzzing()
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'history-100',
        playerId: 1,
        attemptId: 1,
        status: 'near_miss',
        heard: 'Читов',
        reason: 'созвучно',
      },
    })
    expect(playerScore(actor, 1)).toBe(0)
    expect(actor.getSnapshot().context.playedIds).not.toContain('history-100')
    expect(actor.getSnapshot().context.missedIds).toEqual([])
    expect(actor.getSnapshot().context.announceKind).toBe('repeat')
    expect(actor.getSnapshot().context.statusLine).toBe('Повторите, пожалуйста')
    expect(actor.getSnapshot().context.chooserId).toBe(2)
    expect(actor.getSnapshot().context.activePlayerId).toBe(1)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    expect(actor.getSnapshot().context.activePlayerId).toBe(1)
    expect(actor.getSnapshot().context.attemptId).toBe(2)
    expect(actor.getSnapshot().context.phaseDurationMs).toBe(gameConfig.clarifyMs)

    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'history-100',
        playerId: 1,
        attemptId: 2,
        status: 'near_miss',
        heard: 'Читов',
        reason: 'снова созвучно',
      },
    })
    expect(playerScore(actor, 1)).toBe(-100)
    expect(actor.getSnapshot().context.missedIds).toEqual([1])
    expect(actor.getSnapshot().context.playedIds).not.toContain('history-100')
    expect(actor.getSnapshot().context.announceKind).toBe('incorrect')
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
  })

  it('называет ответ только когда ошиблись все', () => {
    const actor = reachBuzzing()
    const wrong = (playerId: 1 | 2 | 3, attemptId: number) => {
      actor.send({ type: 'BUZZER_PRESSED', playerId })
      actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
      actor.send({
        type: 'ANSWER_JUDGED',
        judgment: {
          questionId: 'history-100',
          playerId,
          attemptId,
          status: 'incorrect',
          heard: 'нет',
          reason: 'не то',
        },
      })
      actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    }
    wrong(1, 1)
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    wrong(3, 2)
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    wrong(2, 3)
    expect(actor.getSnapshot().context.playedIds).toContain('history-100')
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    expect(playerScore(actor, 1)).toBe(-100)
    expect(playerScore(actor, 2)).toBe(-100)
    expect(playerScore(actor, 3)).toBe(-100)
  })

  it('после неверного ответа снова открывает кнопку на 5 секунд', () => {
    const actor = reachBuzzing()
    expect(actor.getSnapshot().context.phaseDurationMs).toBe(gameConfig.buzzerMs)
    actor.send({ type: 'BUZZER_PRESSED', playerId: 2 })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'history-100',
        playerId: 2,
        attemptId: 1,
        status: 'incorrect',
        heard: 'Цезарь',
        reason: 'другой человек',
      },
    })
    expect(actor.getSnapshot().context.statusLine).toBe('Неверно')
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    expect(actor.getSnapshot().context.phaseDurationMs).toBe(gameConfig.stealBuzzerMs)
    vi.advanceTimersByTime(gameConfig.stealBuzzerMs - 1)
    expect(actor.getSnapshot().context.playedIds).not.toContain('history-100')
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    vi.advanceTimersByTime(1)
    expect(statePath(actor.getSnapshot().value)).toBe('announcing')
    expect(actor.getSnapshot().context.announceKind).toBe('nobody')
  })

  it('близкую ошибку помнит до закрытия ячейки и не говорит о ней, пока её можно перехватить', () => {
    let flips = 0
    closeGuessCoin.flip = () => {
      flips += 1
      return true
    }
    const actor = reachBuzzing()
    const heard = 'Братство кольца это, по-моему. Ну, Братство кольца, я же отвечаю, что это.'
    actor.send({ type: 'UNBUTTONED_TALK' })
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'history-100',
        playerId: 1,
        attemptId: 1,
        status: 'incorrect',
        heard,
        reason: 'часть вместо всего произведения',
      },
    })
    expect(playerScore(actor, 1)).toBe(-100)
    expect(actor.getSnapshot().context.playedIds).not.toContain('history-100')
    expect(actor.getSnapshot().context.announceKind).toBe('incorrect')
    expect(actor.getSnapshot().context.sayCloseGuess).toBe(false)
    expect(actor.getSnapshot().context.wrongHeard).toEqual([heard])
    expect(flips).toBe(0)
    const open = announceInstructions(actor.getSnapshot().context)
    expect(open).toContain('неверно')
    expect(open).toContain('минус 100')
    expect(open).not.toContain('Братство')
    expect(open).not.toContain('Август')

    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    expect(actor.getSnapshot().context.wrongHeard).toEqual([heard])
    expect(actor.getSnapshot().context.sayCloseGuess).toBe(false)

    vi.advanceTimersByTime(gameConfig.stealBuzzerMs)
    expect(actor.getSnapshot().context.announceKind).toBe('nobody')
    expect(actor.getSnapshot().context.sayCloseGuess).toBe(true)
    expect(flips).toBe(1)
    expect(playerScore(actor, 1)).toBe(-100)
    const revealed = announceInstructions(actor.getSnapshot().context)
    expect(revealed).toContain(heard)
    expect(revealed).toContain('Август')
    expect(revealed.indexOf('Братство кольца')).toBeLessThan(revealed.indexOf('Август'))
    expect(revealed).not.toContain('никто не нажал')

    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    expect(actor.getSnapshot().context.wrongHeard).toEqual([])
    expect(actor.getSnapshot().context.sayCloseGuess).toBe(false)
  })

  it('если монетка близости молчит, ответ называют как раньше', () => {
    closeGuessCoin.flip = () => false
    const actor = reachBuzzing()
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'history-100',
        playerId: 1,
        attemptId: 1,
        status: 'incorrect',
        heard: 'Братство кольца',
        reason: 'часть',
      },
    })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    vi.advanceTimersByTime(gameConfig.stealBuzzerMs)
    expect(actor.getSnapshot().context.announceKind).toBe('nobody')
    expect(actor.getSnapshot().context.sayCloseGuess).toBe(false)
    expect(actor.getSnapshot().context.wrongHeard).toEqual(['Братство кольца'])
    expect(playerScore(actor, 1)).toBe(-100)
    expect(announceInstructions(actor.getSnapshot().context)).not.toContain('Братство')
  })

  it('молчание и речь без кнопки монетку близости не бросают', () => {
    let flips = 0
    closeGuessCoin.flip = () => {
      flips += 1
      return true
    }
    const actor = reachBuzzing()
    actor.send({ type: 'UNBUTTONED_TALK' })
    vi.advanceTimersByTime(gameConfig.buzzerMs)
    expect(actor.getSnapshot().context.announceKind).toBe('nobody')
    expect(actor.getSnapshot().context.sayCloseGuess).toBe(false)
    expect(actor.getSnapshot().context.wrongHeard).toEqual([])
    expect(flips).toBe(0)
    expect(announceInstructions(actor.getSnapshot().context)).not.toContain('Попытки после кнопки')
  })

  it('созвучие не становится репликой про соседний заголовок', () => {
    let flips = 0
    closeGuessCoin.flip = () => {
      flips += 1
      return true
    }
    const actor = reachBuzzing()
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'history-100',
        playerId: 1,
        attemptId: 1,
        status: 'near_miss',
        heard: 'Читов',
        reason: 'созвучно',
      },
    })
    expect(actor.getSnapshot().context.wrongHeard).toEqual([])
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'history-100',
        playerId: 1,
        attemptId: 2,
        status: 'incorrect',
        heard: 'Читов',
        reason: phoneticRetryReason,
      },
    })
    expect(playerScore(actor, 1)).toBe(-100)
    expect(actor.getSnapshot().context.announceKind).toBe('incorrect')
    expect(actor.getSnapshot().context.wrongHeard).toEqual([])
    expect(actor.getSnapshot().context.sayCloseGuess).toBe(false)
    expect(flips).toBe(0)
    expect(announceInstructions(actor.getSnapshot().context)).not.toContain('Читов')
  })

  it('когда ошиблись все, монетка бросается один раз на объявлении ответа', () => {
    let flips = 0
    closeGuessCoin.flip = () => {
      flips += 1
      return true
    }
    const actor = reachBuzzing()
    const wrong = (playerId: 1 | 2 | 3, attemptId: number, heard: string) => {
      actor.send({ type: 'BUZZER_PRESSED', playerId })
      actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
      actor.send({
        type: 'ANSWER_JUDGED',
        judgment: {
          questionId: 'history-100',
          playerId,
          attemptId,
          status: 'incorrect' as const,
          heard,
          reason: 'не то',
        },
      })
    }
    wrong(1, 1, 'Братство кольца')
    expect(flips).toBe(0)
    expect(actor.getSnapshot().context.sayCloseGuess).toBe(false)
    expect(actor.getSnapshot().context.playedIds).not.toContain('history-100')
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    wrong(3, 2, 'Хоббит')
    expect(flips).toBe(0)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    wrong(2, 3, 'Сильмариллион')
    expect(flips).toBe(1)
    expect(actor.getSnapshot().context.sayCloseGuess).toBe(true)
    expect(actor.getSnapshot().context.announceKind).toBe('incorrect')
    expect(actor.getSnapshot().context.playedIds).toContain('history-100')
    expect(actor.getSnapshot().context.wrongHeard).toEqual(['Братство кольца', 'Хоббит', 'Сильмариллион'])
    expect(playerScore(actor, 1)).toBe(-100)
    expect(playerScore(actor, 2)).toBe(-100)
    expect(playerScore(actor, 3)).toBe(-100)
    const line = announceInstructions(actor.getSnapshot().context)
    expect(line).toContain('самой близкой')
    expect(line.indexOf('Братство кольца')).toBeLessThan(line.indexOf('что неверно'))
  })

  it('молчание последнего смотрит уже сказанные ошибки', () => {
    closeGuessCoin.flip = () => true
    const actor = reachBuzzing()
    const wrong = (playerId: 1 | 2, attemptId: number, heard: string) => {
      actor.send({ type: 'BUZZER_PRESSED', playerId })
      actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
      actor.send({
        type: 'ANSWER_JUDGED',
        judgment: {
          questionId: 'history-100',
          playerId,
          attemptId,
          status: 'incorrect' as const,
          heard,
          reason: 'не то',
        },
      })
      actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    }
    wrong(1, 1, 'Братство кольца')
    wrong(2, 2, 'Хоббит')
    actor.send({ type: 'BUZZER_PRESSED', playerId: 3 })
    vi.advanceTimersByTime(gameConfig.answerMs)
    expect(actor.getSnapshot().context.announceKind).toBe('silence')
    expect(actor.getSnapshot().context.playedIds).toContain('history-100')
    expect(actor.getSnapshot().context.sayCloseGuess).toBe(true)
    expect(actor.getSnapshot().context.wrongHeard).toEqual(['Братство кольца', 'Хоббит'])
    expect(playerScore(actor, 3)).toBe(-100)
    const line = announceInstructions(actor.getSnapshot().context)
    expect(line.indexOf('Братство кольца')).toBeLessThan(line.indexOf('время на ответ вышло'))
  })

  it('верный ответ чужую ошибку вслух не поднимает', () => {
    let flips = 0
    closeGuessCoin.flip = () => {
      flips += 1
      return true
    }
    const actor = reachBuzzing()
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'history-100',
        playerId: 1,
        attemptId: 1,
        status: 'incorrect',
        heard: 'Братство кольца',
        reason: 'не то',
      },
    })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    actor.send({ type: 'BUZZER_PRESSED', playerId: 2 })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'history-100',
        playerId: 2,
        attemptId: 2,
        status: 'correct',
        heard: 'Август',
        reason: 'смысл совпал',
      },
    })
    expect(playerScore(actor, 1)).toBe(-100)
    expect(playerScore(actor, 2)).toBe(100)
    expect(actor.getSnapshot().context.playedIds).toContain('history-100')
    expect(actor.getSnapshot().context.sayCloseGuess).toBe(false)
    expect(flips).toBe(0)
    expect(announceInstructions(actor.getSnapshot().context)).not.toContain('Братство')
  })

  it('речь без кнопки не останавливает десять секунд', () => {
    const actor = reachBuzzing()
    vi.advanceTimersByTime(8_000)
    actor.send({ type: 'UNBUTTONED_TALK' })
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    expect(actor.getSnapshot().context.spokeWithoutButton).toBe(true)
    vi.advanceTimersByTime(1_999)
    expect(actor.getSnapshot().context.playedIds).not.toContain('history-100')
    vi.advanceTimersByTime(1)
    expect(statePath(actor.getSnapshot().value)).toBe('announcing')
    expect(actor.getSnapshot().context.announceKind).toBe('nobody')
    expect(actor.getSnapshot().context.spokeWithoutButton).toBe(true)
  })

  it('после ошибки новое окно кнопки снова тихое', () => {
    const actor = reachBuzzing()
    actor.send({ type: 'UNBUTTONED_TALK' })
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'history-100',
        playerId: 1,
        attemptId: 1,
        status: 'incorrect',
        heard: 'нет',
        reason: 'не то',
      },
    })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    expect(actor.getSnapshot().context.spokeWithoutButton).toBe(false)
    expect(actor.getSnapshot().context.phaseDurationMs).toBe(gameConfig.stealBuzzerMs)
  })

  it('не меняет счёт, если кнопку никто не нажал', () => {
    const actor = reachBuzzing()
    vi.advanceTimersByTime(10_000)
    expect(playerScore(actor, 1)).toBe(0)
    expect(actor.getSnapshot().context.playedIds).toContain('history-100')
    expect(statePath(actor.getSnapshot().value)).toBe('announcing')
  })

  it('списывает номинал за молчание и не штрафует, если речь уже началась', () => {
    const silent = reachBuzzing()
    silent.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    vi.advanceTimersByTime(10_000)
    expect(playerScore(silent, 1)).toBe(-100)
    expect(silent.getSnapshot().context.statusLine).toBe('Время вышло')
    expect(silent.getSnapshot().context.playedIds).not.toContain('history-100')
    silent.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    expect(statePath(silent.getSnapshot().value)).toBe('buzzing.open')
    expect(silent.getSnapshot().context.phaseDurationMs).toBe(gameConfig.stealBuzzerMs)
    silent.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(silent.getSnapshot().context.activePlayerId).toBeNull()

    const speaking = reachBuzzing()
    speaking.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    speaking.send({ type: 'PLAYER_SPEECH_STARTED' })
    vi.advanceTimersByTime(10_000)
    expect(playerScore(speaking, 1)).toBe(0)
    expect(statePath(speaking.getSnapshot().value)).toBe('answering.hearing')
  })

  it('на паузе глушит ожидание и возвращает ту же фазу', () => {
    const actor = reachBuzzing()
    actor.send({ type: 'PAUSE', path: 'buzzing' })
    expect(statePath(actor.getSnapshot().value)).toBe('paused')
    vi.advanceTimersByTime(10_000)
    expect(actor.getSnapshot().context.playedIds).not.toContain('history-100')
    expect(statePath(actor.getSnapshot().value)).toBe('paused')

    actor.send({ type: 'RESUME' })
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    actor.send({ type: 'PAUSE', path: 'answering.waiting' })
    vi.advanceTimersByTime(10_000)
    expect(playerScore(actor, 1)).toBe(0)
    actor.send({ type: 'RESUME' })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    vi.advanceTimersByTime(10_000)
    expect(playerScore(actor, 1)).toBe(-100)
  })

  it('остановка гасит партию и не возвращает в меню', () => {
    const actor = reachBuzzing()
    actor.send({ type: 'STOP' })
    expect(statePath(actor.getSnapshot().value)).toBe('stopped')
    expect(actor.getSnapshot().context.statusLine).toBe('Остановлена')
    vi.advanceTimersByTime(10_000)
    expect(actor.getSnapshot().context.playedIds).not.toContain('history-100')
    expect(statePath(actor.getSnapshot().value)).toBe('stopped')
    actor.send({ type: 'RESUME' })
    actor.send({ type: 'PAUSE', path: 'buzzing' })
    expect(statePath(actor.getSnapshot().value)).toBe('stopped')
  })

  it('обрыв связи на уточнении уводит из партии, а не обратно к глухому выбору', () => {
    const actor = createActor(gameMachine)
    actor.start()
    actor.send({ type: 'START_GAME', pack: demoPack })
    actor.send({ type: 'CONNECTED' })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
    actor.send({
      type: 'QUESTION_UNCLEAR',
      reason: 'Не расслышала тему и стоимость. Повторите, пожалуйста.',
    })
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.clarifying')
    actor.send({ type: 'PLAYER_SPEECH_STARTED' })
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    actor.send({
      type: 'QUESTION_UNCLEAR',
      reason: 'Не расслышала тему и стоимость. Повторите, пожалуйста.',
    })
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.clarifying')
    actor.send({
      type: 'CONNECTION_LOST',
      message: 'Связь с ведущей прервалась. Начните игру ещё раз.',
    })
    expect(statePath(actor.getSnapshot().value)).toBe('failed')
    expect(actor.getSnapshot().context.error).toContain('прервалась')
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'clarify' })
    expect(statePath(actor.getSnapshot().value)).toBe('failed')
  })

  it('не открывает уже сыгранный вопрос', () => {
    const actor = reachBuzzing()
    vi.advanceTimersByTime(10_000)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'history', value: 100 })
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.clarifying')
  })

  it('после раунда открывает следующий, а в финале играет ставку', () => {
    const pack: QuestionPack = {
      name: 'Короткий',
      rounds: [
        { index: 0, name: 'Первый раунд', kind: 'normal' },
        { index: 1, name: 'Финал', kind: 'final' },
      ],
      warnings: [],
      questions: [
        {
          id: 'q1',
          roundIndex: 0,
          themeId: 'rivers',
          themeName: 'Реки',
          value: 100,
          text: 'Куда впадает Волга?',
          answers: ['Каспийское море'],
        },
        {
          id: 'final-1',
          roundIndex: 1,
          themeId: 'capitals',
          themeName: 'Столицы',
          value: 0,
          text: 'Столица Франции?',
          answers: ['Париж'],
        },
      ],
    }
    const actor = createActor(gameMachine)
    actor.start()
    actor.send({ type: 'START_GAME', pack })
    actor.send({ type: 'CONNECTED' })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'Реки', value: 100 })
    expect(statePath(actor.getSnapshot().value)).toBe('flashing')
    vi.advanceTimersByTime(gameConfig.cellFlashMs)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'q1',
        playerId: 1,
        attemptId: 1,
        status: 'correct',
        heard: 'Каспий',
        reason: 'верно',
      },
    })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    expect(statePath(actor.getSnapshot().value)).toBe('bridging')
    expect(actor.getSnapshot().context.roundIndex).toBe(1)

    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'bridge' })
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'Столицы', value: 0 })
    expect(statePath(actor.getSnapshot().value)).toBe('finalBets.asking')
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'bet' })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({ type: 'BET_PLACED', playerId: 1, amount: 40 })
    expect(statePath(actor.getSnapshot().value)).toBe('flashing')
    actor.send({ type: 'BUZZER_PRESSED', playerId: 2 })
    expect(statePath(actor.getSnapshot().value)).toBe('flashing')
    expect(actor.getSnapshot().context.falseStarts).toEqual({})
    vi.advanceTimersByTime(gameConfig.cellFlashMs)
    expect(statePath(actor.getSnapshot().value)).toBe('reading.sealed')
    vi.advanceTimersByTime(earlyMs(actor))
    expect(actor.getSnapshot().context.statusLine).toBe('Ведущая читает вопрос')
    expect(actor.getSnapshot().context.phaseStartedAt).toBeNull()
    expect(actor.getSnapshot().context.phaseDurationMs).toBeNull()
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('reading.sealed')
    expect(actor.getSnapshot().context.falseStarts).toEqual({})
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    expect(statePath(actor.getSnapshot().value)).toBe('turnCue')
    expect(actor.getSnapshot().context.activeStake).toBe(40)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'turn' })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'final-1',
        playerId: 1,
        attemptId: 2,
        status: 'correct',
        heard: 'Париж',
        reason: 'верно',
      },
    })
    expect(playerScore(actor, 1)).toBe(140)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    expect(statePath(actor.getSnapshot().value)).toBe('finished')
  })

  it('вопрос выбирает второй игрок, пока в раунде никто не ответил, затем последний ответивший', () => {
    const actor = createActor(gameMachine)
    actor.start()
    actor.send({ type: 'START_GAME', pack: demoPack })
    actor.send({ type: 'CONNECTED' })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    expect(actor.getSnapshot().context.chooserId).toBe(2)
    expect(actor.getSnapshot().context.statusLine).toBe('назовите тему и стоимость')
    actor.send({ type: 'BUZZER_PRESSED', playerId: 2 })
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    expect(actor.getSnapshot().context.falseStarts).toEqual({})

    actor.send({ type: 'QUESTION_SELECTED', themeId: 'history', value: 100 })
    vi.advanceTimersByTime(gameConfig.cellFlashMs)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    vi.advanceTimersByTime(gameConfig.buzzerMs)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    expect(actor.getSnapshot().context.chooserId).toBe(2)

    actor.send({ type: 'QUESTION_SELECTED', themeId: 'history', value: 200 })
    vi.advanceTimersByTime(gameConfig.cellFlashMs)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    actor.send({ type: 'BUZZER_PRESSED', playerId: 3 })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'history-200',
        playerId: 3,
        attemptId: 1,
        status: 'incorrect',
        heard: 'нет',
        reason: 'не то',
      },
    })
    expect(actor.getSnapshot().context.chooserId).toBe(3)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    actor.send({ type: 'BUZZER_PRESSED', playerId: 2 })
    vi.advanceTimersByTime(gameConfig.answerMs)
    expect(actor.getSnapshot().context.chooserId).toBe(2)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'history-200',
        playerId: 1,
        attemptId: 3,
        status: 'correct',
        heard: '476',
        reason: 'верно',
      },
    })
    expect(actor.getSnapshot().context.chooserId).toBe(1)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    expect(actor.getSnapshot().context.chooserId).toBe(1)
  })

  it('в начале следующего раунда, включая выбор темы финала, снова выбирает второй игрок', () => {
    const pack: QuestionPack = {
      name: 'Два раунда',
      rounds: [
        { index: 0, name: 'Первый раунд', kind: 'normal' },
        { index: 1, name: 'Финал', kind: 'final' },
      ],
      warnings: [],
      questions: [
        {
          id: 'q1',
          roundIndex: 0,
          themeId: 'rivers',
          themeName: 'Реки',
          value: 100,
          text: 'Куда впадает Волга?',
          answers: ['Каспийское море'],
        },
        {
          id: 'final-1',
          roundIndex: 1,
          themeId: 'capitals',
          themeName: 'Столицы',
          value: 0,
          text: 'Столица Франции?',
          answers: ['Париж'],
        },
      ],
    }
    const actor = createActor(gameMachine)
    actor.start()
    actor.send({ type: 'START_GAME', pack })
    actor.send({ type: 'CONNECTED' })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
    expect(actor.getSnapshot().context.chooserId).toBe(2)
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'Реки', value: 100 })
    vi.advanceTimersByTime(gameConfig.cellFlashMs)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'q1',
        playerId: 1,
        attemptId: 1,
        status: 'correct',
        heard: 'Каспий',
        reason: 'верно',
      },
    })
    expect(actor.getSnapshot().context.chooserId).toBe(1)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    expect(statePath(actor.getSnapshot().value)).toBe('bridging')
    expect(actor.getSnapshot().context.chooserId).toBe(2)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'bridge' })
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    expect(actor.getSnapshot().context.roundIndex).toBe(1)
    expect(actor.getSnapshot().context.chooserId).toBe(2)
    expect(actor.getSnapshot().context.statusLine).toBe('Выберите тему финала')
  })

  it('пока не прошло раннее окно, кнопка ещё фальстарт, потом принимает игрока', () => {
    const actor = reachReading()
    expect(statePath(actor.getSnapshot().value)).toBe('reading.sealed')
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('reading.sealed')
    vi.advanceTimersByTime(earlyMs(actor) - 1)
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('reading.sealed')
    expect(actor.getSnapshot().context.phaseStartedAt).toBeNull()
    vi.advanceTimersByTime(1)
    expect(statePath(actor.getSnapshot().value)).toBe('reading.armed')
    expect(actor.getSnapshot().context.statusLine).toBe('Жмите свою кнопку')
    expect(actor.getSnapshot().context.phaseDurationMs).toBe(gameConfig.buzzerMs)
    expect(actor.getSnapshot().context.phaseStartedAt).toEqual(expect.any(Number))
    actor.send({ type: 'BUZZER_PRESSED', playerId: 2 })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    expect(actor.getSnapshot().context.activePlayerId).toBe(2)
  })

  it('длинное чтение закрывает ячейку, когда десять секунд после ранней кнопки вышли', () => {
    const actor = reachReading()
    vi.advanceTimersByTime(earlyMs(actor))
    expect(statePath(actor.getSnapshot().value)).toBe('reading.armed')
    vi.advanceTimersByTime(gameConfig.buzzerMs - 1)
    expect(statePath(actor.getSnapshot().value)).toBe('reading.armed')
    expect(actor.getSnapshot().context.playedIds).not.toContain('history-100')
    vi.advanceTimersByTime(1)
    expect(statePath(actor.getSnapshot().value)).toBe('announcing')
    expect(actor.getSnapshot().context.announceKind).toBe('nobody')
    expect(actor.getSnapshot().context.playedIds).toContain('history-100')
  })

  it('дочитанная фраза не обнуляет уже идущую полоску', () => {
    falseStartCoin.flip = () => {
      throw new Error('окно уже идёт')
    }
    const actor = reachReading()
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    vi.advanceTimersByTime(earlyMs(actor))
    const startedAt = actor.getSnapshot().context.phaseStartedAt
    expect(startedAt).toEqual(expect.any(Number))
    vi.advanceTimersByTime(3_000)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    expect(actor.getSnapshot().context.phaseStartedAt).toBe(startedAt)
    expect(actor.getSnapshot().context.phaseDurationMs).toBe(gameConfig.buzzerMs)
    expect(actor.getSnapshot().context.sayFalseStart).toBe(false)
    vi.advanceTimersByTime(gameConfig.buzzerMs - 3_000 - 1)
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    vi.advanceTimersByTime(1)
    expect(actor.getSnapshot().context.announceKind).toBe('nobody')
    expect(actor.getSnapshot().context.playedIds).toContain('history-100')
  })

  it('если чтение кончилось раньше, кнопка открывается на обычные 10 секунд', () => {
    const actor = reachReading()
    vi.advanceTimersByTime(1_000)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    expect(actor.getSnapshot().context.phaseDurationMs).toBe(gameConfig.buzzerMs)
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    expect(actor.getSnapshot().context.activePlayerId).toBe(1)
  })

  it('пауза замораживает раннюю кнопку и продолжает остаток', () => {
    const actor = reachReading()
    vi.advanceTimersByTime(1_000)
    actor.send({ type: 'PAUSE', path: 'reading.sealed' })
    vi.advanceTimersByTime(earlyMs(actor))
    expect(statePath(actor.getSnapshot().value)).toBe('paused')
    actor.send({ type: 'RESUME' })
    expect(statePath(actor.getSnapshot().value)).toBe('reading.sealed')
    vi.advanceTimersByTime(1_000)
    actor.send({ type: 'PAUSE', path: statePath(actor.getSnapshot().value) })
    vi.advanceTimersByTime(earlyMs(actor))
    actor.send({ type: 'RESUME' })
    expect(statePath(actor.getSnapshot().value)).toBe('reading.sealed')
    const left = earlyMs(actor)
    vi.advanceTimersByTime(left - 1)
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('reading.sealed')
    vi.advanceTimersByTime(1)
    expect(statePath(actor.getSnapshot().value)).toBe('reading.armed')
    actor.send({ type: 'PAUSE', path: 'reading.armed' })
    actor.send({ type: 'RESUME' })
    expect(statePath(actor.getSnapshot().value)).toBe('reading.armed')
    expect(actor.getSnapshot().context.statusLine).toBe('Жмите свою кнопку')
    expect(actor.getSnapshot().context.phaseDurationMs).toBe(gameConfig.buzzerMs)
    expect(actor.getSnapshot().context.phaseStartedAt).toEqual(expect.any(Number))
    actor.send({ type: 'BUZZER_PRESSED', playerId: 3 })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    expect(actor.getSnapshot().context.activePlayerId).toBe(3)
  })

  it('остановка на чтении гасит раннюю кнопку', () => {
    const actor = reachReading()
    vi.advanceTimersByTime(1_000)
    actor.send({ type: 'STOP' })
    vi.advanceTimersByTime(gameConfig.earlyBuzzerMaxMs)
    expect(statePath(actor.getSnapshot().value)).toBe('stopped')
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('stopped')
  })

  it('пока ячейка моргает, кнопка не открывается', () => {
    const actor = createActor(gameMachine)
    actor.start()
    actor.send({ type: 'START_GAME', pack: demoPack })
    actor.send({ type: 'CONNECTED' })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'history', value: 100 })
    expect(statePath(actor.getSnapshot().value)).toBe('flashing')
    vi.advanceTimersByTime(gameConfig.cellFlashMs - 1)
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('flashing')
    expect(actor.getSnapshot().context.falseStarts[1]).toEqual(expect.any(Number))
    expect(actor.getSnapshot().context.falseStarts[2]).toBeUndefined()
    expect(actor.getSnapshot().context.activePlayerId).toBeNull()
    expect(actor.getSnapshot().context.missedIds).toEqual([])
    expect(playerScore(actor, 1)).toBe(0)
  })

  it('до ранней кнопки нажатие — фальстарт, после неё — обычный ответ', () => {
    const actor = reachReading()
    expect(statePath(actor.getSnapshot().value)).toBe('reading.sealed')
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    const markedAt = actor.getSnapshot().context.falseStarts[1]
    expect(statePath(actor.getSnapshot().value)).toBe('reading.sealed')
    expect(markedAt).toEqual(expect.any(Number))
    expect(actor.getSnapshot().context.falseStarts[2]).toBeUndefined()
    expect(actor.getSnapshot().context.activePlayerId).toBeNull()
    expect(actor.getSnapshot().context.missedIds).toEqual([])
    expect(actor.getSnapshot().context.attemptId).toBe(0)
    expect(playerScore(actor, 1)).toBe(0)

    actor.send({ type: 'BUZZER_PRESSED', playerId: 3 })
    expect(actor.getSnapshot().context.falseStarts[1]).toBe(markedAt)
    expect(actor.getSnapshot().context.falseStarts[3]).toEqual(expect.any(Number))
    expect(statePath(actor.getSnapshot().value)).toBe('reading.sealed')

    vi.advanceTimersByTime(earlyMs(actor))
    expect(statePath(actor.getSnapshot().value)).toBe('reading.armed')
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    expect(actor.getSnapshot().context.activePlayerId).toBe(1)
    expect(actor.getSnapshot().context.falseStarts[1]).toBe(markedAt)
    expect(actor.getSnapshot().context.missedIds).toEqual([])
    expect(playerScore(actor, 1)).toBe(0)
  })

  it('после фальстарта эта кнопка молчит две с половиной секунды, чужая живая', () => {
    expect(gameConfig.falseStartMs).toBe(2_500)
    const actor = reachReading()
    vi.advanceTimersByTime(earlyMs(actor) - 1_000)
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    const markedAt = actor.getSnapshot().context.falseStarts[1]
    vi.advanceTimersByTime(400)
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(actor.getSnapshot().context.falseStarts[1]).toBe(markedAt)
    vi.advanceTimersByTime(600)
    expect(statePath(actor.getSnapshot().value)).toBe('reading.armed')
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('reading.armed')
    expect(actor.getSnapshot().context.activePlayerId).toBeNull()
    actor.send({ type: 'BUZZER_PRESSED', playerId: 2 })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    expect(actor.getSnapshot().context.activePlayerId).toBe(2)
  })

  it('когда вспышка погасла, тот же игрок может отвечать', () => {
    const actor = reachReading()
    vi.advanceTimersByTime(earlyMs(actor) - 400)
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    vi.advanceTimersByTime(400)
    expect(statePath(actor.getSnapshot().value)).toBe('reading.armed')
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('reading.armed')
    vi.advanceTimersByTime(gameConfig.falseStartMs - 400)
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    expect(actor.getSnapshot().context.activePlayerId).toBe(1)
  })

  it('пауза не съедает штраф фальстарта', () => {
    const actor = reachReading()
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    vi.advanceTimersByTime(500)
    const markedAt = actor.getSnapshot().context.falseStarts[1]
    actor.send({ type: 'PAUSE', path: 'reading.sealed' })
    vi.advanceTimersByTime(10_000)
    actor.send({ type: 'RESUME' })
    const shifted = actor.getSnapshot().context.falseStarts[1]
    expect(shifted).toBeGreaterThan(markedAt ?? 0)
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(actor.getSnapshot().context.falseStarts[1]).toBe(shifted)
    expect(statePath(actor.getSnapshot().value)).toBe('reading.sealed')
    vi.advanceTimersByTime(gameConfig.falseStartMs - 500)
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(actor.getSnapshot().context.falseStarts[1]).not.toBe(shifted)
    expect(statePath(actor.getSnapshot().value)).toBe('reading.sealed')
  })

  it('«Следующий раунд» в середине раунда оставляет счёт и открывает следующий', () => {
    const pack: QuestionPack = {
      name: 'Два раунда',
      rounds: [
        { index: 0, name: 'Первый раунд', kind: 'normal' },
        { index: 1, name: 'Второй раунд', kind: 'normal' },
      ],
      warnings: [],
      questions: [
        {
          id: 'q1',
          roundIndex: 0,
          themeId: 'rivers',
          themeName: 'Реки',
          value: 100,
          text: 'Куда впадает Волга?',
          answers: ['Каспийское море'],
        },
        {
          id: 'q2',
          roundIndex: 0,
          themeId: 'rivers',
          themeName: 'Реки',
          value: 200,
          text: 'Самая длинная река?',
          answers: ['Нил'],
        },
        {
          id: 'q3',
          roundIndex: 1,
          themeId: 'capitals',
          themeName: 'Столицы',
          value: 100,
          text: 'Столица Франции?',
          answers: ['Париж'],
        },
      ],
    }
    const actor = createActor(gameMachine)
    actor.start()
    actor.send({ type: 'START_GAME', pack })
    actor.send({ type: 'CONNECTED' })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'Реки', value: 100 })
    vi.advanceTimersByTime(gameConfig.cellFlashMs)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'q1',
        playerId: 1,
        attemptId: 1,
        status: 'correct',
        heard: 'Каспий',
        reason: 'верно',
      },
    })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    expect(playerScore(actor, 1)).toBe(100)

    actor.send({ type: 'QUESTION_SELECTED', themeId: 'Реки', value: 200 })
    vi.advanceTimersByTime(gameConfig.cellFlashMs)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    actor.send({ type: 'BUZZER_PRESSED', playerId: 2 })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    expect(actor.getSnapshot().context.activeQuestionId).toBe('q2')

    actor.send({ type: 'NEXT_ROUND' })
    expect(statePath(actor.getSnapshot().value)).toBe('bridging')
    expect(actor.getSnapshot().context.roundIndex).toBe(1)
    expect(playerScore(actor, 1)).toBe(100)
    expect(playerScore(actor, 2)).toBe(0)
    expect(actor.getSnapshot().context.playedIds).toEqual(['q1'])
    expect(actor.getSnapshot().context.activeQuestionId).toBeNull()
    expect(actor.getSnapshot().context.activePlayerId).toBeNull()
    expect(actor.getSnapshot().context.missedIds).toEqual([])
    expect(actor.getSnapshot().context.heard).toBe('')

    actor.send({ type: 'NEXT_ROUND' })
    expect(statePath(actor.getSnapshot().value)).toBe('finished')
    expect(actor.getSnapshot().context.roundIndex).toBe(1)
    expect(playerScore(actor, 1)).toBe(100)
    expect(actor.getSnapshot().context.playedIds).toEqual(['q1'])
    actor.send({ type: 'NEXT_ROUND' })
    expect(statePath(actor.getSnapshot().value)).toBe('finished')
    expect(actor.getSnapshot().context.roundIndex).toBe(1)
  })

  it('остановленная партия не открывает новый раунд', () => {
    const actor = reachBuzzing()
    actor.send({ type: 'STOP' })
    actor.send({ type: 'NEXT_ROUND' })
    expect(statePath(actor.getSnapshot().value)).toBe('stopped')
    expect(actor.getSnapshot().context.roundIndex).toBe(0)
    expect(playerScore(actor, 1)).toBe(0)
  })

  it('продолжает партию со счётом и открытым вопросом, а новая игра по-прежнему с приветствия', () => {
    const actor = createActor(gameMachine)
    actor.start()
    actor.send({
      type: 'CONTINUE_GAME',
      pack: demoPack,
      saved: {
        players: [
          { id: 1, name: 'Игрок 1', score: 100 },
          { id: 2, name: 'Левый', score: -50 },
          { id: 3, name: 'Игрок 3', score: 0 },
        ],
        roundIndex: 0,
        playedIds: ['history-200'],
        missedIds: [1],
        chooserId: 1,
        finalists: [],
        bets: [],
        finalCursor: 0,
        betMisses: 0,
        activeQuestionId: 'history-100',
        activePlayerId: null,
        activeStake: null,
        attemptId: 2,
        clarifications: 0,
        heard: '',
        wrongHeard: [],
        sayCloseGuess: false,
        announceKind: null,
        judgmentStatus: null,
        phase: 'buzzing.reminding',
      },
    })
    expect(statePath(actor.getSnapshot().value)).toBe('connecting')
    actor.send({ type: 'CONNECTED' })
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    expect(playerScore(actor, 1)).toBe(100)
    expect(playerScore(actor, 2)).toBe(-50)
    expect(actor.getSnapshot().context.playedIds).toEqual(['history-200'])
    expect(actor.getSnapshot().context.chooserId).toBe(1)
    expect(actor.getSnapshot().context.missedIds).toEqual([1])
    expect(actor.getSnapshot().context.activeQuestionId).toBe('history-100')
    expect(actor.getSnapshot().context.resumePath).toBe('')
    expect(actor.getSnapshot().context.phaseDurationMs).toBe(gameConfig.stealBuzzerMs)

    const fresh = createActor(gameMachine)
    fresh.start()
    fresh.send({ type: 'START_GAME', pack: demoPack })
    fresh.send({ type: 'CONNECTED' })
    expect(statePath(fresh.getSnapshot().value)).toBe('welcoming')
    expect(playerScore(fresh, 1)).toBe(0)
  })

  it('окно фальстарта — earlyLeftMs по длине вопроса, потом живые часы кнопки', () => {
    expect(gameConfig.earlyBuzzerMinMs).toBe(3_000)
    expect(gameConfig.earlyBuzzerMaxMs).toBe(8_000)
    const actor = reachReading()
    const sealed = earlyMs(actor)
    expect(sealed).toBeGreaterThanOrEqual(gameConfig.earlyBuzzerMinMs)
    expect(sealed).toBeLessThanOrEqual(gameConfig.earlyBuzzerMaxMs)
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('reading.sealed')
    expect(actor.getSnapshot().context.falseStarts[1]).toEqual(expect.any(Number))
    expect(playerScore(actor, 1)).toBe(0)
    vi.advanceTimersByTime(sealed - 1)
    actor.send({ type: 'BUZZER_PRESSED', playerId: 2 })
    expect(statePath(actor.getSnapshot().value)).toBe('reading.sealed')
    vi.advanceTimersByTime(1)
    expect(statePath(actor.getSnapshot().value)).toBe('reading.armed')
    expect(actor.getSnapshot().context.statusLine).toBe('Жмите свою кнопку')
    expect(actor.getSnapshot().context.phaseDurationMs).toBe(gameConfig.buzzerMs)
    expect(actor.getSnapshot().context.phaseStartedAt).toEqual(expect.any(Number))
    actor.send({ type: 'BUZZER_PRESSED', playerId: 2 })
    expect(statePath(actor.getSnapshot().value)).toBe('reading.armed')
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    expect(actor.getSnapshot().context.activePlayerId).toBe(1)
  })

  it('речь поверх чтения не обрывает его и остаётся к напоминанию, что кнопку не нажали', () => {
    const actor = reachReading()
    actor.send({ type: 'TALKED_OVER' })
    expect(statePath(actor.getSnapshot().value)).toBe('reading.sealed')
    expect(actor.getSnapshot().context.talkedDuringRead).toBe(true)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    expect(actor.getSnapshot().context.talkedDuringRead).toBe(true)
    vi.advanceTimersByTime(gameConfig.buzzerMs)
    expect(actor.getSnapshot().context.announceKind).toBe('nobody')
    expect(actor.getSnapshot().context.talkedDuringRead).toBe(true)
    expect(actor.getSnapshot().context.spokeWithoutButton).toBe(false)
  })

  it('тихое окно кнопки не помечает речь без кнопки', () => {
    const actor = reachBuzzing()
    vi.advanceTimersByTime(gameConfig.buzzerMs)
    expect(actor.getSnapshot().context.announceKind).toBe('nobody')
    expect(actor.getSnapshot().context.talkedDuringRead).toBe(false)
    expect(actor.getSnapshot().context.spokeWithoutButton).toBe(false)
  })

  it('монетка решает, съест ли реплика про фальстарт десять секунд', () => {
    falseStartCoin.flip = () => true
    const spoken = reachReading()
    spoken.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    spoken.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    expect(statePath(spoken.getSnapshot().value)).toBe('falseStartCue')
    expect(spoken.getSnapshot().context.phaseStartedAt).toBeNull()
    expect(spoken.getSnapshot().context.sayFalseStart).toBe(true)
    vi.advanceTimersByTime(gameConfig.buzzerMs)
    expect(spoken.getSnapshot().context.playedIds).not.toContain('history-100')
    spoken.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'falseStart' })
    expect(statePath(spoken.getSnapshot().value)).toBe('buzzing.open')
    expect(spoken.getSnapshot().context.phaseDurationMs).toBe(gameConfig.buzzerMs)

    falseStartCoin.flip = () => false
    const quiet = reachReading()
    quiet.send({ type: 'BUZZER_PRESSED', playerId: 2 })
    quiet.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    expect(statePath(quiet.getSnapshot().value)).toBe('buzzing.open')
    expect(quiet.getSnapshot().context.phaseDurationMs).toBe(gameConfig.buzzerMs)
    expect(quiet.getSnapshot().context.sayFalseStart).toBe(false)
  })

  it('без фальстарта монетку не бросает и сразу открывает десять секунд', () => {
    falseStartCoin.flip = () => {
      throw new Error('монетку бросать не за чем')
    }
    const actor = reachReading()
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    expect(actor.getSnapshot().context.phaseDurationMs).toBe(gameConfig.buzzerMs)
  })

  it('держит сколько угодно игроков: в начале раунда выбирает второго, очки пишутся четвёртому', () => {
    const players = playersFromNames('Анна\n\nБорис\nВера\nГлеб')
    expect(players.map((player) => player.name)).toEqual(['Анна', 'Борис', 'Вера', 'Глеб'])
    const actor = createActor(gameMachine)
    actor.start()
    actor.send({ type: 'START_GAME', pack: demoPack, players })
    actor.send({ type: 'CONNECTED' })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
    expect(actor.getSnapshot().context.chooserId).toBe(2)
    expect(actor.getSnapshot().context.players).toHaveLength(4)
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'history', value: 100 })
    vi.advanceTimersByTime(gameConfig.cellFlashMs)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    actor.send({ type: 'BUZZER_PRESSED', playerId: 4 })
    expect(actor.getSnapshot().context.activePlayerId).toBe(4)
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'history-100',
        playerId: 4,
        attemptId: 1,
        status: 'correct',
        heard: 'Август',
        reason: 'верно',
      },
    })
    expect(actor.getSnapshot().context.players.find((player) => player.id === 4)?.score).toBe(100)
    expect(actor.getSnapshot().context.chooserId).toBe(4)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    expect(actor.getSnapshot().context.chooserId).toBe(4)

    const solo = createActor(gameMachine)
    solo.start()
    solo.send({ type: 'START_GAME', pack: demoPack, players: playersFromNames('Один') })
    expect(solo.getSnapshot().context.players).toEqual([{ id: 1, name: 'Один', score: 0 }])
    expect(solo.getSnapshot().context.chooserId).toBe(1)
    solo.send({ type: 'CONNECTED' })
    solo.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
    solo.send({ type: 'QUESTION_SELECTED', themeId: 'history', value: 100 })
    expect(statePath(solo.getSnapshot().value)).toBe('flashing')
    solo.send({ type: 'BUZZER_PRESSED', playerId: 2 })
    expect(solo.getSnapshot().context.falseStarts).toEqual({})
    expect(statePath(solo.getSnapshot().value)).toBe('flashing')
  })

  it('просьба выбрать ячейку не начинается с номера раунда или игрока', () => {
    const pack: QuestionPack = {
      name: 'Номера',
      rounds: [
        { index: 0, name: '2', kind: 'normal' },
        { index: 1, name: '1', kind: 'final' },
      ],
      warnings: [],
      questions: [
        {
          id: 'q1',
          roundIndex: 0,
          themeId: 'rivers',
          themeName: 'Реки',
          value: 100,
          text: 'Куда впадает Волга?',
          answers: ['Каспийское море'],
        },
        {
          id: 'final-1',
          roundIndex: 1,
          themeId: 'capitals',
          themeName: 'Столицы',
          value: 0,
          text: 'Столица Франции?',
          answers: ['Париж'],
        },
      ],
    }
    const actor = createActor(gameMachine)
    actor.start()
    actor.send({ type: 'START_GAME', pack, players: playersFromNames('Один') })
    actor.send({ type: 'CONNECTED' })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
    expect(actor.getSnapshot().context.chooserId).toBe(1)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    expect(actor.getSnapshot().context.statusLine).toBe('назовите тему и стоимость')

    actor.send({ type: 'QUESTION_SELECTED', themeId: 'Реки', value: 100 })
    vi.advanceTimersByTime(gameConfig.cellFlashMs)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'q1',
        playerId: 1,
        attemptId: 1,
        status: 'correct',
        heard: 'Каспий',
        reason: 'верно',
      },
    })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'bridge' })
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    expect(actor.getSnapshot().context.statusLine).toBe('Выберите тему финала')
  })

  it('держит ячейку темы и номинала, пока в стопке есть несыгранный вопрос', () => {
    const pack: QuestionPack = {
      name: 'Стопка',
      rounds: [{ index: 0, name: 'Разогрев', kind: 'normal' }],
      warnings: [],
      questions: [
        {
          id: 'r0-t0-100-0',
          roundIndex: 0,
          themeId: 'r0-t0',
          themeName: 'Тема 1',
          value: 100,
          text: 'Первый',
          answers: ['да'],
        },
        {
          id: 'r0-t0-100-2',
          roundIndex: 0,
          themeId: 'r0-t0',
          themeName: 'Тема 1',
          value: 100,
          text: 'Третий',
          answers: ['да'],
        },
        {
          id: 'r0-t1-100-0',
          roundIndex: 0,
          themeId: 'r0-t1',
          themeName: 'Тема 2',
          value: 100,
          text: 'Другая тема',
          answers: ['да'],
        },
      ],
    }
    const actor = createActor(gameMachine)
    actor.start()
    actor.send({ type: 'START_GAME', pack })
    actor.send({ type: 'CONNECTED' })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })

    actor.send({ type: 'QUESTION_SELECTED', themeId: 'Тема 1', value: 100 })
    expect(actor.getSnapshot().context.activeQuestionId).toBe('r0-t0-100-0')
    closeStack(actor, 'r0-t0-100-0')
    const afterFirst = actor.getSnapshot().context.playedIds
    expect(afterFirst).toEqual(['r0-t0-100-0'])
    expect(nextInCell(pack.questions, 0, 'r0-t0', 100, afterFirst)?.id).toBe('r0-t0-100-2')
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')

    actor.send({ type: 'QUESTION_SELECTED', themeId: 'r0-t0', value: 100 })
    expect(actor.getSnapshot().context.activeQuestionId).toBe('r0-t0-100-2')
    closeStack(actor, 'r0-t0-100-2')
    const afterStack = actor.getSnapshot().context.playedIds
    expect(afterStack).toEqual(['r0-t0-100-0', 'r0-t0-100-2'])
    expect(nextInCell(pack.questions, 0, 'r0-t0', 100, afterStack)).toBeUndefined()
    expect(nextInCell(pack.questions, 0, 'r0-t1', 100, afterStack)?.id).toBe('r0-t1-100-0')

    actor.send({ type: 'QUESTION_SELECTED', themeId: 'Тема 1', value: 100 })
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.clarifying')
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'clarify' })
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'Тема 2', value: 100 })
    expect(actor.getSnapshot().context.activeQuestionId).toBe('r0-t1-100-0')
  })
})

function closeStack(actor: ReturnType<typeof reachBuzzing>, questionId: string) {
  vi.advanceTimersByTime(gameConfig.cellFlashMs)
  actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
  actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
  const attemptId = actor.getSnapshot().context.attemptId
  actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
  actor.send({
    type: 'ANSWER_JUDGED',
    judgment: {
      questionId,
      playerId: 1,
      attemptId,
      status: 'correct',
      heard: 'да',
      reason: 'совпало',
    },
  })
  actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
}
