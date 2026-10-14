import { createActor } from 'xstate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCall } from '../realtime/client.ts'
import { MockRealtimeClient } from '../realtime/mockClient.ts'
vi.mock('../audio/beep.ts', () => ({ playTimeoutBeep: vi.fn(), unlockAudio: vi.fn() }))
import { gameConfig } from '../config.ts'
import { attachController } from './controller.ts'
import { gameMachine, statePath } from './machine.ts'
import type { Player, Question, QuestionPack } from './types.ts'

const base = { roundIndex: 0, text: 'Вопрос?', answers: ['ответ'] }
const pack: QuestionPack = {
  name: 'Спец',
  rounds: [{ index: 0, name: 'Р', kind: 'normal' }],
  questions: [
    { ...base, id: 'n100', themeId: 't', themeName: 'Обычная', value: 100 },
    { ...base, id: 'n500', themeId: 't', themeName: 'Обычная', value: 500 },
    { ...base, id: 'cat', themeId: 'c', themeName: 'Кот', value: 200, cat: { source: 'cat', theme: 'Звери', price: { kind: 'roundMinMax' }, knows: 'after', options: [100, 500] } },
    { ...base, id: 'auc', themeId: 'a', themeName: 'Торги', value: 100, auction: { source: 'auction' } },
  ] satisfies Question[],
  warnings: [],
}

class SpyClient extends MockRealtimeClient {
  tools: Array<{ name: string; instructions: string; turn: number; purpose: string; schema?: unknown }> = []
  override?: (call: ToolCall) => ToolCall | null
  silent = false
  override requestTool(purpose: string, turn: number, name: string, instructions: string, isolated = false, tool?: { name: string }): void {
    this.tools.push({ name, instructions, turn, purpose, schema: tool })
    if (this.silent) return
    if (this.override) {
      const forward = this.onToolCall
      this.onToolCall = (call, p, t) => { this.onToolCall = forward; forward(call && this.override ? this.override(call) : call, p, t) }
    }
    super.requestTool(purpose, turn, name, instructions, isolated, tool)
  }
}

async function boot(client: SpyClient, scores: number[] = [0, 0, 0]) {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    setTimeout: (handler: TimerHandler, timeout?: number) => globalThis.setTimeout(handler, timeout),
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
  })
  const actor = createActor(gameMachine).start()
  const stop = attachController({ actor, client, getApiKey: () => 'k', setLink: () => {}, onActions: () => {} })
  const players: Player[] = ['Анна', 'Борис', 'Вера'].map((name, index) => ({ id: index + 1, name, score: scores[index] ?? 0 }))
  actor.send({ type: 'START_GAME', pack, players })
  await vi.advanceTimersByTimeAsync(2000)
  expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
  const seen: string[] = []
  actor.subscribe((snapshot) => { seen.push(statePath(snapshot.value)) })
  return { actor, stop, seen }
}
const until = async (actor: { getSnapshot: () => { value: unknown } }, path: string) => {
  const at = () => statePath(actor.getSnapshot().value as never).startsWith(path)
  for (let i = 0; i < 100 && !at(); i += 1) await vi.advanceTimersByTimeAsync(50)
  expect(statePath(actor.getSnapshot().value as never)).toContain(path)
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('запасной разбор моделью в коте и аукционе', () => {
  it('имя не узнано локально — selectCatRecipient с кандидатами без выбравшего', async () => {
    const client = new SpyClient()
    const { actor, stop } = await boot(client)
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'c', value: 200 })
    await until(actor, 'cat.picking')
    client.hear('ну пусть будет Анюта', 1200)
    await until(actor, 'cat.staking')
    const tool = client.tools.find((item) => item.name === 'selectCatRecipient')!
    expect(tool.instructions).toContain('1: Анна')
    expect(tool.instructions).toContain('3: Вера')
    expect(tool.instructions).not.toContain('2: Борис')
    expect(tool.instructions).toContain('«ну пусть будет Анюта»')
    expect(actor.getSnapshot().context.special?.recipientId).toBe(1)
    stop(); actor.stop()
  })

  it('локальное совпадение — модель не спрашиваем', async () => {
    const client = new SpyClient()
    const { actor, stop } = await boot(client)
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'c', value: 200 })
    await until(actor, 'cat.picking')
    client.hear('отдаю Вере', 1200)
    await until(actor, 'cat.staking')
    expect(client.tools.filter((item) => item.name === 'selectCatRecipient')).toHaveLength(0)
    stop(); actor.stop()
  })

  it('модель вернула не кандидата (самого выбравшего) — переспрос', async () => {
    const client = new SpyClient()
    client.override = (call) => ({ ...call, arguments: { playerId: 2, confident: true, heard: 'x' } })
    const { actor, stop, seen } = await boot(client)
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'c', value: 200 })
    await until(actor, 'cat.picking')
    client.hear('ну пусть будет Анюта', 1200)
    await vi.advanceTimersByTimeAsync(2000)
    expect(seen).toContain('cat.clarifying')
    expect(actor.getSnapshot().context.special?.recipientId).toBeNull()
    stop(); actor.stop()
  })

  it('модель молчит — как в выборе ячейки: resolving, по judgeMs снова слушаем; поздний ответ не принимается', async () => {
    const client = new SpyClient()
    client.silent = true
    const { actor, stop, seen } = await boot(client)
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'c', value: 200 })
    await until(actor, 'cat.picking')
    client.hear('ну пусть будет Анюта', 1200)
    await until(actor, 'cat.resolving')
    await vi.advanceTimersByTimeAsync(gameConfig.judgeMs + 100)
    expect(statePath(actor.getSnapshot().value)).toBe('cat.picking')
    expect(seen).not.toContain('cat.clarifying')
    const tool = client.tools.at(-1)!
    client.onToolCall({ name: 'selectCatRecipient', callId: 'late', arguments: { playerId: 1, confident: true, heard: '' } }, tool.purpose, tool.turn)
    expect(actor.getSnapshot().context.special?.recipientId).toBeNull()
    stop(); actor.stop()
  })

  it('ставка кота: «по-крупному» через модель — максимум из вариантов', async () => {
    const client = new SpyClient()
    const { actor, stop } = await boot(client)
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'c', value: 200 })
    await until(actor, 'cat.picking')
    client.hear('отдаю Вере', 1200)
    await until(actor, 'cat.staking.listening')
    client.hear('давайте по-крупному', 1200)
    await until(actor, 'flashing')
    const tool = client.tools.find((item) => item.name === 'pickCatStake')!
    expect(tool.instructions).toContain('минимум 100 или максимум 500')
    expect(actor.getSnapshot().context.activeStake).toBe(500)
    stop(); actor.stop()
  })

  it('аукцион: сумма вне вариантов от модели отвергается; «до конца» — ва-банк', async () => {
    const client = new SpyClient()
    let bogus = true
    client.override = (call) => bogus ? ({ ...call, arguments: { choice: 'amount', amount: 777, heard: '' } }) : call
    const { actor, stop, seen } = await boot(client, [0, 900, 0])
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'a', value: 100 })
    await until(actor, 'auction.listening')
    client.hear('ну я иду до конца', 1200)
    await vi.advanceTimersByTimeAsync(2000)
    expect(seen).toContain('auction.clarifying')
    expect(actor.getSnapshot().context.special?.bid).toBeNull()
    bogus = false
    await until(actor, 'auction.listening')
    client.hear('ну я иду до конца', 1200)
    await until(actor, 'flashing')
    expect(actor.getSnapshot().context.special).toMatchObject({ leaderId: 2, allIn: true, bid: 900 })
    stop(); actor.stop()
  })
})

describe('ставка финала: тот же запасной путь', () => {
  it('parseBet не понял — finalBet с пределом денег в схеме, ва-банк принимается', async () => {
    const finalPack: QuestionPack = {
      name: 'Ф',
      rounds: [{ index: 0, name: 'Р', kind: 'normal' }, { index: 1, name: 'Финал', kind: 'final' }],
      questions: [
        { ...base, id: 'n100', themeId: 't', themeName: 'Обычная', value: 100 },
        { ...base, roundIndex: 1, id: 'f1', themeId: 'f', themeName: 'Финальная', value: 0 },
      ],
      warnings: [],
    }
    const client = new SpyClient()
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout: (handler: TimerHandler, timeout?: number) => globalThis.setTimeout(handler, timeout),
      clearTimeout: (id: number) => globalThis.clearTimeout(id),
    })
    const actor = createActor(gameMachine).start()
    const stop = attachController({ actor, client, getApiKey: () => 'k', setLink: () => {}, onActions: () => {} })
    actor.send({ type: 'START_GAME', pack: finalPack, players: [{ id: 1, name: 'Анна', score: 800 }] })
    await vi.advanceTimersByTimeAsync(2000)
    actor.send({ type: 'NEXT_ROUND' })
    for (let i = 0; i < 100 && !statePath(actor.getSnapshot().value).startsWith('finalBets.hearing'); i += 1) {
      if (statePath(actor.getSnapshot().value) === 'choosing.listening') actor.send({ type: 'QUESTION_SELECTED', themeId: 'f', value: 0 })
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(statePath(actor.getSnapshot().value)).toBe('finalBets.hearing')
    client.hear('ну я иду до конца', 1200)
    for (let i = 0; i < 40 && actor.getSnapshot().context.bets.length === 0; i += 1) await vi.advanceTimersByTimeAsync(100)
    const tool = client.tools.find((item) => item.name === 'finalBet')!
    expect(tool.instructions).toContain('от 0 до 800')
    expect(tool.schema).toMatchObject({ parameters: { properties: { amount: { minimum: 0, maximum: 800 } } } })
    expect(actor.getSnapshot().context.bets).toEqual([expect.objectContaining({ playerId: 1, amount: 800 })])
    stop(); actor.stop()
  })
})
