import { createActor } from 'xstate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRememberedPlayersForTests } from './presence.ts'
import { gameMachine, statePath } from '../game/machine.ts'
import { demoPack } from '../game/questions.ts'
import type { Question, QuestionPack } from '../game/types.ts'
import type { GameVoice } from '../realtime/client.ts'
import { MasterSession } from './masterSession.ts'
import { isConferenceMessage, type ConferenceMessage } from './messages.ts'
import type { ConferenceTransport } from './transport.ts'

class MemoryTransport implements ConferenceTransport {
  sent: ConferenceMessage[] = []
  private handlers = new Set<(message: ConferenceMessage, senderId: string) => void>()
  send(message: ConferenceMessage): void { this.sent.push(message) }
  subscribe(handler: (message: ConferenceMessage, senderId: string) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }
  receive(message: ConferenceMessage, senderId = 'endpoint'): void {
    for (const handler of this.handlers) handler(message, senderId)
  }
  close(): void {}
}

const base = { roundIndex: 0, text: 'Вопрос?', answers: ['ответ'] }
const pack: QuestionPack = {
  name: 'Спец',
  rounds: [{ index: 0, name: 'Р', kind: 'normal' }],
  questions: [
    { ...base, id: 'n100', themeId: 't', themeName: 'Обычная', value: 100 },
    { ...base, id: 'cat', themeId: 'c', themeName: 'Кот', value: 200, cat: { source: 'cat', theme: 'Звери', price: { kind: 'roundMinMax' }, knows: 'after', options: [100, 500] } },
    { ...base, id: 'auc', themeId: 'a', themeName: 'Торги', value: 100, auction: { source: 'auction' } },
  ] satisfies Question[],
  warnings: [],
}

function setup(scores: number[] = []) {
  const actor = createActor(gameMachine).start()
  const transport = new MemoryTransport()
  const session = new MasterSession({
    transport,
    client: { requestSpeech: vi.fn() } as unknown as GameVoice,
    actor,
    masterClientId: 'master-client',
    masterName: 'Мастер',
    pack: demoPack,
    packBytes: new Uint8Array([1, 2, 3]),
    packHash: 'hash',
    authorityToken: 'master-token',
    onRoster: () => {},
  })
  for (const [clientId, name] of [['a-client', 'Аня'], ['b-client', 'Боря']] as const) {
    transport.receive({ type: 'hello', clientId, authToken: `${clientId}-token`, name }, `${clientId}-endpoint`)
    transport.receive({ type: 'packVerified', clientId, authToken: `${clientId}-token`, hash: 'hash' }, `${clientId}-endpoint`)
    transport.receive({ type: 'ready', clientId, authToken: `${clientId}-token` }, `${clientId}-endpoint`)
  }
  session.startGame((players) => {
    actor.send({ type: 'START_GAME', pack, players: players.map((player, index) => ({ ...player, score: scores[index] ?? 0 })) })
    actor.send({ type: 'CONNECTED' })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
  })
  const pick = (clientId: string, body: Record<string, unknown>) =>
    transport.receive({ type: 'specialPick', clientId, authToken: `${clientId}-token`, ...body } as ConferenceMessage, `${clientId}-endpoint`)
  return { actor, session, pick }
}

describe('specialPick на мастере', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    })
    clearRememberedPlayersForTests()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('сообщение проходит валидатор, мусор — нет', () => {
    expect(isConferenceMessage({ type: 'specialPick', clientId: 'a', authToken: 't', target: 'player', playerId: 2 })).toBe(true)
    expect(isConferenceMessage({ type: 'specialPick', clientId: 'a', authToken: 't', target: 'auction', choice: 'allIn' })).toBe(true)
    expect(isConferenceMessage({ type: 'specialPick', clientId: 'a', authToken: 't', target: 'bribe' })).toBe(false)
    expect(isConferenceMessage({ type: 'specialPick', clientId: 'a', authToken: 't', target: 'auction', choice: 'много' })).toBe(false)
  })

  it('кота отдаёт только даритель; ставку делает только получатель', () => {
    const { actor, session, pick } = setup()
    const giver = actor.getSnapshot().context.chooserId
    expect(giver).toBe(2)
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'c', value: 200 })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'cat' })
    expect(statePath(actor.getSnapshot().value)).toBe('cat.picking')
    pick('b-client', { target: 'player', playerId: 1 })
    expect(actor.getSnapshot().context.special?.recipientId).toBeNull()
    pick('a-client', { target: 'player', playerId: 3 })
    expect(actor.getSnapshot().context.special?.recipientId).toBe(3)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'catStake' })
    pick('a-client', { target: 'stake', amount: 500 })
    expect(actor.getSnapshot().context.special?.stake).toBeNull()
    pick('b-client', { target: 'stake', amount: 500 })
    expect(actor.getSnapshot().context.special?.stake).toBe(500)
    session.dispose()
    actor.stop()
  })

  it('аукцион: чужой ход и ставка не из списка игнорируются, вариант берётся мастера', () => {
    const { actor, session, pick } = setup([300, 300, 300])
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'a', value: 100 })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'auction' })
    const special = () => actor.getSnapshot().context.special
    expect(special()?.recipientId).toBe(2)
    pick('b-client', { target: 'auction', choice: 200 })
    expect(special()?.bid).toBeNull()
    pick('a-client', { target: 'auction', choice: 250 })
    expect(special()?.bid).toBeNull()
    pick('a-client', { target: 'auction', choice: 'allIn' })
    expect(special()?.leaderId).toBe(2)
    expect(special()?.allIn).toBe(true)
    expect(special()?.bid).toBe(300)
    session.dispose()
    actor.stop()
  })
})
