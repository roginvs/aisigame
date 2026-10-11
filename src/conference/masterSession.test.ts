import { createActor } from 'xstate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gameMachine, statePath } from '../game/machine.ts'
import { demoPack } from '../game/questions.ts'
import type { SavedMatch } from '../game/types.ts'
import type { GameVoice } from '../realtime/client.ts'
import { MasterSession } from './masterSession.ts'
import type { ConferenceMessage } from './messages.ts'
import { clearRememberedPlayersForTests } from './presence.ts'
import { PRESENCE_STALE_MS } from './presence.ts'
import type { ConferenceTransport } from './transport.ts'
import { formatDebugDump } from '../debug/trace.ts'
import { LOBBY_IDLE_INTERVAL_MS, LOBBY_SPEECH_MIN_INTERVAL_MS } from './lobbySpeech.ts'

class MemoryTransport implements ConferenceTransport {
  sent: ConferenceMessage[] = []
  private handlers = new Set<(message: ConferenceMessage, senderId: string) => void>()

  send(message: ConferenceMessage): void {
    this.sent.push(message)
  }

  subscribe(handler: (message: ConferenceMessage, senderId: string) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  receive(message: ConferenceMessage, senderId = 'guest-endpoint'): void {
    for (const handler of this.handlers) handler(message, senderId)
  }

  close(): void {}
}

const saved: SavedMatch = {
  players: [
    { id: 1, name: 'Мастер', score: 700, clientId: 'master-client' },
    { id: 2, name: 'Гость', score: 300, clientId: 'guest-client' },
  ],
  roundIndex: 0,
  playedIds: [],
  missedIds: [],
  chooserId: 2,
  finalists: [],
  bets: [],
  finalCursor: 0,
  betMisses: 0,
  activeQuestionId: null,
  activePlayerId: null,
  activeStake: null,
  attemptId: 0,
  clarifications: 0,
  heard: '',
  wrongHeard: [],
  sayCloseGuess: false,
  announceKind: null,
  judgmentStatus: null,
  phase: 'choosing.listening',
}

describe('MasterSession resume', () => {
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

  it('не рассылает lobby и возвращает прежнему clientId его playerId и счёт', () => {
    const actor = createActor(gameMachine)
    actor.start()
    const transport = new MemoryTransport()
    let chat: { name: string; text: string }[] = []
    const session = new MasterSession({
      transport,
      client: {} as GameVoice,
      actor,
      masterClientId: 'master-client',
      masterName: 'Мастер',
      pack: demoPack,
      packBytes: new Uint8Array([1, 2, 3]),
      packHash: 'hash',
      authorityToken: 'master-token',
      onRoster: () => {},
      getChat: () => chat,
      setChat: (next) => {
        chat = next
      },
      resumePlayers: saved.players,
    })

    expect(transport.sent.some((message) => message.type === 'snapshot' && message.phase === 'lobby')).toBe(false)
    session.resumeGame(() => {
      actor.send({ type: 'CONTINUE_GAME', pack: demoPack, saved })
      actor.send({ type: 'CONNECTED' })
    })

    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    expect(lastSnapshot(transport)?.phase).toBe('choosing.listening')
    expect(lastSnapshot(transport)?.players.find((player) => player.clientId === 'guest-client')).toMatchObject({
      id: 2,
      score: 300,
    })

    transport.receive({ type: 'hello', clientId: 'guest-client', authToken: 'guest-token', name: 'Гость' })
    transport.receive({ type: 'ready', clientId: 'guest-client', authToken: 'guest-token' })
    expect(session.rosterList().find((entry) => entry.clientId === 'guest-client')?.playerId).toBe(2)
    expect(actor.getSnapshot().context.players).toHaveLength(2)

    transport.receive(
      { type: 'chat', clientId: 'guest-client', authToken: 'guest-token', text: 'подмена' },
      'attacker-endpoint',
    )
    expect(chat).toEqual([])
    transport.receive({ type: 'chat', clientId: 'guest-client', authToken: 'guest-token', text: 'привет' })
    expect(chat).toEqual([{ name: 'Гость', text: 'привет' }])

    // Реконнект получает новый endpoint только с тем же секретом вкладки;
    // прежний endpoint после перепривязки больше не авторитетен.
    transport.receive(
      { type: 'hello', clientId: 'guest-client', authToken: 'guest-token', name: 'Гость' },
      'new-endpoint',
    )
    transport.receive(
      { type: 'chat', clientId: 'guest-client', authToken: 'guest-token', text: 'старый' },
      'guest-endpoint',
    )
    transport.receive(
      { type: 'chat', clientId: 'guest-client', authToken: 'guest-token', text: 'новый' },
      'new-endpoint',
    )
    expect(chat.map((line) => line.text)).toEqual(['привет', 'новый'])

    session.dispose()
    actor.stop()
  })

  it('показывает пакет сверенным до отдельного подтверждения готовности игрока', () => {
    const actor = createActor(gameMachine)
    actor.start()
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
      getChat: () => [],
      setChat: () => {},
    })

    transport.receive({ type: 'hello', clientId: 'guest-client', authToken: 'guest-token', name: 'Гость' })
    transport.receive({ type: 'ready', clientId: 'guest-client', authToken: 'guest-token' })
    expect(session.rosterList().find((entry) => entry.clientId === 'guest-client')).toMatchObject({
      hashOk: false,
      ready: false,
    })
    transport.receive({
      type: 'packVerified',
      clientId: 'guest-client',
      authToken: 'guest-token',
      hash: 'hash',
    })

    expect(session.rosterList().find((entry) => entry.clientId === 'guest-client')).toMatchObject({
      percent: 100,
      hashOk: true,
      ready: false,
    })
    expect(lastSnapshot(transport)?.presence.find((entry) => entry.clientId === 'guest-client')).toMatchObject({
      percent: 100,
      hashOk: true,
      ready: false,
    })

    session.dispose()
    actor.stop()
  })

  it('не перезапускает речь ведущей на каждом проценте загрузки', () => {
    const actor = createActor(gameMachine)
    actor.start()
    const transport = new MemoryTransport()
    const requestSpeech = vi.fn()
    const session = new MasterSession({
      transport,
      client: { requestSpeech } as unknown as GameVoice,
      actor,
      masterClientId: 'master-client',
      masterName: 'Мастер',
      pack: demoPack,
      packBytes: new Uint8Array([1, 2, 3]),
      packHash: 'hash',
      authorityToken: 'master-token',
      onRoster: () => {},
      getChat: () => [],
      setChat: () => {},
    })

    transport.receive({ type: 'hello', clientId: 'guest-client', authToken: 'guest-token', name: 'Гость' })
    const beforeProgress = requestSpeech.mock.calls.length
    transport.receive({
      type: 'packAck',
      clientId: 'guest-client',
      authToken: 'guest-token',
      hash: 'hash',
      nextIndex: 1,
    })
    vi.advanceTimersByTime(2_000)
    expect(requestSpeech).toHaveBeenCalledTimes(beforeProgress)

    session.dispose()
    actor.stop()
  })

  it('объединяет быстрые изменения лобби и не сбрасывает готовность повторной сверкой', () => {
    const actor = createActor(gameMachine)
    actor.start()
    const transport = new MemoryTransport()
    const requestSpeech = vi.fn()
    const session = new MasterSession({
      transport,
      client: { requestSpeech } as unknown as GameVoice,
      actor,
      masterClientId: 'master-client',
      masterName: 'Мастер',
      pack: demoPack,
      packBytes: new Uint8Array([1, 2, 3]),
      packHash: 'hash',
      authorityToken: 'master-token',
      onRoster: () => {},
      getChat: () => [],
      setChat: () => {},
    })

    const hello = { type: 'hello', clientId: 'guest-client', authToken: 'guest-token', name: 'Гость' } as const
    const verified = {
      type: 'packVerified',
      clientId: 'guest-client',
      authToken: 'guest-token',
      hash: 'hash',
    } as const
    transport.receive(hello)
    transport.receive(verified)
    transport.receive({ type: 'ready', clientId: 'guest-client', authToken: 'guest-token' })
    expect(requestSpeech).toHaveBeenCalledTimes(1)

    for (let elapsed = 0; elapsed < LOBBY_SPEECH_MIN_INTERVAL_MS; elapsed += 3_000) {
      vi.advanceTimersByTime(3_000)
      transport.receive(hello)
    }
    expect(requestSpeech).toHaveBeenCalledTimes(2)
    expect(requestSpeech.mock.calls.at(-1)?.[2]).toContain('Гость (игрок): пакет сверен, готов')

    transport.receive(verified)
    expect(session.rosterList().find((entry) => entry.clientId === 'guest-client')).toMatchObject({
      hashOk: true,
      ready: true,
    })
    for (let elapsed = 0; elapsed < LOBBY_SPEECH_MIN_INTERVAL_MS; elapsed += 3_000) {
      vi.advanceTimersByTime(3_000)
      transport.receive(hello)
    }
    expect(requestSpeech).toHaveBeenCalledTimes(2)

    session.dispose()
    actor.stop()
  })

  it('без изменений поддерживает ожидание одной репликой примерно раз в 15 секунд', () => {
    const actor = createActor(gameMachine)
    actor.start()
    const transport = new MemoryTransport()
    const requestSpeech = vi.fn()
    const session = new MasterSession({
      transport,
      client: { requestSpeech } as unknown as GameVoice,
      actor,
      masterClientId: 'master-client',
      masterName: 'Мастер',
      pack: demoPack,
      packBytes: new Uint8Array([1, 2, 3]),
      packHash: 'hash',
      authorityToken: 'master-token',
      onRoster: () => {},
      getChat: () => [],
      setChat: () => {},
    })

    vi.advanceTimersByTime(LOBBY_IDLE_INTERVAL_MS - 1)
    expect(requestSpeech).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(requestSpeech).toHaveBeenCalledTimes(2)
    expect(requestSpeech.mock.calls.at(-1)?.[2]).toContain('Статусы не изменились')
    vi.advanceTimersByTime(LOBBY_IDLE_INTERVAL_MS)
    expect(requestSpeech).toHaveBeenCalledTimes(3)

    session.dispose()
    actor.stop()
  })

  it('добавляет в debug dump только журнал аутентифицированного игрока', () => {
    const actor = createActor(gameMachine)
    actor.start()
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
      getChat: () => [],
      setChat: () => {},
    })
    transport.receive({ type: 'hello', clientId: 'guest-client', authToken: 'guest-token', name: 'Гость' })
    transport.receive(
      {
        type: 'debugLog',
        clientId: 'guest-client',
        authToken: 'guest-token',
        entries: [{ at: '2026-10-11T09:00:00.000Z', kind: 'note', title: 'чужой лог' }],
      },
      'attacker-endpoint',
    )
    transport.receive({
      type: 'debugLog',
      clientId: 'guest-client',
      authToken: 'guest-token',
      entries: [{ at: '2026-10-11T09:00:01.000Z', kind: 'note', title: 'камера недоступна' }],
    })

    const dump = formatDebugDump({ path: 'lobby', context: {} })
    expect(dump).toContain('### Гость (guest-client)')
    expect(dump).toContain('камера недоступна')
    expect(dump).not.toContain('чужой лог')

    session.dispose()
    actor.stop()
  })

  it('принимает кнопку только как кнопку аутентифицированного отправителя', () => {
    const actor = createActor(gameMachine)
    actor.start()
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
      getChat: () => [],
      setChat: () => {},
    })
    transport.receive({ type: 'hello', clientId: 'guest-client', authToken: 'guest-token', name: 'Гость' })
    transport.receive({
      type: 'packVerified',
      clientId: 'guest-client',
      authToken: 'guest-token',
      hash: 'hash',
    })
    transport.receive({ type: 'ready', clientId: 'guest-client', authToken: 'guest-token' })
    session.startGame(() => {})

    const send = vi.spyOn(actor, 'send')
    transport.receive({ type: 'buzz', clientId: 'guest-client', authToken: 'guest-token' })
    expect(send).toHaveBeenCalledWith({ type: 'BUZZER_PRESSED', playerId: 2 })
    send.mockClear()

    transport.receive(
      { type: 'buzz', clientId: 'guest-client', authToken: 'guest-token' },
      'attacker-endpoint',
    )
    expect(send).not.toHaveBeenCalled()

    session.dispose()
    actor.stop()
  })

  it('принимает выбор ячейки только от назначенного выбирающего', () => {
    const actor = createActor(gameMachine)
    actor.start()
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
      getChat: () => [],
      setChat: () => {},
    })
    const add = (clientId: string, authToken: string, name: string, endpoint: string) => {
      transport.receive({ type: 'hello', clientId, authToken, name }, endpoint)
      transport.receive({ type: 'packVerified', clientId, authToken, hash: 'hash' }, endpoint)
      transport.receive({ type: 'ready', clientId, authToken }, endpoint)
    }
    add('chooser-client', 'chooser-token', 'Выбирает', 'chooser-endpoint')
    add('other-client', 'other-token', 'Не выбирает', 'other-endpoint')
    session.startGame((players) => {
      actor.send({ type: 'START_GAME', pack: demoPack, players })
      actor.send({ type: 'CONNECTED' })
      actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
    })
    expect(actor.getSnapshot().context.chooserId).toBe(2)
    expect(session.endpointIdForClient('chooser-client')).toBe('chooser-endpoint')

    transport.receive(
      {
        type: 'pick',
        clientId: 'other-client',
        authToken: 'other-token',
        themeId: 'history',
        value: 100,
      },
      'other-endpoint',
    )
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')

    transport.receive(
      {
        type: 'pick',
        clientId: 'chooser-client',
        authToken: 'chooser-token',
        themeId: 'history',
        value: 100,
      },
      'chooser-endpoint',
    )
    expect(statePath(actor.getSnapshot().value)).toBe('flashing')

    session.dispose()
    actor.stop()
  })

  it('через 10 секунд передаёт выбор отключившегося игрока мастеру', () => {
    const actor = createActor(gameMachine)
    actor.start()
    const transport = new MemoryTransport()
    const session = new MasterSession({
      transport,
      client: { requestSpeech: vi.fn() } as unknown as GameVoice,
      actor,
      masterClientId: 'master-client',
      masterName: 'Маша',
      pack: demoPack,
      packBytes: new Uint8Array([1, 2, 3]),
      packHash: 'hash',
      authorityToken: 'master-token',
      onRoster: () => {},
      getChat: () => [],
      setChat: () => {},
    })
    transport.receive({ type: 'hello', clientId: 'guest-client', authToken: 'guest-token', name: 'Вася' })
    transport.receive({
      type: 'packVerified',
      clientId: 'guest-client',
      authToken: 'guest-token',
      hash: 'hash',
    })
    transport.receive({ type: 'ready', clientId: 'guest-client', authToken: 'guest-token' })
    session.startGame((players) => {
      actor.send({ type: 'START_GAME', pack: demoPack, players })
      actor.send({ type: 'CONNECTED' })
      actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
    })
    expect(actor.getSnapshot().context.chooserId).toBe(2)

    vi.advanceTimersByTime(PRESENCE_STALE_MS - 1)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    vi.advanceTimersByTime(1)
    expect(statePath(actor.getSnapshot().value)).toBe('chooserHandoff')
    expect(actor.getSnapshot().context.chooserId).toBe(1)
    expect(actor.getSnapshot().context.clarifyReason).toBe('Вася отключился. Маша, выбирайте вопрос.')

    session.dispose()
    actor.stop()
  })

  it('не передаёт чужой ответ при отключении, а ждёт таймаут', () => {
    const actor = createActor(gameMachine)
    actor.start()
    const transport = new MemoryTransport()
    const session = new MasterSession({
      transport,
      client: { requestSpeech: vi.fn() } as unknown as GameVoice,
      actor,
      masterClientId: 'master-client',
      masterName: 'Маша',
      pack: demoPack,
      packBytes: new Uint8Array([1, 2, 3]),
      packHash: 'hash',
      authorityToken: 'master-token',
      onRoster: () => {},
      getChat: () => [],
      setChat: () => {},
    })
    transport.receive({ type: 'hello', clientId: 'guest-client', authToken: 'guest-token', name: 'Вася' })
    transport.receive({
      type: 'packVerified',
      clientId: 'guest-client',
      authToken: 'guest-token',
      hash: 'hash',
    })
    transport.receive({ type: 'ready', clientId: 'guest-client', authToken: 'guest-token' })
    session.startGame((players) => {
      actor.send({ type: 'START_GAME', pack: demoPack, players })
      actor.send({ type: 'CONNECTED' })
      actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
    })
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'history', value: 100 })
    vi.advanceTimersByTime(1_100)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    actor.send({ type: 'BUZZER_PRESSED', playerId: 2 })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    const send = vi.spyOn(actor, 'send')

    vi.advanceTimersByTime(PRESENCE_STALE_MS)
    expect(statePath(actor.getSnapshot().value)).toBe('announcing')
    expect(actor.getSnapshot().context.chooserId).toBe(2)
    expect(send.mock.calls.some(([event]) => event.type === 'CHOOSER_OFFLINE')).toBe(false)

    session.dispose()
    actor.stop()
  })
})

function lastSnapshot(transport: MemoryTransport) {
  return transport.sent.filter((message) => message.type === 'snapshot').at(-1)
}
