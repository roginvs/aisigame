import { createActor } from 'xstate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gameConfig } from '../config.ts'
import { finalStakeMs, finalTypedMs } from '../options.ts'
import { gameMachine, statePath } from './machine.ts'
import { persistMatch } from './savedGame.ts'
import type { QuestionPack } from './types.ts'

const pack: QuestionPack = {
  name: 'Финал', rounds: [{ index: 0, name: 'Финал', kind: 'final' }], warnings: [],
  questions: [
    { id: 'f1', roundIndex: 0, themeId: 't', themeName: 'Тема', value: 0, text: 'Столица?', answers: ['Париж'] },
    { id: 'f2', roundIndex: 0, themeId: 'other', themeName: 'Другая', value: 0, text: 'Вопрос?', answers: ['Ответ'] },
  ],
}

function reachStakes() {
  const actor = createActor(gameMachine).start()
  actor.send({ type: 'START_GAME', pack, players: [1, 2, 3].map((id) => ({ id, name: `Игрок ${id}`, score: 100 })) })
  actor.send({ type: 'CONNECTED' })
  actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
  actor.send({ type: 'STRIKE_THEME', playerId: 2, themeId: 'other' })
  actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'finalIntro' })
  expect(statePath(actor.getSnapshot().value)).toBe('finalBets.collecting')
  return actor
}

describe('финал: общий срок скрытого ввода', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('пакет с одной темой финала сразу переходит к объявлению ставок', () => {
    const actor = createActor(gameMachine).start()
    actor.send({ type: 'START_GAME', pack: { ...pack, questions: pack.questions.slice(0, 1) } })
    actor.send({ type: 'CONNECTED' })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
    expect(statePath(actor.getSnapshot().value)).toBe('finalDraft')
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'finalIntro' })
    // Стартовые игроки с нулём: ставка 0 уже стоит, окно не ждёт ввода.
    expect(statePath(actor.getSnapshot().value)).toBe('flashing')
    expect(actor.getSnapshot().context.bets).toEqual([1, 2, 3].map((playerId) => ({ playerId, amount: 0 })))
    actor.stop()
  })

  it('нулевой и отрицательный счёт получают ставку 0 сразу', () => {
    const actor = createActor(gameMachine).start()
    actor.send({
      type: 'START_GAME', pack,
      players: [
        { id: 1, name: 'Плюс', score: 100 },
        { id: 2, name: 'Ноль', score: 0 },
        { id: 3, name: 'Минус', score: -100 },
      ],
    })
    actor.send({ type: 'CONNECTED' })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
    actor.send({ type: 'STRIKE_THEME', playerId: 2, themeId: 'other' })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'finalIntro' })
    expect(statePath(actor.getSnapshot().value)).toBe('finalBets.collecting')
    expect(actor.getSnapshot().context.bets).toEqual([{ playerId: 3, amount: 0 }, { playerId: 2, amount: 0 }])
    actor.send({ type: 'FINAL_STAKE', playerId: 3, amount: 0 })
    expect(actor.getSnapshot().context.bets).toHaveLength(2)
    actor.send({ type: 'FINAL_STAKE', playerId: 1, amount: 40 })
    expect(statePath(actor.getSnapshot().value)).toBe('flashing')
    vi.advanceTimersByTime(gameConfig.cellFlashMs)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'turn' })
    for (const playerId of [1, 2, 3]) actor.send({ type: 'FINAL_TYPED', playerId, text: '' })
    expect(statePath(actor.getSnapshot().value)).toBe('finalReveal.verdict')
    expect(actor.getSnapshot().context.activePlayerId).toBe(3)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'stake' })
    expect(actor.getSnapshot().context.players.find((player) => player.id === 3)?.score).toBe(-100)
    actor.stop()
  })

  it('ставка одного игрока не даёт остальным ещё 30 секунд', () => {
    const actor = reachStakes()
    const startedAt = actor.getSnapshot().context.phaseStartedAt
    vi.advanceTimersByTime(finalStakeMs - 1000)
    actor.send({ type: 'FINAL_STAKE', playerId: 1, amount: 50 })
    expect(actor.getSnapshot().context.phaseStartedAt).toBe(startedAt)
    vi.advanceTimersByTime(1000)
    expect(statePath(actor.getSnapshot().value)).toBe('flashing')
    expect(actor.getSnapshot().context.bets).toEqual([{ playerId: 1, amount: 50 }, { playerId: 2, amount: 0 }, { playerId: 3, amount: 0 }])
    actor.stop()
  })

  it('финалист без записи ставки разбирается со ставкой 0', () => {
    const actor = reachStakes()
    for (const playerId of [1, 2, 3]) actor.send({ type: 'FINAL_STAKE', playerId, amount: 50 })
    vi.advanceTimersByTime(gameConfig.cellFlashMs)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'turn' })
    for (const playerId of [1, 2, 3]) actor.send({ type: 'FINAL_TYPED', playerId, text: 'нет' })
    expect(statePath(actor.getSnapshot().value)).toBe('finalReveal.look')
    const data = new Map<string, string>()
    const storage = {
      get length() { return data.size },
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value) },
      removeItem: (key: string) => { data.delete(key) },
      clear: () => data.clear(),
      key: (index: number) => [...data.keys()][index] ?? null,
    }
    const saved = persistMatch({
      packId: 'p', packFile: '', path: 'finalReveal.look',
      context: { ...actor.getSnapshot().context, bets: [] },
    }, storage)
    actor.stop()
    if (!saved) throw new Error('снимок финала не записался')
    const next = createActor(gameMachine).start()
    next.send({ type: 'CONTINUE_GAME', pack, saved })
    next.send({ type: 'CONNECTED' })
    expect(statePath(next.getSnapshot().value)).toBe('finalReveal.look')
    expect(next.getSnapshot().context.activeStake).toBe(0)
    const playerId = next.getSnapshot().context.activePlayerId
    const score = next.getSnapshot().context.players.find((player) => player.id === playerId)?.score
    next.send({
      type: 'ANSWER_JUDGED',
      judgment: {
        questionId: 'f1', playerId: playerId ?? 1, attemptId: next.getSnapshot().context.attemptId,
        status: 'incorrect', heard: 'нет', reason: 'не то',
      },
    })
    next.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
    next.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'stake' })
    expect(next.getSnapshot().context.players.find((player) => player.id === playerId)?.score).toBe(score)
    next.stop()
  })

  it('ответ одного игрока не перезапускает общий таймер ответов', () => {
    const actor = reachStakes()
    for (const playerId of [1, 2, 3]) actor.send({ type: 'FINAL_STAKE', playerId, amount: 50 })
    vi.advanceTimersByTime(gameConfig.cellFlashMs)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'turn' })
    expect(statePath(actor.getSnapshot().value)).toBe('finalTyped')
    const startedAt = actor.getSnapshot().context.phaseStartedAt
    vi.advanceTimersByTime(finalTypedMs - 1000)
    actor.send({ type: 'FINAL_TYPED', playerId: 1, text: 'Париж' })
    expect(actor.getSnapshot().context.phaseStartedAt).toBe(startedAt)
    vi.advanceTimersByTime(1000)
    expect(statePath(actor.getSnapshot().value)).toBe('finalReveal.verdict')
    expect(actor.getSnapshot().context.typedAnswers).toEqual({ 1: 'Париж', 2: '', 3: '' })
    actor.stop()
  })
})
