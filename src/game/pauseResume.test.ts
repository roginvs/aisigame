import { createActor } from 'xstate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gameConfig } from '../config.ts'
import { MockRealtimeClient } from '../realtime/mockClient.ts'
vi.mock('../audio/beep.ts', () => ({ playTimeoutBeep: vi.fn(), unlockAudio: vi.fn() }))
import { attachController } from './controller.ts'
import { gameMachine, statePath } from './machine.ts'
import type { Question, QuestionPack } from './types.ts'

// Конец речи ведущей здесь НЕ досылается руками: его шлёт только мок-клиент на заказанную реплику.
// Если контроллер реплику не заказал — узел висит, и тест это ловит.
const base = { roundIndex: 0, text: 'Вопрос?', answers: ['ответ'] }
const pack: QuestionPack = {
  name: 'Пауза',
  rounds: [{ index: 0, name: 'Р', kind: 'normal' }],
  questions: [
    { ...base, id: 'n100', themeId: 't', themeName: 'Обычная', value: 100 },
    { ...base, id: 'cat', themeId: 'c', themeName: 'Кот', value: 200, cat: { source: 'cat', theme: 'Звери', price: { kind: 'roundMinMax' }, knows: 'after', options: [100, 500] } },
    { ...base, id: 'auc', themeId: 'a', themeName: 'Торги', value: 100, auction: { source: 'auction' } },
  ] satisfies Question[],
  warnings: [],
}

async function boot(speechMs = 0, score = 0) {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    setTimeout: (handler: TimerHandler, timeout?: number) => globalThis.setTimeout(handler, timeout),
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
  })
  const client = new MockRealtimeClient()
  if (speechMs) client.setSpeechMs(speechMs)
  const speech = vi.spyOn(client, 'requestSpeech')
  const actor = createActor(gameMachine)
  actor.start()
  const stop = attachController({ actor, client, getApiKey: () => 'k', getPublicHistory: () => [], playSpecialSound: () => {}, setLink: () => {}, onActions: () => {} })
  actor.send({ type: 'START_GAME', pack, players: [{ id: 1, name: 'Аня', score }, { id: 2, name: 'Боря', score }, { id: 3, name: 'Вера', score }] })
  await vi.advanceTimersByTimeAsync(speechMs * 2 + 5000)
  actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
  await vi.advanceTimersByTimeAsync(100)
  expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
  const path = () => statePath(actor.getSnapshot().value)
  const said = (purpose: string) => speech.mock.calls.filter((c) => c[0] === purpose).length
  const pauseResume = async (pauseMs = 1000) => {
    actor.send({ type: 'PAUSE', path: path() })
    await vi.advanceTimersByTimeAsync(pauseMs)
    actor.send({ type: 'RESUME' })
  }
  return { actor, stop, path, said, pauseResume }
}

describe('пауза → «Дальше» в коте и аукционе', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('кот: пауза в выборе получателя → объявление заказано заново, игра идёт дальше', async () => {
    const { actor, stop, path, said, pauseResume } = await boot()
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'c', value: 200 })
    await vi.advanceTimersByTimeAsync(gameConfig.cellFlashMs + 10_000)
    expect(path()).toBe('cat.picking')
    const before = said('cat')
    await pauseResume()
    expect(path()).toBe('cat.announcing')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(said('cat')).toBe(before + 1)
    expect(path()).not.toBe('cat.announcing')
    stop(); actor.stop()
  })

  it('кот: пауза во время мяу (реплика ещё не заказана) → после RESUME заказана', async () => {
    const { actor, stop, path, said, pauseResume } = await boot()
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'c', value: 200 })
    for (let i = 0; i < 200 && path() !== 'cat.announcing'; i += 1) await vi.advanceTimersByTimeAsync(10)
    expect(path()).toBe('cat.announcing')
    expect(said('cat')).toBe(0)
    await pauseResume(20_000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(said('cat')).toBe(1)
    expect(path()).toBe('cat.picking')
    stop(); actor.stop()
  })

  it('кот: пауза в ожидании ставки → вопрос о ставке звучит снова', async () => {
    const { actor, stop, path, said, pauseResume } = await boot()
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'c', value: 200 })
    await vi.advanceTimersByTimeAsync(gameConfig.cellFlashMs + 10_000)
    actor.send({ type: 'CAT_RECIPIENT', playerId: 1 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(path()).toBe('cat.staking.listening')
    const before = said('catStake')
    await pauseResume()
    expect(path()).toBe('cat.staking.asking')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(said('catStake')).toBe(before + 1)
    expect(path()).toBe('cat.staking.listening')
    stop(); actor.stop()
  })

  it('аукцион: пауза в ожидании ставки → игра не зависает', async () => {
    const { actor, stop, path, said, pauseResume } = await boot(0, 1000)
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'a', value: 100 })
    await vi.advanceTimersByTimeAsync(gameConfig.cellFlashMs + 10_000)
    expect(path()).toBe('auction.listening')
    const before = said('auction') + said('auctionAsk')
    await pauseResume()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(said('auction') + said('auctionAsk')).toBe(before + 1)
    expect(path()).toBe('auction.listening')
    stop(); actor.stop()
  })

  it('кот: пауза посреди объявления — реплика не дублируется', async () => {
    const { actor, stop, path, said, pauseResume } = await boot(5000)
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'c', value: 200 })
    await vi.advanceTimersByTimeAsync(gameConfig.cellFlashMs + 3000)
    expect(path()).toBe('cat.announcing')
    const before = said('cat')
    expect(before).toBe(1)
    await pauseResume(100)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(said('cat')).toBe(1)
    expect(path()).toBe('cat.picking')
    stop(); actor.stop()
  })
})
