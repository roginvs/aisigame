import { createActor } from 'xstate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { idleSteps } from '../options.ts'
import { idleAutoCue, idleNudgeCue, chooserHandoffCue, catStakeCue, auctionAskCue } from './controller.ts'
import { setIdleScale } from './idle.ts'
import { gameMachine, statePath } from './machine.ts'
import type { Player, Question, QuestionPack } from './types.ts'

const base = { roundIndex: 0, text: 'Вопрос?', answers: ['ответ'] }
const pack: QuestionPack = {
  name: 'Тишина',
  rounds: [{ index: 0, name: 'Р', kind: 'normal' }],
  questions: [
    { ...base, id: 'n100', themeId: 't', themeName: 'Обычная', value: 100 },
    { ...base, id: 'cat', themeId: 'c', themeName: 'Кот', value: 200, cat: { source: 'cat', theme: 'Звери', price: { kind: 'roundMinMax' }, knows: 'after', options: [100, 500] } },
    { ...base, id: 'auc', themeId: 'a', themeName: 'Торги', value: 100, auction: { source: 'auction' } },
  ] satisfies Question[],
  warnings: [],
}

function start(names: string[], scores: number[] = []) {
  const players: Player[] = names.map((name, index) => ({ id: index + 1, name, score: scores[index] ?? 0 }))
  const actor = createActor(gameMachine).start()
  actor.send({ type: 'START_GAME', pack, players })
  actor.send({ type: 'CONNECTED' })
  actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
  return actor
}
type Actor = ReturnType<typeof start>
const path = (actor: Actor) => statePath(actor.getSnapshot().value)
const ctx = (actor: Actor) => actor.getSnapshot().context
const nudges = (actor: Actor) => ctx(actor).idleNudges ?? 0
const tick = (ms: number) => vi.advanceTimersByTime(ms)

beforeEach(() => { vi.useFakeTimers(); setIdleScale(1) })
afterEach(() => { vi.useRealTimers(); setIdleScale(1) })

describe('молчание на выборе вопроса', () => {
  it('15 с — позвать, 30 с — поторопить, 40 с — ход следующему по кругу', () => {
    const actor = start(['Аня', 'Боря', 'Вася'])
    expect(path(actor)).toBe('choosing.listening')
    const first = ctx(actor).chooserId
    tick(idleSteps.choosing[0] - 1)
    expect(nudges(actor)).toBe(0)
    tick(1)
    expect(nudges(actor)).toBe(1)
    expect(idleNudgeCue('choosing.listening', ctx(actor))).toContain('Молчит уже около 15 с')
    tick(idleSteps.choosing[1] - idleSteps.choosing[0])
    expect(nudges(actor)).toBe(2)
    expect(idleNudgeCue('choosing.listening', ctx(actor))).toContain('Поторопи')
    tick(idleSteps.choosing[2] - idleSteps.choosing[1])
    expect(path(actor)).toBe('chooserHandoff')
    const next = ctx(actor).chooserId
    expect(next).not.toBe(first)
    expect(ctx(actor).idleOutcome).toMatchObject({ kind: 'choosing', fromId: first, toId: next })
    const cue = chooserHandoffCue(ctx(actor))
    expect(cue).toContain('так и не выбран')
    expect(cue).toContain(ctx(actor).players.find((p) => p.id === next)!.name)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'chooserHandoff' })
    expect(path(actor)).toBe('choosing.listening')
    expect(ctx(actor).idleOutcome).toBeNull()
    tick(idleSteps.choosing[0])
    expect(nudges(actor)).toBe(3)
  })

  it('один игрок: выбор остаётся у него, отсчёт заново', () => {
    const actor = start(['Аня'])
    tick(idleSteps.choosing[2])
    expect(path(actor)).toBe('chooserHandoff')
    expect(ctx(actor).chooserId).toBe(1)
    expect(chooserHandoffCue(ctx(actor))).toContain('выбирает снова')
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'chooserHandoff' })
    tick(idleSteps.choosing[0] - 1)
    expect(nudges(actor)).toBe(2)
    tick(1)
    expect(nudges(actor)).toBe(3)
  })

  it('речь игрока сбрасывает и останавливает отсчёт', () => {
    const actor = start(['Аня', 'Боря'])
    tick(14_000)
    actor.send({ type: 'IDLE_SPEECH', active: true })
    tick(60_000)
    expect(nudges(actor)).toBe(0)
    actor.send({ type: 'IDLE_SPEECH', active: false })
    tick(14_999)
    expect(nudges(actor)).toBe(0)
    tick(1)
    expect(nudges(actor)).toBe(1)
  })

  it('речь ведущей замораживает, не сбрасывая', () => {
    const actor = start(['Аня', 'Боря'])
    tick(10_000)
    actor.send({ type: 'HOST_TALKING', active: true })
    tick(60_000)
    expect(nudges(actor)).toBe(0)
    actor.send({ type: 'HOST_TALKING', active: false })
    tick(4_999)
    expect(nudges(actor)).toBe(0)
    tick(1)
    expect(nudges(actor)).toBe(1)
  })

  it('ведущая говорит на входе — отсчёт ждёт конца её речи', () => {
    const actor = start(['Аня', 'Боря'])
    actor.send({ type: 'HOST_TALKING', active: true })
    actor.send({ type: 'QUESTION_UNCLEAR', reason: 'x' })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'clarify' })
    expect(path(actor)).toBe('choosing.listening')
    tick(60_000)
    expect(nudges(actor)).toBe(0)
    actor.send({ type: 'HOST_TALKING', active: false })
    tick(idleSteps.choosing[0])
    expect(nudges(actor)).toBe(1)
  })

  it('разбор останавливает; после уточнения ведущей — отсчёт заново', () => {
    const actor = start(['Аня', 'Боря'])
    tick(14_000)
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    expect(path(actor)).toBe('choosing.resolving')
    tick(10_000)
    expect(nudges(actor)).toBe(0)
    actor.send({ type: 'QUESTION_UNCLEAR', reason: 'x' })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'clarify' })
    tick(14_999)
    expect(nudges(actor)).toBe(0)
    tick(1)
    expect(nudges(actor)).toBe(1)
  })

  it('ускорение для демо', () => {
    setIdleScale(0.1)
    const actor = start(['Аня', 'Боря'])
    tick(1_500)
    expect(nudges(actor)).toBe(1)
    tick(2_500)
    expect(path(actor)).toBe('chooserHandoff')
  })
})

function toCat(actor: Actor) {
  actor.send({ type: 'QUESTION_SELECTED', themeId: 'c', value: 200 })
  actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'cat' })
  expect(path(actor)).toBe('cat.picking')
}

describe('молчание в коте', () => {
  it('15 с — спросить, кому; 30 с — случайному другому, ведущая объявляет', () => {
    const actor = start(['Аня', 'Боря', 'Вася'])
    toCat(actor)
    const giver = ctx(actor).special!.giverId
    const before = nudges(actor)
    tick(idleSteps.catPick[0])
    expect(nudges(actor)).toBe(before + 1)
    expect(idleNudgeCue('cat.picking', ctx(actor))).toContain('кому отдать кота')
    tick(idleSteps.catPick[1] - idleSteps.catPick[0])
    expect(path(actor)).toBe('cat.staking.asking')
    const recipient = ctx(actor).special!.recipientId
    expect(recipient).not.toBe(giver)
    expect([1, 2, 3]).toContain(recipient)
    expect(catStakeCue(ctx(actor))).toContain('кот случайно достался')
  })

  it('ставка: 10 с — спросить, 20 с — минимум и объявление, потом вопрос', () => {
    const actor = start(['Аня', 'Боря', 'Вася'])
    toCat(actor)
    actor.send({ type: 'CAT_RECIPIENT', playerId: 3 })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'catStake' })
    expect(path(actor)).toBe('cat.staking.listening')
    const before = nudges(actor)
    tick(idleSteps.catStake[0])
    expect(nudges(actor)).toBe(before + 1)
    expect(idleNudgeCue('cat.staking.listening', ctx(actor))).toContain('минимум или максимум')
    tick(idleSteps.catStake[1] - idleSteps.catStake[0])
    expect(path(actor)).toBe('cat.autoStaked')
    expect(ctx(actor).special!.stake).toBe(100)
    expect(idleAutoCue(ctx(actor))).toContain('100')
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'idleAuto' })
    expect(path(actor)).toBe('flashing')
    expect(ctx(actor).activeStake).toBe(100)
  })
})

describe('молчание на аукционе', () => {
  it('открывающий молчит: торги по номиналу; следующий молчит: пас', () => {
    const actor = start(['Аня', 'Боря', 'Вася'], [500, 500, 500])
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'a', value: 100 })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'auction' })
    expect(path(actor)).toBe('auction.listening')
    const opener = ctx(actor).special!.recipientId!
    tick(idleSteps.auction[0])
    expect(idleNudgeCue('auction.listening', ctx(actor))).toContain('назвать ставку')
    tick(idleSteps.auction[1] - idleSteps.auction[0])
    expect(ctx(actor).special).toMatchObject({ bid: 100, leaderId: opener })
    expect(path(actor)).toBe('auction.asking')
    expect(auctionAskCue(ctx(actor))).toContain('торги открыты по номиналу')
    const bidder = ctx(actor).special!.recipientId!
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'auctionAsk' })
    tick(idleSteps.auction[1])
    expect(ctx(actor).special!.passed).toContain(bidder)
  })
})

describe('молчание: контроллер', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  it('порог даёт реплику ведущей idleNudge; её речь замораживает отсчёт', async () => {
    vi.stubGlobal('window', {
      setTimeout: (handler: TimerHandler, timeout?: number) => globalThis.setTimeout(handler, timeout),
      clearTimeout: (id: number) => globalThis.clearTimeout(id),
    })
    const { MockRealtimeClient } = await import('../realtime/mockClient.ts')
    const { attachController } = await import('./controller.ts')
    const client = new MockRealtimeClient()
    const speech = vi.spyOn(client, 'requestSpeech')
    const actor = createActor(gameMachine)
    actor.start()
    const stop = attachController({ actor, client, getApiKey: () => 'k', setLink: () => {} })
    actor.send({ type: 'START_GAME', pack, players: [{ id: 1, name: 'Аня', score: 0 }, { id: 2, name: 'Боря', score: 0 }] })
    for (let i = 0; i < 40 && path(actor) !== 'choosing.listening'; i += 1) await vi.advanceTimersByTimeAsync(250)
    expect(path(actor)).toBe('choosing.listening')
    speech.mockClear()
    await vi.advanceTimersByTimeAsync(idleSteps.choosing[0] + 50)
    expect(speech.mock.calls.filter(([purpose]) => purpose === 'idleNudge')).toHaveLength(1)
    expect(ctx(actor).talk?.host).toBe(false)
    stop()
  })
})
