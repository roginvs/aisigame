import { getTrace } from '../debug/trace.ts'
import { gameConfig } from '../config.ts'
import { createActor } from 'xstate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCommit } from '../buildInfo.ts'
import { gameMachine, statePath } from '../game/machine.ts'
import { demoPack } from '../game/questions.ts'
import type { Player, SavedMatch } from '../game/types.ts'
import type { GameVoice } from '../realtime/client.ts'
import { MasterSession } from './masterSession.ts'
import { isConferenceMessage, type ConferenceMessage, type ConferenceState } from './messages.ts'
import { emptyMessageRing, readMessageRing, messageRingEntries } from './messageRing.ts'
import { snapshotFromState } from './stateProtocol.ts'
import { CHUNK_BYTES } from './chunks.ts'
import { decodePackChunkBinary } from './packPipeCodec.ts'
import { clearRememberedPlayersForTests, PRESENCE_HEARTBEAT_MS, PRESENCE_STALE_MS } from './presence.ts'
import type { ConferenceChatLine, ConferenceMessageRing } from './messages.ts'
import type { ConferenceTransport } from './transport.ts'
import { formatDebugDump, pushHostLine, pushPlayerLine, pushJudgeLine } from '../debug/trace.ts'
import {
  LOBBY_IDLE_INTERVAL_MS,
  LOBBY_SILENCE_BEFORE_SPEECH_MS,
  LOBBY_SILENCE_POLL_MS,
  LOBBY_SPEECH_MIN_INTERVAL_MS,
} from './lobbySpeech.ts'

/** Первая реплика лобби ждёт короткой тишины комнаты. */
function flushLobbySilence(): void {
  vi.advanceTimersByTime(LOBBY_SILENCE_BEFORE_SPEECH_MS)
}

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

  it('первым шлёт полный статус; дальше дифы, полный ответ только на запрос привязанного клиента', () => {
    const actor = createActor(gameMachine).start()
    const transport = new MemoryTransport()
    const session = new MasterSession({
      transport, actor, client: { requestSpeech: vi.fn() } as unknown as GameVoice,
      masterClientId: 'master-client', masterName: 'Мастер', pack: demoPack,
      packBytes: new Uint8Array([1, 2, 3]), packHash: 'hash', authorityToken: 'master-token',
      onRoster: () => {},
    })
    expect(transport.sent[0]?.type).toBe('snapshot')
    vi.advanceTimersByTime(2_000)
    transport.receive({ type: 'hello', clientId: 'guest-client', authToken: 'guest-token', name: 'Гость' })
    expect(transport.sent.filter((message) => message.type === 'snapshot')).toHaveLength(1)
    expect(transport.sent.some((message) => message.type === 'partialUpdate' && message.changes.presence)).toBe(true)
    transport.receive({ type: 'statusRequest', clientId: 'guest-client', authToken: 'guest-token' }, 'attacker')
    expect(transport.sent.filter((message) => message.type === 'snapshot')).toHaveLength(1)
    transport.receive({ type: 'statusRequest', clientId: 'guest-client', authToken: 'guest-token' })
    expect(transport.sent.filter((message) => message.type === 'snapshot')).toHaveLength(2)
    expect(transport.sent.at(-1)).toMatchObject({ type: 'snapshot', presence: expect.arrayContaining([expect.objectContaining({ name: 'Гость' })]) })
    expect(transport.sent.at(-1)).not.toHaveProperty('targetClientId')
    expect(transport.sent.every(isConferenceMessage)).toBe(true)
    session.dispose()
    actor.stop()
  })

  it('чат одинаковых имён передаёт контроллеру id из привязанного clientId, включая мастера', () => {
    const players = [
      { id: 1, name: 'Вася', score: 0, clientId: 'master-client' },
      { id: 2, name: 'Вася', score: 0, clientId: 'guest-a' },
      { id: 3, name: 'Вася', score: 0, clientId: 'guest-b' },
    ]
    const actor = createActor(gameMachine).start()
    actor.send({ type: 'CONTINUE_GAME', pack: demoPack, saved: { ...saved, players } })
    actor.send({ type: 'CONNECTED' })
    const transport = new MemoryTransport()
    const onChatLine = vi.fn()
    const session = new MasterSession({
      transport, actor, client: { requestSpeech: vi.fn() } as unknown as GameVoice,
      masterClientId: 'master-client', masterName: 'Вася', pack: demoPack,
      packBytes: new Uint8Array([1, 2, 3]), packHash: 'hash', authorityToken: 'master-token',
      onRoster: () => {}, resumePlayers: players, onChatLine,
    })
    for (const [clientId, endpoint] of [['guest-a', 'endpoint-a'], ['guest-b', 'endpoint-b']]) {
      if (!clientId || !endpoint) throw new Error('нет тестового участника')
      transport.receive({ type: 'hello', clientId, authToken: clientId, name: 'Вася' }, endpoint)
      transport.receive({ type: 'chat', clientId, authToken: clientId, text: 'ответ' }, endpoint)
    }
    session.sendChat('ответ мастера')
    expect(onChatLine.mock.calls).toEqual([[2, 'ответ'], [3, 'ответ'], [1, 'ответ мастера']])
    session.dispose()
    actor.stop()
  })

  it('публикует чат, речь ведущей, услышанное и оценку сразу, ровно двумя полями', () => {
    const actor = createActor(gameMachine).start()
    const transport = new MemoryTransport()
    const onHistory = vi.fn()
    const session = new MasterSession({
      transport, actor, client: { requestSpeech: vi.fn() } as unknown as GameVoice,
      masterClientId: 'master-client', masterName: 'Мастер', pack: demoPack,
      packBytes: new Uint8Array([1, 2, 3]), packHash: 'hash', authorityToken: 'master-token',
      onRoster: () => {}, onHistory,
    })
    const start = transport.sent.length
    session.sendChat('Привет')
    pushHostLine('Новая реплика кольцевого буфера')
    pushPlayerLine('Ответ игрока')
    pushJudgeLine('Верно')
    const updates = transport.sent.slice(start)
    expect(updates).toHaveLength(4)
    expect(onHistory).toHaveBeenCalledTimes(4)
    for (const message of updates) {
      expect(message.type).toBe('partialUpdate')
      if (message.type !== 'partialUpdate') throw new Error('нет дифа')
      expect(Object.keys(message.changes)).toHaveLength(2)
      expect(message.changes).toHaveProperty('messageIndex')
      expect(message.changes).toHaveProperty(`message${String(message.changes.messageIndex)}`)
      expect(isConferenceMessage(message)).toBe(true)
    }
    expect(chatLines(lastSnapshot(transport))).toEqual([expect.objectContaining({ text: 'Привет' })])
    expect(messageRingEntries(lastSnapshot(transport)!).filter(({ message }) => message.kind === 'conversation').slice(-3).map(({ message }) => message.text)).toEqual(['Новая реплика кольцевого буфера', 'Ответ игрока', 'Верно'])
    session.dispose()
    const count = transport.sent.length
    pushPlayerLine('После выхода')
    expect(transport.sent).toHaveLength(count)
    actor.stop()
  })

  it('первый статус после продолжения содержит исходные слоты, note и индекс; новая реплика продолжает кольцо', () => {
    const actor = createActor(gameMachine).start()
    const transport = new MemoryTransport()
    const history = emptyMessageRing()
    history.messageIndex = 199
    history.message198 = { kind: 'chat', name: 'Гость', text: 'Чат перед обновлением' }
    history.message199 = { kind: 'conversation', role: 'host', text: 'Верно', note: 'Правильный ответ: Август' }
    pushHostLine('Посторонняя реплика trace до подключения комнаты')
    const onHistory = vi.fn()
    const session = new MasterSession({
      transport, actor, client: {} as GameVoice,
      masterClientId: 'master-client', masterName: 'Мастер', pack: demoPack,
      packBytes: new Uint8Array([1, 2, 3]), packHash: 'hash', authorityToken: 'master-token',
      onRoster: () => {}, onHistory, messageRing: history, resumePlayers: saved.players,
    })
    session.resumeGame(() => {
      actor.send({ type: 'CONTINUE_GAME', pack: demoPack, saved })
      actor.send({ type: 'CONNECTED' })
    })
    const first = transport.sent.find((message) => message.type === 'snapshot')
    expect(readMessageRing(first)).toEqual(history)
    pushHostLine('Реплика после продолжения')
    const next = readMessageRing(lastSnapshot(transport))!
    expect(next.messageIndex).toBe(0)
    expect(next.message0).toMatchObject({ kind: 'conversation', text: 'Реплика после продолжения' })
    expect(next.message199).toEqual(history.message199)
    expect(onHistory).toHaveBeenLastCalledWith(next)
    session.dispose()
    actor.stop()
  })

  it('не рассылает lobby и возвращает прежнему clientId его playerId и счёт', () => {
    const actor = createActor(gameMachine)
    actor.start()
    const transport = new MemoryTransport()
    let chat: { name: string; text: string; at?: string }[] = []
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
      onHistory: (next) => {
        chat = chatLines(next)
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
    expect(lastSnapshot(transport)?.commit).toBe(buildCommit())
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
    expect(chat).toMatchObject([{ name: 'Гость', text: 'привет' }])
    expect(chat[0]?.at).toEqual(expect.any(String))

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

    // Нехватка заготовленных <audio> у игрока: строка в «Разговор» у всех с именем из roster, не из сообщения.
    transport.receive(
      { type: 'audioSinkNote', clientId: 'guest-client', authToken: 'guest-token', owner: 'Ведущая' },
      'guest-endpoint',
    )
    transport.receive({ type: 'audioSinkNote', clientId: 'guest-client', authToken: 'guest-token', owner: 'Ведущая' }, 'new-endpoint')
    const notes = getTrace().filter((entry) => entry.kind === 'chat' && JSON.stringify(entry.detail).includes('заготовленные аудиоэлементы'))
    expect(notes).toHaveLength(1)
    expect(JSON.stringify(notes[0]?.detail)).toContain('у Гость закончились заготовленные аудиоэлементы, создан новый (дорожка от Ведущая)')

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

  it('heartbeat сохраняет прогресс packPipe, а новый endpoint закрывает старый peer и повторяет передачу', async () => {
    class FakeDc {
      bufferedAmount = 0
      bufferedAmountLowThreshold = 0
      binaryType = 'arraybuffer'
      readyState = 'connecting'
      onopen: (() => void) | null = null
      onclose: (() => void) | null = null
      onerror: (() => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onbufferedamountlow: (() => void) | null = null
      send = vi.fn()
      close = vi.fn(() => { this.readyState = 'closed' })
    }
    const peers: FakePc[] = []
    class FakePc {
      constructor() { peers.push(this) }
      dc = new FakeDc()
      connectionState = 'new'
      localDescription: { type: string; sdp: string } | null = null
      onicecandidate: ((event: { candidate: null }) => void) | null = null
      onconnectionstatechange: (() => void) | null = null
      createDataChannel(): FakeDc {
        return this.dc
      }
      async createOffer(): Promise<{ type: string; sdp: string }> {
        return { type: 'offer', sdp: 'v=0' }
      }
      async setLocalDescription(desc: { type: string; sdp: string }): Promise<void> {
        this.localDescription = desc
      }
      close = vi.fn()
    }
    vi.stubGlobal('RTCPeerConnection', FakePc)

    const actor = createActor(gameMachine)
    actor.start()
    const transport = new MemoryTransport()
    const packBytes = new Uint8Array(CHUNK_BYTES * 10)
    const session = new MasterSession({
      transport,
      client: { requestSpeech: vi.fn() } as unknown as GameVoice,
      actor,
      masterClientId: 'master-client',
      masterName: 'Мастер',
      pack: demoPack,
      packBytes,
      packHash: 'hash',
      authorityToken: 'master-token',
      onRoster: () => {},
      usePackPipe: true,
    })

    const hello = { type: 'hello', clientId: 'guest-client', authToken: 'guest-token', name: 'Мобилка' } as const
    transport.receive(hello)
    expect(session.rosterList().find((entry) => entry.clientId === 'guest-client')?.packPhase).toBe(
      'connecting',
    )

    transport.receive({
      type: 'packAck',
      clientId: 'guest-client',
      authToken: 'guest-token',
      hash: 'hash',
      nextIndex: 4,
    })
    expect(session.rosterList().find((entry) => entry.clientId === 'guest-client')).toMatchObject({
      percent: 40,
      packPhase: 'downloading',
    })

    transport.receive(hello)
    transport.receive(hello)
    expect(session.rosterList().find((entry) => entry.clientId === 'guest-client')).toMatchObject({
      percent: 40,
      packPhase: 'downloading',
    })
    expect(lastSnapshot(transport)?.presence.find((entry) => entry.clientId === 'guest-client')).toMatchObject({
      percent: 40,
      packPhase: 'downloading',
    })

    const oldPeer = peers[0]!
    oldPeer.dc.readyState = 'open'
    oldPeer.dc.onopen?.()
    transport.receive({ type: 'packAck', clientId: 'guest-client', authToken: 'guest-token', hash: 'hash', nextIndex: 10 })
    transport.receive({ type: 'packVerified', clientId: 'guest-client', authToken: 'guest-token', hash: 'hash' })
    transport.receive({ type: 'ready', clientId: 'guest-client', authToken: 'guest-token' })
    expect(session.rosterList().find((entry) => entry.clientId === 'guest-client')).toMatchObject({ hashOk: true, ready: true })
    transport.receive({ ...hello, authToken: 'wrong-token' }, 'reloaded-endpoint')
    expect(peers).toHaveLength(1)
    expect(oldPeer.close).not.toHaveBeenCalled()

    transport.receive(hello, 'reloaded-endpoint')
    expect(peers).toHaveLength(2)
    expect(oldPeer.close).toHaveBeenCalledTimes(1)
    expect(oldPeer.dc.close).toHaveBeenCalledTimes(1)
    expect(session.rosterList().find((entry) => entry.clientId === 'guest-client')).toMatchObject({
      percent: 0, hashOk: false, ready: false, packPhase: 'connecting', downloadBps: null, etaSeconds: null,
    })
    expect(lastSnapshot(transport)?.presence.find((entry) => entry.clientId === 'guest-client')).toMatchObject({ hashOk: false, ready: false })
    // Поздний ACK/ошибка закрытого peer не меняют новый канал и его процент.
    oldPeer.dc.onmessage?.(new MessageEvent('message', { data: JSON.stringify({
      type: 'packAck', clientId: 'guest-client', authToken: 'guest-token', hash: 'hash', nextIndex: 10,
    }) }))
    oldPeer.dc.onerror?.()
    oldPeer.dc.onclose?.()
    expect(session.rosterList().find((entry) => entry.clientId === 'guest-client')).toMatchObject({ percent: 0, packPhase: 'connecting' })
    await vi.advanceTimersByTimeAsync(0)
    // Старый createOffer мог ещё выполняться в момент reload: он не уходит в эфир.
    expect(transport.sent.filter((message) => message.type === 'packPipeOffer')).toHaveLength(1)
    const nextPeer = peers[1]!
    nextPeer.dc.readyState = 'open'
    nextPeer.dc.onopen?.()
    expect(nextPeer.dc.send).not.toHaveBeenCalled()
    transport.receive({ type: 'packAck', clientId: 'guest-client', authToken: 'guest-token', hash: 'hash', nextIndex: 0 }, 'reloaded-endpoint')
    const offer = nextPeer.dc.send.mock.calls[0]?.[0]
    expect(typeof offer).toBe('string')
    expect(JSON.parse(offer as string)).toMatchObject({ type: 'packOffer', targetClientId: 'guest-client', hash: 'hash' })
    const chunks = nextPeer.dc.send.mock.calls
      .filter(([payload]) => payload instanceof ArrayBuffer)
      .map(([payload]) => decodePackChunkBinary(payload as ArrayBuffer)?.index)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks).toEqual(Array.from({ length: chunks.length }, (_, i) => i))
    transport.receive({ type: 'ready', clientId: 'guest-client', authToken: 'guest-token' }, 'reloaded-endpoint')
    expect(session.rosterList().find((entry) => entry.clientId === 'guest-client')?.ready).toBe(false)
    const count = nextPeer.dc.send.mock.calls.length
    transport.receive(hello, 'reloaded-endpoint')
    expect(nextPeer.dc.send.mock.calls).toHaveLength(count)
    expect(peers).toHaveLength(2)

    // Full unacknowledged window is lost with the channel, without an endpoint reload.
    nextPeer.dc.readyState = 'closed'
    nextPeer.dc.onclose?.()
    transport.receive(hello, 'reloaded-endpoint')
    expect(peers).toHaveLength(3)
    const recoveredPeer = peers[2]!
    recoveredPeer.dc.readyState = 'open'
    recoveredPeer.dc.onopen?.()
    const recoveredChunks = recoveredPeer.dc.send.mock.calls
      .filter(([payload]) => payload instanceof ArrayBuffer)
      .map(([payload]) => decodePackChunkBinary(payload as ArrayBuffer)?.index)
    expect(recoveredChunks).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    transport.receive({ type: 'packAck', clientId: 'guest-client', authToken: 'guest-token', hash: 'hash', nextIndex: 8 }, 'reloaded-endpoint')
    expect(recoveredPeer.dc.send.mock.calls
      .filter(([payload]) => payload instanceof ArrayBuffer)
      .map(([payload]) => decodePackChunkBinary(payload as ArrayBuffer)?.index)).toContain(9)
    transport.receive({ type: 'packVerified', clientId: 'guest-client', authToken: 'guest-token', hash: 'hash' }, 'reloaded-endpoint')
    transport.receive({ type: 'ready', clientId: 'guest-client', authToken: 'guest-token' }, 'reloaded-endpoint')
    expect(session.rosterList().find((entry) => entry.clientId === 'guest-client')).toMatchObject({ hashOk: true, ready: true })

    session.dispose()
    actor.stop()
    vi.unstubAllGlobals()
  })

  it('fallback: если WebRTC не открылся за 30 с, пакет идёт кусками через Jitsi; открытый канал fallback не включает', () => {
    const peers: { dc: { readyState: string; onopen: (() => void) | null } }[] = []
    class FakePc {
      dc = {
        bufferedAmount: 0, bufferedAmountLowThreshold: 0, binaryType: 'arraybuffer', readyState: 'connecting',
        onopen: null as (() => void) | null, onclose: null, onerror: null, onmessage: null, onbufferedamountlow: null,
        send: vi.fn(), close: vi.fn(),
      }
      constructor() { peers.push(this) }
      connectionState = 'new'
      localDescription: unknown = null
      onicecandidate: unknown = null
      onconnectionstatechange: unknown = null
      createDataChannel() { return this.dc }
      async createOffer() { return { type: 'offer', sdp: 'v=0' } }
      async setLocalDescription(desc: unknown) { this.localDescription = desc }
      close = vi.fn()
    }
    vi.stubGlobal('RTCPeerConnection', FakePc)
    const make = () => {
      const actor = createActor(gameMachine)
      actor.start()
      const transport = new MemoryTransport()
      new MasterSession({
        transport,
        client: { requestSpeech: vi.fn() } as unknown as GameVoice,
        actor,
        masterClientId: 'master-client',
        masterName: 'Мастер',
        pack: demoPack,
        packBytes: new Uint8Array(CHUNK_BYTES * 3),
        packHash: 'hash',
        authorityToken: 'master-token',
        onRoster: () => {},
        usePackPipe: true,
      })
      return transport
    }
    const hello = { type: 'hello', clientId: 'guest-client', authToken: 'guest-token', name: 'Игрок' } as const
    const bridged = (transport: MemoryTransport) =>
      transport.sent.filter((m) => m.type === 'packOffer' || m.type === 'packChunk').map((m) => m.type)

    const slow = make()
    slow.receive(hello)
    vi.advanceTimersByTime(29_000)
    slow.receive(hello)
    expect(bridged(slow)).toEqual([])
    vi.advanceTimersByTime(1_000)
    expect(bridged(slow)).toEqual(['packOffer', 'packChunk', 'packChunk', 'packChunk'])

    peers.length = 0
    const fast = make()
    fast.receive(hello)
    const peer = peers[0]!
    peer.dc.readyState = 'open'
    peer.dc.onopen?.()
    vi.advanceTimersByTime(31_000)
    expect(bridged(fast)).toEqual([])
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

  it('кладёт скорость и ETA в roster и снимок по packAck', () => {
    const actor = createActor(gameMachine)
    actor.start()
    const transport = new MemoryTransport()
    const packBytes = new Uint8Array(CHUNK_BYTES * 10)
    const session = new MasterSession({
      transport,
      client: { requestSpeech: vi.fn() } as unknown as GameVoice,
      actor,
      masterClientId: 'master-client',
      masterName: 'Мастер',
      pack: demoPack,
      packBytes,
      packHash: 'hash',
      authorityToken: 'master-token',
      onRoster: () => {},
    })

    transport.receive({ type: 'hello', clientId: 'guest-client', authToken: 'guest-token', name: 'Гость' })
    transport.receive({
      type: 'packAck',
      clientId: 'guest-client',
      authToken: 'guest-token',
      hash: 'hash',
      nextIndex: 2,
    })
    vi.advanceTimersByTime(1_000)
    transport.receive({
      type: 'packAck',
      clientId: 'guest-client',
      authToken: 'guest-token',
      hash: 'hash',
      nextIndex: 4,
    })

    const entry = session.rosterList().find((row) => row.clientId === 'guest-client')
    expect(entry).toMatchObject({ percent: 40 })
    expect(entry?.downloadBps).toBeGreaterThan(0)
    expect(entry?.etaSeconds).toBeGreaterThan(0)

    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS)
    const presence = lastSnapshot(transport)?.presence.find((row) => row.clientId === 'guest-client')
    expect(presence).toMatchObject({ percent: 40 })
    expect(presence?.downloadBps).toBeGreaterThan(0)
    expect(presence?.etaSeconds).toBeGreaterThan(0)

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
    })

    const hello = { type: 'hello', clientId: 'guest-client', authToken: 'guest-token', name: 'Гость' } as const
    const verified = {
      type: 'packVerified',
      clientId: 'guest-client',
      authToken: 'guest-token',
      hash: 'hash',
    } as const
    flushLobbySilence()
    expect(requestSpeech).toHaveBeenCalledTimes(1)

    transport.receive(hello)
    transport.receive(verified)
    transport.receive({ type: 'ready', clientId: 'guest-client', authToken: 'guest-token' })
    expect(requestSpeech).toHaveBeenCalledTimes(1)

    for (let elapsed = 0; elapsed < LOBBY_SPEECH_MIN_INTERVAL_MS; elapsed += 3_000) {
      vi.advanceTimersByTime(3_000)
      transport.receive(hello)
    }
    flushLobbySilence()
    expect(requestSpeech).toHaveBeenCalledTimes(2)
    expect(requestSpeech.mock.calls.at(-1)?.[2]).toContain('Гость: пакет сверен, кнопка нажата')

    transport.receive(verified)
    expect(session.rosterList().find((entry) => entry.clientId === 'guest-client')).toMatchObject({
      hashOk: true,
      ready: true,
    })
    for (let elapsed = 0; elapsed < LOBBY_SPEECH_MIN_INTERVAL_MS; elapsed += 3_000) {
      vi.advanceTimersByTime(3_000)
      transport.receive(hello)
    }
    flushLobbySilence()
    expect(requestSpeech).toHaveBeenCalledTimes(2)

    session.dispose()
    actor.stop()
  })

  it('без изменений поддерживает ожидание одной репликой примерно раз в 25 секунд', () => {
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
    })

    flushLobbySilence()
    expect(requestSpeech).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(LOBBY_IDLE_INTERVAL_MS - 1)
    expect(requestSpeech).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    flushLobbySilence()
    expect(requestSpeech).toHaveBeenCalledTimes(2)
    expect(requestSpeech.mock.calls.at(-1)?.[2]).toContain('Статусы не изменились')
    vi.advanceTimersByTime(LOBBY_IDLE_INTERVAL_MS)
    flushLobbySilence()
    expect(requestSpeech).toHaveBeenCalledTimes(3)

    session.dispose()
    actor.stop()
  })

  it('пауза в лобби: гость ставит и снимает, в модель ничего не уходит', () => {
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
    })

    flushLobbySilence()
    expect(requestSpeech).toHaveBeenCalledTimes(1)

    transport.receive({ type: 'hello', clientId: 'guest-client', authToken: 'guest-token', name: 'Гость' })
    transport.receive({ type: 'packVerified', clientId: 'guest-client', authToken: 'guest-token', hash: 'hash' })
    for (let elapsed = 0; elapsed < LOBBY_SPEECH_MIN_INTERVAL_MS; elapsed += 3_000) {
      vi.advanceTimersByTime(3_000)
      transport.receive({ type: 'hello', clientId: 'guest-client', authToken: 'guest-token', name: 'Гость' })
    }
    flushLobbySilence()
    expect(requestSpeech).toHaveBeenCalledTimes(2)

    transport.receive({ type: 'pause', clientId: 'guest-client', authToken: 'guest-token' })
    expect(statePath(actor.getSnapshot().value)).toBe('paused')
    expect(lastSnapshot(transport)?.lobbyPaused).toBe(true)

    // На паузе ни напоминаний ожидания, ни реакции на смену состава.
    requestSpeech.mockClear()
    vi.advanceTimersByTime(LOBBY_IDLE_INTERVAL_MS * 3)
    flushLobbySilence()
    transport.receive({ type: 'hello', clientId: 'guest2-client', authToken: 'guest2-token', name: 'Второй' })
    transport.receive({ type: 'packVerified', clientId: 'guest2-client', authToken: 'guest2-token', hash: 'hash' })
    vi.advanceTimersByTime(LOBBY_IDLE_INTERVAL_MS * 3)
    flushLobbySilence()
    expect(requestSpeech).not.toHaveBeenCalled()

    transport.receive({ type: 'pause', clientId: 'guest-client', authToken: 'guest-token' })
    expect(statePath(actor.getSnapshot().value)).toBe('startMenu')
    expect(lastSnapshot(transport)?.lobbyPaused).toBeFalsy()

    session.dispose()
    actor.stop()
  })

  it('паузу в лобби ставит только сверивший пакет гость; старт партии снимает паузу', () => {
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
    })

    transport.receive({ type: 'hello', clientId: 'guest-client', authToken: 'guest-token', name: 'Гость' })
    transport.receive({ type: 'pause', clientId: 'guest-client', authToken: 'guest-token' })
    expect(statePath(actor.getSnapshot().value)).toBe('startMenu')
    expect(lastSnapshot(transport)?.lobbyPaused).toBeFalsy()

    transport.receive({ type: 'packVerified', clientId: 'guest-client', authToken: 'guest-token', hash: 'hash' })
    transport.receive({ type: 'pause', clientId: 'guest-client', authToken: 'guest-token' })
    expect(statePath(actor.getSnapshot().value)).toBe('paused')

    session.startGame(() => {
      actor.send({
        type: 'START_GAME',
        pack: demoPack,
        players: [{ id: 1, name: 'Мастер', score: 0, clientId: 'master-client' }],
      })
    })
    expect(statePath(actor.getSnapshot().value)).toBe('connecting')
    expect(lastSnapshot(transport)?.lobbyPaused).toBeFalsy()

    session.dispose()
    actor.stop()
  })

  it('в лобби не говорит, пока в комнате есть речь, и ждёт короткую тишину', () => {
    const actor = createActor(gameMachine)
    actor.start()
    const transport = new MemoryTransport()
    const requestSpeech = vi.fn()
    let speaking = true
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
      isRoomSpeaking: () => speaking,
    })

    vi.advanceTimersByTime(LOBBY_SILENCE_BEFORE_SPEECH_MS + 5_000)
    expect(requestSpeech).toHaveBeenCalledTimes(0)
    speaking = false
    // Сначала догоняем опрос, который ещё ждал речи, затем окно тишины.
    vi.advanceTimersByTime(LOBBY_SILENCE_POLL_MS)
    flushLobbySilence()
    expect(requestSpeech).toHaveBeenCalledTimes(1)
    expect(requestSpeech.mock.calls[0]?.[0]).toBe('lobby')

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

  it('два имени одного устройства — два игрока; кнопка и ставка несут playerId, чужой id молчит', () => {
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
    })
    transport.receive({
      type: 'hello',
      clientId: 'guest-client',
      authToken: 'guest-token',
      name: 'Аня, Боря',
      names: ['Аня', 'Боря'],
    })
    transport.receive({ type: 'packVerified', clientId: 'guest-client', authToken: 'guest-token', hash: 'hash' })
    transport.receive({ type: 'ready', clientId: 'guest-client', authToken: 'guest-token' })
    const started: Player[] = []
    session.startGame((players) => {
      started.push(...players)
      actor.send({ type: 'START_GAME', pack: demoPack, players })
      actor.send({ type: 'CONNECTED' })
    })
    expect(started.map((player) => player.name)).toEqual(['Мастер', 'Аня', 'Боря'])
    expect(started.filter((player) => player.clientId === 'guest-client').map((player) => player.id)).toEqual([2, 3])

    const send = vi.spyOn(actor, 'send')
    transport.receive({ type: 'buzz', clientId: 'guest-client', authToken: 'guest-token', playerId: 3 })
    expect(send).toHaveBeenCalledWith({ type: 'BUZZER_PRESSED', playerId: 3 })
    send.mockClear()
    transport.receive({ type: 'buzz', clientId: 'guest-client', authToken: 'guest-token', playerId: 1 })
    expect(send).not.toHaveBeenCalled()
    transport.receive({ type: 'buzz', clientId: 'guest-client', authToken: 'guest-token' })
    expect(send).not.toHaveBeenCalled()
    transport.receive({ type: 'finalStake', clientId: 'guest-client', authToken: 'guest-token', playerId: 2, amount: 10 })
    expect(send).toHaveBeenCalledWith({ type: 'FINAL_STAKE', playerId: 2, amount: 10 })
    send.mockClear()
    transport.receive({ type: 'finalAnswer', clientId: 'guest-client', authToken: 'guest-token', playerId: 3, text: 'море' })
    expect(send).toHaveBeenCalledWith({ type: 'FINAL_TYPED', playerId: 3, text: 'море' })

    session.dispose()
    actor.stop()
  })

  it('игрок toggle-ит паузу: ставит и снимает, в лобби и в партии одинаково', () => {
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
    })
    transport.receive({ type: 'hello', clientId: 'guest-client', authToken: 'guest-token', name: 'Гость' })
    transport.receive({ type: 'packVerified', clientId: 'guest-client', authToken: 'guest-token', hash: 'hash' })
    transport.receive({ type: 'ready', clientId: 'guest-client', authToken: 'guest-token' })
    // Пауза в лобби работает так же, как в партии: toggle ставит машину на паузу до старта.
    transport.receive({ type: 'pause', clientId: 'guest-client', authToken: 'guest-token' })
    expect(statePath(actor.getSnapshot().value)).toBe('paused')
    expect(actor.getSnapshot().context.resumePath).toBe('startMenu')
    // Старт партии сам снимает лобби-паузу.
    session.startGame(() => {
      actor.send({ type: 'START_GAME', pack: demoPack })
      actor.send({ type: 'CONNECTED' })
      actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
    })
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')

    // Игрок ставит паузу…
    transport.receive({ type: 'pause', clientId: 'guest-client', authToken: 'guest-token' })
    expect(statePath(actor.getSnapshot().value)).toBe('paused')
    expect(actor.getSnapshot().context.resumePath).toBe('choosing.listening')
    // …и снимает её.
    transport.receive({ type: 'pause', clientId: 'guest-client', authToken: 'guest-token' })
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')

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
    expect(actor.getSnapshot().context.clarifyReason).toBe('Вася отключился')

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

    vi.advanceTimersByTime(Math.max(PRESENCE_STALE_MS, gameConfig.answerMs))
    expect(statePath(actor.getSnapshot().value)).toBe('announcing.speaking')
    expect(actor.getSnapshot().context.chooserId).toBe(2)
    expect(send.mock.calls.some(([event]) => event.type === 'CHOOSER_OFFLINE')).toBe(false)

    session.dispose()
    actor.stop()
  })
})

function lastSnapshot(transport: MemoryTransport) {
  let state: ConferenceState | null = null
  for (const message of transport.sent) {
    if (message.type === 'snapshot') {
      const { type: _type, authorityToken: _token, revision: _revision, ...fields } = message
      state = fields
    } else if (message.type === 'partialUpdate' && state) {
      state = Object.assign({}, state, message.changes)
    }
  }
  return state ? snapshotFromState(state) : null
}

function chatLines(ring: ConferenceMessageRing | null): ConferenceChatLine[] {
  return ring ? messageRingEntries(ring).flatMap(({ message }) => {
    if (message.kind !== 'chat') return []
    const { kind: _kind, ...line } = message
    return [line]
  }) : []
}
