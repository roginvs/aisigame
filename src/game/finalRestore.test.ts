import { createActor } from 'xstate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gameConfig } from '../config.ts'
import { buildConferenceSnapshot } from '../conference/buildSnapshot.ts'
import { gameMachine, statePath } from './machine.ts'
import { persistMatch, readSavedGame } from './savedGame.ts'
import type { QuestionPack } from './types.ts'

function memory(): Storage {
  const data = new Map<string, string>()
  return {
    get length() { return data.size },
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
    removeItem: (key) => { data.delete(key) },
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
  }
}

const pack: QuestionPack = {
  name: 'Восстановление финала', rounds: [{ index: 0, name: 'Финал', kind: 'final' }], warnings: [],
  questions: [
    { id: 'f1', roundIndex: 0, themeId: 't', themeName: 'Столица', value: 0, text: 'Столица Франции?', answers: ['Париж'] },
    { id: 'f2', roundIndex: 0, themeId: 'x', themeName: 'Другая', value: 0, text: 'Вопрос?', answers: ['Ответ'] },
  ],
}

describe('финал: машина → снимки → восстановленная машина', () => {
  afterEach(() => vi.useRealTimers())

  it('последовательно продолжает скрытый ввод и каждый шаг разбора без потери данных и повторного начисления', () => {
    vi.useFakeTimers()
    const storage = memory()
    let actor = createActor(gameMachine).start()
    const path = () => statePath(actor.getSnapshot().value)
    const roundTrip = () => {
      const before = actor.getSnapshot().context
      const phase = path()
      const display = buildConferenceSnapshot({ phase, context: before, pack: null, roster: [], timerRemainingMs: null, falseStartIds: [] })
      persistMatch({ packId: 'test-final', packFile: '', path: phase, context: before, conference: { mode: 'conference', roomId: 'final-room' } }, storage)
      const saved = readSavedGame(storage)
      expect(saved).not.toBeNull()
      if (!saved) throw new Error('Финал не сохранился')
      actor.stop()
      actor = createActor(gameMachine).start()
      actor.send({ type: 'CONTINUE_GAME', pack, saved })
      actor.send({ type: 'CONNECTED' })
      expect(path()).toBe(phase)
      const after = actor.getSnapshot().context
      expect(after.players).toEqual(before.players)
      expect(after.bets).toEqual(before.bets)
      expect(after.typedAnswers).toEqual(before.typedAnswers)
      expect(after.struckThemes).toEqual(before.struckThemes)
      expect(after.stakeShownIds).toEqual(before.stakeShownIds)
      if (phase.startsWith('finalReveal.') && phase !== 'finalReveal.look') expect(after.judgmentStatus).toBe(before.judgmentStatus)
      const restoredDisplay = buildConferenceSnapshot({ phase: path(), context: after, pack: null, roster: [], timerRemainingMs: null, falseStartIds: [] })
      expect(restoredDisplay.typedAnswers).toEqual(display.typedAnswers)
      expect(restoredDisplay.stakes).toEqual(display.stakes)
    }

    actor.send({ type: 'START_GAME', pack, players: [1, 2, 3].map((id) => ({ id, name: `Игрок ${id}`, score: 100 })) })
    actor.send({ type: 'CONNECTED' })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
    actor.send({ type: 'STRIKE_THEME', playerId: 2, themeId: 'x' })
    roundTrip()
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'finalIntro' })
    actor.send({ type: 'FINAL_STAKE', playerId: 1, amount: 50 })
    roundTrip()
    actor.send({ type: 'FINAL_STAKE', playerId: 2, amount: 40 })
    actor.send({ type: 'FINAL_STAKE', playerId: 3, amount: 30 })
    vi.advanceTimersByTime(gameConfig.cellFlashMs)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'turn' })
    actor.send({ type: 'FINAL_TYPED', playerId: 3, text: 'Лондон' })
    roundTrip()
    actor.send({ type: 'FINAL_TYPED', playerId: 1, text: 'Париж' })
    actor.send({ type: 'FINAL_TYPED', playerId: 2, text: '' })
    for (const playerId of [1, 2, 3]) {
      if (path() === 'finalReveal.look') {
        roundTrip()
        const context = actor.getSnapshot().context
        actor.send({ type: 'ANSWER_JUDGED', judgment: { questionId: 'f1', playerId, attemptId: context.attemptId, status: 'incorrect', heard: 'Лондон', reason: 'Другая столица' } })
      }
      expect(path()).toBe('finalReveal.verdict')
      roundTrip()
      actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
      roundTrip()
      actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'stake' })
      roundTrip()
      actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'score' })
    }
    expect(path()).toBe('wrapUp')
    roundTrip()
    expect(actor.getSnapshot().context.players.map((player) => player.score)).toEqual([150, 60, 70])
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'bridge' })
    expect(path()).toBe('finished')
    actor.stop()
  })
})
