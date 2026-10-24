import { createActor } from 'xstate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gameConfig } from '../config.ts'
import { announceInstructions, roundSummaryInstructions } from './controller.ts'
import { appealButton, appealRequestError, appealWindowMs, APPEAL_WINDOW_MS, settleOutcome } from './appeals.ts'
import { gameMachine, statePath } from './machine.ts'
import { persistMatch, readSavedGame } from './savedGame.ts'
import type { JudgmentStatus, QuestionPack } from './types.ts'

const pack: QuestionPack = {
  name: 'Апелляции', warnings: [], rounds: [{ index: 0, name: 'Раунд', kind: 'normal' }],
  questions: [100, 200].map((value) => ({ id: `q${value}`, roundIndex: 0, themeId: 't', themeName: 'Тема', value, text: 'Кто?', answers: ['Август'] })),
}
type Actor = ReturnType<typeof createActor<typeof gameMachine>>
function start(input = pack, ids = [1, 2, 3]): Actor {
  const actor = createActor(gameMachine).start()
  actors.push(actor)
  actor.send({ type: 'START_GAME', pack: input, players: ids.map((id) => ({ id, name: `Игрок ${id}`, score: 0 })) })
  actor.send({ type: 'CONNECTED' })
  actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
  actor.send({ type: 'QUESTION_SELECTED', themeId: 't', value: 100 })
  vi.advanceTimersByTime(gameConfig.cellFlashMs)
  actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
  return actor
}
function result(actor: Actor, status: JudgmentStatus) {
  actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
  actor.send({ type: 'ANSWER_SETTLED' })
  const c = actor.getSnapshot().context
  const judgment = { questionId: c.activeQuestionId!, playerId: c.activePlayerId!, attemptId: c.attemptId, status, heard: 'ответ', reason: 'проверка' }
  actor.send({ type: 'ANSWER_JUDGED', judgment })
  return judgment
}
function say(actor: Actor) { actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' }) }
function normal(actor: Actor, playerId: number, status: JudgmentStatus) {
  actor.send({ type: 'BUZZER_PRESSED', playerId }); result(actor, status); say(actor)
}
let serial = 0
function request(actor: Actor, playerId: number, requestId = `request-${++serial}`) {
  const a = actor.getSnapshot().context.appeal!
  const event = { type: 'APPEAL_REQUESTED' as const, questionId: a.questionId, windowId: a.windowId, playerId, requestId }
  actor.send(event)
  return event
}
function cue(actor: Actor) { actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'appeal' }) }
/** Закрытый вопрос: подтверждение без повтора → объявление. */
function confirm(_actor: Actor) { vi.advanceTimersByTime(1) }
function scores(actor: Actor) { return actor.getSnapshot().context.players.map((p) => p.score) }
function path(actor: Actor) { return statePath(actor.getSnapshot().value) }
const actors: Actor[] = []
const storage = () => {
  const entries = new Map<string, string>()
  return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value), removeItem: (key: string) => entries.delete(key) } as unknown as Storage
}
function save(actor: Actor) {
  const store = storage()
  persistMatch({ packId: 'test', packFile: '', path: path(actor), context: actor.getSnapshot().context }, store)
  return readSavedGame(store)!
}
function restore(actor: Actor, input = pack) {
  const saved = save(actor)
  const fresh = createActor(gameMachine).start(); actors.push(fresh)
  fresh.send({ type: 'CONTINUE_GAME', pack: input, saved }); fresh.send({ type: 'CONNECTED' })
  return fresh
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => { actors.splice(0).forEach((a) => a.stop()); vi.useRealTimers() })

describe('ручные апелляции', () => {
  it('повторные минусы не копятся, ноль возвращает штраф, плюс заменяет минус', () => {
    const actor = start()
    normal(actor, 1, 'incorrect')
    for (const status of ['incorrect', 'incorrect', 'ambiguous', 'incorrect', 'correct'] as const) {
      request(actor, 1); expect(path(actor)).toBe('appealCue'); cue(actor)
      const judgment = result(actor, status)
      actor.send({ type: 'ANSWER_JUDGED', judgment })
      expect(scores(actor)[0]).toBe(status === 'correct' ? 100 : status === 'ambiguous' ? 0 : -100)
      say(actor)
    }
    expect(path(actor)).toBe('choosing.listening')
    expect(actor.getSnapshot().context.appeal).toBeNull()
  })

  it.each(['unintelligible', 'ambiguous', 'needs_clarification'] as const)('нулевой %s оставляет перехват и право последнего на апелляцию', (status) => {
    const actor = start(); normal(actor, 1, status)
    expect(path(actor)).toBe('buzzing.open')
    expect(scores(actor)).toEqual([0, 0, 0])
    expect(actor.getSnapshot().context.missedIds).toEqual([1])
    expect(appealButton(actor.getSnapshot().context, path(actor), 1)).toEqual({ label: 'Апелляция', enabled: true })
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 }); expect(path(actor)).toBe('buzzing.open')
  })

  it('таймаут оценки тоже нулевой результат с перехватом; при повторе возвращает минус', () => {
    const actor = start(); normal(actor, 1, 'incorrect'); request(actor, 1); cue(actor)
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' }); actor.send({ type: 'ANSWER_SETTLED' }); vi.advanceTimersByTime(gameConfig.judgeMs)
    expect(scores(actor)[0]).toBe(0); say(actor); expect(path(actor)).toBe('buzzing.open')
  })

  it('первое событие апелляции побеждает кнопку; кнопка раньше отключает апелляцию до закрытия', () => {
    const first = start(); normal(first, 1, 'incorrect'); request(first, 1)
    first.send({ type: 'BUZZER_PRESSED', playerId: 2 }); expect(first.getSnapshot().context.activePlayerId).toBe(1)
    const second = start(); normal(second, 1, 'incorrect')
    const a = second.getSnapshot().context.appeal!
    second.send({ type: 'BUZZER_PRESSED', playerId: 2 })
    second.send({ type: 'APPEAL_REQUESTED', questionId: a.questionId, windowId: a.windowId, playerId: 1, requestId: 'late' })
    expect(second.getSnapshot().context.activePlayerId).toBe(2)
    result(second, 'incorrect'); say(second)
    expect(appealButton(second.getSnapshot().context, path(second), 1)).toBeNull()
    normal(second, 3, 'correct')
    expect(appealButton(second.getSnapshot().context, path(second), 1)?.enabled).toBe(true)
  })

  it('истечение перехвата закрывает старое окно; появляется отдельное окно закрытого вопроса', () => {
    const actor = start(); normal(actor, 1, 'incorrect')
    const a = actor.getSnapshot().context.appeal!
    vi.advanceTimersByTime(appealWindowMs())
    actor.send({ type: 'APPEAL_REQUESTED', questionId: a.questionId, windowId: a.windowId, playerId: 1, requestId: 'late' })
    expect(path(actor)).toBe('announcing.speaking'); say(actor)
    expect(path(actor)).toBe('choosing.listening')
    expect(actor.getSnapshot().context.appeal?.windowId).not.toBe(a.windowId)
  })

  it('после закрытия: подтверждение без повтора, второй встаёт в FIFO, их плюсы сохраняют чужой плюс', () => {
    const actor = start(); normal(actor, 1, 'incorrect'); normal(actor, 2, 'ambiguous'); normal(actor, 3, 'correct')
    expect(scores(actor)).toEqual([-100, 0, 100]); expect(actor.getSnapshot().context.activeQuestionId).toBeNull()
    request(actor, 1); expect(path(actor)).toBe('appealConfirm'); expect(actor.getSnapshot().context.activeQuestionId).toBe('q100')
    expect(scores(actor)).toEqual([100, 0, 100])
    const queued = request(actor, 2); actor.send(queued)
    expect(actor.getSnapshot().context.appeal?.queue).toEqual([2])
    vi.advanceTimersByTime(6_000); expect(actor.getSnapshot().context.appeal?.queue).toEqual([2])
    expect(path(actor)).toBe('announcing.speaking')
    expect(announceInstructions(actor.getSnapshot().context)).toContain('Апелляция игрока Игрок 1')
    actor.send({ type: 'QUESTION_SELECTED', themeId: 't', value: 200 }); expect(path(actor)).toBe('announcing.speaking')
    say(actor)
    expect(path(actor)).toBe('appealConfirm'); expect(actor.getSnapshot().context.activePlayerId).toBe(2)
    confirm(actor); say(actor)
    expect(scores(actor)).toEqual([100, 100, 100]); expect(path(actor)).toBe('choosing.listening')
    expect(actor.getSnapshot().context.chooserId).toBe(3)
    expect(actor.getSnapshot().context.playedIds).toEqual(['q100'])
  })

  it('пауза в подтверждении апелляции возвращает к объявлению', () => {
    const actor = start(); normal(actor, 1, 'incorrect'); normal(actor, 2, 'incorrect'); normal(actor, 3, 'correct')
    request(actor, 1)
    expect(path(actor)).toBe('appealConfirm')
    actor.send({ type: 'PAUSE', path: path(actor) })
    expect(path(actor)).toBe('paused')
    expect(actor.getSnapshot().context.resumePath).toBe('appealConfirm')
    actor.send({ type: 'RESUME' })
    expect(path(actor)).toBe('announcing.speaking')
  })

  it('подтверждённый игрок больше не может подать апелляцию на этот вопрос', () => {
    const actor = start(); normal(actor, 1, 'incorrect'); normal(actor, 2, 'incorrect'); normal(actor, 3, 'correct')
    request(actor, 1); request(actor, 2); confirm(actor); say(actor); confirm(actor); say(actor)
    expect(scores(actor)).toEqual([100, 100, 100])
    expect(path(actor)).toBe('choosing.listening'); expect(appealButton(actor.getSnapshot().context, path(actor), 1)).toBeNull()
  })

  it('минус — апелляция доступна сразу, ещё пока ведущая говорит', () => {    const actor = start(); actor.send({ type: 'BUZZER_PRESSED', playerId: 1 }); result(actor, 'incorrect')
    expect(path(actor)).toBe('announcing.speaking')
    expect(appealButton(actor.getSnapshot().context, path(actor), 1)).toEqual({ label: 'Апелляция', enabled: true })
    request(actor, 1); expect(path(actor)).toBe('appealCue')
    const closed = start(pack, [1]); closed.send({ type: 'BUZZER_PRESSED', playerId: 1 }); result(closed, 'incorrect')
    expect(path(closed)).toBe('announcing.speaking')
    expect(closed.getSnapshot().context.appeal?.stage).toBe('closed')
    expect(appealButton(closed.getSnapshot().context, path(closed), 1)?.enabled).toBe(true)
    request(closed, 1); expect(path(closed)).toBe('appealConfirm'); confirm(closed)
    expect(path(closed)).toBe('announcing.speaking'); expect(scores(closed)).toEqual([100])
  })

  it('после верного ответа окно оспаривания живёт в announcing, в том числе в holding: кнопка не мигает во время удержания медиа', () => {
    const actor = start(); normal(actor, 1, 'incorrect'); normal(actor, 2, 'correct')
    expect(actor.getSnapshot().context.appeal?.stage).toBe('closed')
    const context = actor.getSnapshot().context
    expect(path(actor)).toBe('choosing.listening')
    expect(appealButton(context, 'announcing.speaking', 1)).toEqual({ label: 'Апелляция', enabled: true })
    expect(appealButton(context, 'announcing.holding', 1)).toEqual({ label: 'Апелляция', enabled: true })
  })

  it('оба закрытых окна — 7 секунд, строка итогов называет фактическую длину', () => {
    expect(APPEAL_WINDOW_MS).toBe(7_000)
    expect(appealWindowMs()).toBe(7_000)
    const input = { ...pack, questions: [pack.questions[0]!] }
    const actor = start(input, [1]); normal(actor, 1, 'incorrect')
    expect(path(actor)).toBe('roundSummaryWindow')
    expect(actor.getSnapshot().context.statusLine).toBe('Апелляции · 7 секунд')
  })

  it('выбор первым закрывает окно, апелляция первым отсекает уже запущенный голосовой выбор', () => {
    const actor = start(); normal(actor, 1, 'incorrect'); normal(actor, 2, 'correct')
    const a = actor.getSnapshot().context.appeal!
    actor.send({ type: 'QUESTION_SELECTED', themeId: 't', value: 200 })
    actor.send({ type: 'APPEAL_REQUESTED', questionId: a.questionId, windowId: a.windowId, playerId: 1, requestId: 'old' })
    expect(path(actor)).toBe('flashing')
    const second = start(); normal(second, 1, 'incorrect'); normal(second, 2, 'correct')
    second.send({ type: 'PLAYER_SPEECH_FINISHED' }); expect(path(second)).toBe('choosing.resolving')
    request(second, 1); second.send({ type: 'QUESTION_SELECTED', themeId: 't', value: 200 })
    expect(path(second)).toBe('appealConfirm')
  })

  it('последний вопрос ждёт апелляции; в финал идут все, ставки начинают с меньшего счёта', () => {
    const input: QuestionPack = { ...pack, rounds: [...pack.rounds, { index: 1, name: 'Финал', kind: 'final' }],
      questions: [pack.questions[0]!, { ...pack.questions[1]!, id: 'final', roundIndex: 1 }] }
    const actor = start(input, [1, 2]); normal(actor, 1, 'incorrect'); normal(actor, 2, 'incorrect')
    expect(path(actor)).toBe('roundSummaryWindow'); expect(actor.getSnapshot().context.roundIndex).toBe(0)
    request(actor, 2); confirm(actor); say(actor)
    // Подтверждённая апелляция обслуживается в том же окне итогов.
    expect(path(actor)).toBe('roundSummaryWindow'); expect(actor.getSnapshot().context.appeal?.summary).toBe('pending')
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'roundSummary' })
    vi.advanceTimersByTime(appealWindowMs())
    expect(path(actor)).toBe('finalDraft'); expect(actor.getSnapshot().context.roundIndex).toBe(1)
    // При одной теме круг вычёркивания не нужен; токен раунда всё равно у первого.
    expect(actor.getSnapshot().context.finalStriker).toBe(1)
    expect(path(actor)).toBe('finalDraft')
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'finalIntro' })
    // В финале играют все независимо от счёта.
    expect(actor.getSnapshot().context.finalists).toEqual([1, 2]); expect(actor.getSnapshot().context.appeal).toBeNull()
  })

  it('последний вопрос без финала не объявляет победителя до конца окна', () => {
    const input = { ...pack, questions: [pack.questions[0]!] }
    const actor = start(input, [1]); normal(actor, 1, 'ambiguous')
    expect(path(actor)).toBe('roundSummaryWindow'); vi.advanceTimersByTime(appealWindowMs() - 1); expect(path(actor)).toBe('roundSummaryWindow')
    vi.advanceTimersByTime(1); expect(path(actor)).toBe('finished')
  })

  it('нет попыток — нет апелляций; не отвечавшему и успешному игроку отказывает', () => {
    const actor = start(); vi.advanceTimersByTime(gameConfig.buzzerMs); say(actor)
    expect(actor.getSnapshot().context.appeal).toBeNull()
    const other = start(); normal(other, 1, 'incorrect'); normal(other, 2, 'correct')
    const a = other.getSnapshot().context.appeal!
    for (const playerId of [2, 3]) {
      expect(appealRequestError(other.getSnapshot().context, path(other), { questionId: a.questionId, windowId: a.windowId, playerId, requestId: 'no' })).toBe('Нет права на апелляцию')
    }
  })

  it('пауза сохраняет остаток окна и очередь, новые заявки блокирует', () => {
    const actor = start(); normal(actor, 1, 'incorrect'); normal(actor, 2, 'correct')
    vi.advanceTimersByTime(2_000); actor.send({ type: 'PAUSE', path: path(actor) }); request(actor, 1)
    vi.advanceTimersByTime(60_000); expect(path(actor)).toBe('paused')
    actor.send({ type: 'RESUME' }); vi.advanceTimersByTime(appealWindowMs() - 2_001)
    expect(actor.getSnapshot().context.appeal).not.toBeNull(); vi.advanceTimersByTime(1)
    expect(actor.getSnapshot().context.appeal).toBeNull()
  })

  it('restore объявления подтверждённой апелляции сохраняет очередь и не удваивает коррекцию', () => {
    const actor = start(); normal(actor, 1, 'incorrect'); normal(actor, 2, 'incorrect'); normal(actor, 3, 'correct')
    request(actor, 1); request(actor, 2); confirm(actor)
    expect(path(actor)).toBe('announcing.speaking')
    const fresh = restore(actor)
    expect(fresh.getSnapshot().context.appeal?.queue).toEqual([2])
    expect(scores(fresh)).toEqual([100, -100, 100]); say(fresh)
    expect(fresh.getSnapshot().context.activePlayerId).toBe(2)
    confirm(fresh); say(fresh); expect(scores(fresh)).toEqual([100, 100, 100])
  })

  it('restore окна после очищенного activeQuestionId сохраняет старый вопрос', () => {
    const actor = start(); normal(actor, 1, 'incorrect'); normal(actor, 2, 'correct')
    const fresh = restore(actor); request(fresh, 1); confirm(fresh); say(fresh)
    expect(scores(fresh)).toEqual([100, 100, 0])
  })

  it('skip и STOP очищают очередь; поздняя оценка не меняет счёт', () => {
    const actor = start(); normal(actor, 1, 'incorrect'); normal(actor, 2, 'incorrect'); normal(actor, 3, 'correct')
    request(actor, 1); request(actor, 2); confirm(actor)
    actor.send({ type: 'NEXT_ROUND' })
    expect(scores(actor)).toEqual([100, -100, 100]); expect(actor.getSnapshot().context.appeal).toBeNull()
    const other = start(); normal(other, 1, 'incorrect'); request(other, 1); other.send({ type: 'STOP' })
    expect(other.getSnapshot().context.appeal).toBeNull()
  })

  it('settlement отсекает повтор попытки независимо от доставки', () => {
    const actor = start(); normal(actor, 1, 'incorrect')
    const c = { ...actor.getSnapshot().context, activePlayerId: 1, activeQuestionId: 'q100' }
    expect(settleOutcome(c, 100).players).toEqual(c.players)
  })

  it('апелляция без изменения итога: ведущая называет итог за вопрос числом', () => {
    const actor = start(); normal(actor, 1, 'incorrect'); request(actor, 1); cue(actor); result(actor, 'incorrect')
    const c = actor.getSnapshot().context
    expect(scores(actor)[0]).toBe(-100)
    expect(c.outcomes?.q100?.[1]).toMatchObject({ amount: -100, previous: -100 })
    const text = announceInstructions(c)
    expect(text).toContain('Апелляция игрока Игрок 1 не принята. За этот вопрос осталось минус сто. Общий счёт -100.')
    expect(text.match(/минус сто/g)).toHaveLength(1)
    expect(text).not.toContain('по смыслу так')
    expect(text).not.toContain('Факты:')
    expect(text).toContain('Новый итог заменяет прежний')
    say(actor); request(actor, 1); cue(actor); result(actor, 'correct')
    const changed = announceInstructions(actor.getSnapshot().context)
    expect(changed).toContain('Апелляция игрока Игрок 1 принята. За этот вопрос было минус сто, стало плюс сто. Общий счёт 100.')
    expect(changed.match(/плюс сто/g)).toHaveLength(1)
    expect(changed).toContain('Числа — ровно как в ситуации')
  })

  it('итог раунда в окне последнего вопроса: речь не обрывается окном, мост не повторяется', () => {
    const input: QuestionPack = { ...pack, rounds: [...pack.rounds, { index: 1, name: 'Второй', kind: 'normal' }],
      questions: [pack.questions[0]!, { ...pack.questions[1]!, roundIndex: 1 }] }
    const actor = start(input, [1, 2]); normal(actor, 1, 'incorrect'); normal(actor, 2, 'incorrect')
    expect(path(actor)).toBe('roundSummaryWindow'); expect(actor.getSnapshot().context.appeal?.summary).toBe('pending')
    const text = roundSummaryInstructions(actor.getSnapshot().context)
    expect(text).toContain('Впереди второй раунд'); expect(text).toContain('Игрок 1')
    vi.advanceTimersByTime(appealWindowMs())
    expect(path(actor)).toBe('roundSummaryWindow'); expect(actor.getSnapshot().context.appeal?.timeUp).toBe(true)
    const a = actor.getSnapshot().context.appeal!
    expect(appealRequestError(actor.getSnapshot().context, path(actor), { questionId: a.questionId, windowId: a.windowId, playerId: 1, requestId: 'late' })).not.toBeNull()
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'roundSummary' })
    expect(path(actor)).toBe('choosing.listening'); expect(actor.getSnapshot().context.roundIndex).toBe(1)
  })

  it('апелляция во время итога раунда обслуживается, потом итог звучит заново', () => {
    const input: QuestionPack = { ...pack, rounds: [...pack.rounds, { index: 1, name: 'Финал', kind: 'final' }],
      questions: [pack.questions[0]!, { ...pack.questions[1]!, id: 'final', roundIndex: 1 }] }
    const actor = start(input, [1, 2]); normal(actor, 1, 'incorrect'); normal(actor, 2, 'incorrect')
    expect(roundSummaryInstructions(actor.getSnapshot().context)).toContain('финальный раунд')
    request(actor, 1); expect(path(actor)).toBe('appealConfirm'); confirm(actor); say(actor)
    expect(path(actor)).toBe('roundSummaryWindow'); expect(actor.getSnapshot().context.appeal?.summary).toBe('pending')
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'roundSummary' }); expect(path(actor)).toBe('roundSummaryWindow')
    vi.advanceTimersByTime(appealWindowMs()); expect(path(actor)).toBe('finalDraft')
    expect(scores(actor)).toEqual([100, -100]); expect(actor.getSnapshot().context.roundIndex).toBe(1)
  })

  it('поздний зачёт возвращает очки первому и не трогает верный перехват', () => {
    const actor = start()
    normal(actor, 1, 'incorrect')
    expect(scores(actor)).toEqual([-100, 0, 0])
    normal(actor, 2, 'correct')
    expect(scores(actor)).toEqual([-100, 100, 0])
    expect(path(actor)).toBe('choosing.listening')
    // На табло activeQuestionId уже пуст: окно держится за последнюю сыгранную ячейку.
    expect(actor.getSnapshot().context.activeQuestionId).toBeNull()
    expect(actor.getSnapshot().context.playedIds.at(-1)).toBe('q100')
    actor.send({ type: 'LATE_TRANSCRIPT_CREDIT', questionId: 'q100', playerId: 1 })
    expect(scores(actor)).toEqual([100, 100, 0])
    expect(actor.getSnapshot().context.statusLine).toBe('Апелляция принята')
    expect(actor.getSnapshot().context.outcomes?.q100?.[1]).toMatchObject({ amount: 100, previous: -100, correct: true })
    expect(actor.getSnapshot().context.outcomes?.q100?.[2]).toMatchObject({ amount: 100, correct: true })
    expect(path(actor)).toBe('choosing.listening')
    actor.send({ type: 'LATE_TRANSCRIPT_CREDIT', questionId: 'q100', playerId: 1 })
    expect(scores(actor)).toEqual([100, 100, 0])
    actor.send({ type: 'QUESTION_SELECTED', themeId: 't', value: 200 })
    expect(actor.getSnapshot().context.activeQuestionId).toBe('q200')
    actor.send({ type: 'LATE_TRANSCRIPT_CREDIT', questionId: 'q100', playerId: 1 })
    expect(scores(actor)).toEqual([100, 100, 0])
  })

  it('поздний зачёт поднимает ноль до плюса и не начисляет без итога', () => {
    const actor = start()
    const questionId = actor.getSnapshot().context.activeQuestionId!
    actor.send({ type: 'LATE_TRANSCRIPT_CREDIT', questionId, playerId: 1 })
    expect(scores(actor)).toEqual([0, 0, 0])
    normal(actor, 1, 'unintelligible')
    expect(scores(actor)).toEqual([0, 0, 0])
    actor.send({ type: 'LATE_TRANSCRIPT_CREDIT', questionId, playerId: 1 })
    expect(scores(actor)).toEqual([100, 0, 0])
    expect(actor.getSnapshot().context.outcomes?.[questionId]?.[1]).toMatchObject({ amount: 100, previous: 0, correct: true })
    actor.send({ type: 'LATE_TRANSCRIPT_CREDIT', questionId, playerId: 1 })
    expect(scores(actor)).toEqual([100, 0, 0])
  })

  it('ручная апелляция уже поставила плюс — поздний зачёт второй раз не платит', () => {
    const actor = start()
    normal(actor, 1, 'incorrect')
    normal(actor, 2, 'incorrect')
    normal(actor, 3, 'incorrect')
    expect(scores(actor)).toEqual([-100, -100, -100])
    expect(actor.getSnapshot().context.activeQuestionId).toBeNull()
    request(actor, 1)
    confirm(actor)
    expect(scores(actor)).toEqual([100, -100, -100])
    actor.send({ type: 'LATE_TRANSCRIPT_CREDIT', questionId: 'q100', playerId: 1 })
    expect(scores(actor)).toEqual([100, -100, -100])
    expect(actor.getSnapshot().context.outcomes?.q100?.[2]?.amount).toBe(-100)
  })
})
