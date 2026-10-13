import { createActor } from 'xstate'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { gameMachine } from '../game/machine.ts'
import { demoPack } from '../game/questions.ts'
import { sha256Hex } from '../game/savedGame.ts'
import type { GameVoice } from '../realtime/client.ts'
import { JoinerSession } from './joinerSession.ts'
import { messageRingEntries } from './messageRing.ts'
import { MasterSession } from './masterSession.ts'
import { isConferenceMessage, type ConferenceMessage } from './messages.ts'
import { clearRememberedPlayersForTests, PRESENCE_HEARTBEAT_MS } from './presence.ts'
import type { ConferenceTransport } from './transport.ts'

/** Broadcast-комната с JSON-сериализацией и управляемой потерей одного дифа. */
class Room {
  members: RoomTransport[] = []
  dropNextUpdateFor = ''
  dropPackOffers = false
  dropAppealReplies = false
  dropAppealRequests = false
  connect(id: string): RoomTransport {
    const transport = new RoomTransport(this, id)
    this.members.push(transport)
    return transport
  }
}
class RoomTransport implements ConferenceTransport {
  sent: ConferenceMessage[] = []
  handlers = new Set<(message: ConferenceMessage, senderId: string) => void>()
  room: Room
  id: string
  constructor(room: Room, id: string) { this.room = room; this.id = id }
  send(message: ConferenceMessage): void {
    const wire: unknown = JSON.parse(JSON.stringify(message))
    expect(isConferenceMessage(wire)).toBe(true)
    if (!isConferenceMessage(wire)) throw new Error('invalid wire message')
    this.sent.push(wire)
    if (wire.type === 'packOffer' && this.room.dropPackOffers) return
    if (wire.type === 'appealReply' && this.room.dropAppealReplies) return
    if (wire.type === 'appeal' && this.room.dropAppealRequests) return
    for (const member of this.room.members) {
      if (member === this) continue
      if (member.id === this.room.dropNextUpdateFor && wire.type === 'partialUpdate') {
        this.room.dropNextUpdateFor = ''
        continue
      }
      for (const handler of member.handlers) handler(wire, this.id)
    }
  }
  subscribe(handler: (message: ConferenceMessage, senderId: string) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }
  close(): void { this.handlers.clear() }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', globalThis)
  clearRememberedPlayersForTests()
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('два игрока входят раньше мастера; общий снимок, дифы, потеря дифа и повторный запрос синхронизируют всех', async () => {
  const room = new Room()
  const transports = [room.connect('first'), room.connect('second')]
  const callbacks = transports.map(() => ({
    onSnapshot: vi.fn(), onLobby: vi.fn(), onPackReady: vi.fn(), onError: vi.fn(), onFatalError: vi.fn(),
  }))
  const joiners = transports.map((transport, i) => new JoinerSession({
    transport, clientId: transport.id, authToken: `${transport.id}-token`, name: `Игрок ${i + 1}`,
    callbacks: callbacks[i]!, packCache: { get: async () => null, put: async () => {}, delete: async () => {} },
  }))
  await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS)
  expect(joiners.map((session) => session.snapshot())).toEqual([null, null])
  expect(callbacks.every((cb) => cb.onError.mock.calls.length === 0)).toBe(true)

  const transport = room.connect('master')
  const actor = createActor(gameMachine).start()
  const bytes = new Uint8Array([1, 2, 3])
  const master = new MasterSession({
    transport, actor, client: { requestSpeech: vi.fn() } as unknown as GameVoice,
    masterClientId: 'master', masterName: 'Мастер', pack: demoPack, packBytes: bytes,
    packHash: await sha256Hex(bytes), authorityToken: 'master-token', onRoster: () => {},
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(transport.sent[0]?.type).toBe('snapshot')
  expect(joiners.every((session) => session.snapshot()?.phase === 'lobby')).toBe(true)
  await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS)
  expect(master.rosterList().filter((entry) => entry.hashOk)).toHaveLength(3)
  expect(joiners.every((session) => session.snapshot()?.presence.length === 3)).toBe(true)
  expect(transport.sent.filter((message) => message.type === 'snapshot')).toHaveLength(1)

  master.sendChat('Мастер', 'Первый чат')
  joiners[1]!.sendChat('Второй чат')
  await vi.advanceTimersByTimeAsync(0)
  expect(messageRingEntries(joiners[0]!.snapshot()!).filter(({ message }) => message.kind === 'chat').map(({ message }) => message.text)).toEqual(['Первый чат', 'Второй чат'])
  expect(joiners[0]!.snapshot()).toEqual(joiners[1]!.snapshot())

  const fullCount = transport.sent.filter((message) => message.type === 'snapshot').length
  const secondCalls = callbacks[1]!.onSnapshot.mock.calls.length
  room.dropNextUpdateFor = 'first'
  master.sendChat('Мастер', 'Потерянный диф')
  master.sendChat('Мастер', 'Следующий диф')
  await vi.advanceTimersByTimeAsync(0)
  expect(transport.sent.filter((message) => message.type === 'snapshot')).toHaveLength(fullCount + 1)
  expect(callbacks[1]!.onSnapshot.mock.calls.length).toBeGreaterThan(secondCalls + 2)
  expect(joiners[0]!.snapshot()).toEqual(joiners[1]!.snapshot())
  expect(messageRingEntries(joiners[0]!.snapshot()!).filter(({ message }) => message.kind === 'chat').map(({ message }) => message.text)).toEqual(['Первый чат', 'Второй чат', 'Потерянный диф', 'Следующий диф'])

  joiners[1]!.requestStatus()
  await vi.advanceTimersByTimeAsync(0)
  expect(transport.sent.filter((message) => message.type === 'snapshot')).toHaveLength(fullCount + 2)
  expect(joiners[0]!.snapshot()).toEqual(joiners[1]!.snapshot())
  expect(callbacks.every((cb) => cb.onError.mock.calls.length === 0 && cb.onFatalError.mock.calls.length === 0)).toBe(true)
  master.dispose()
  joiners.forEach((session) => session.dispose())
  actor.stop()
})

it.each([false, true])('перезагрузка сверяет кеш по глобальному хешу без packOffer (кеш: %s)', async (cached) => {
  const room = new Room()
  room.dropPackOffers = true
  const transport = room.connect('master')
  const actor = createActor(gameMachine).start()
  const bytes = new Uint8Array([1, 2, 3])
  const hash = await sha256Hex(bytes)
  const master = new MasterSession({
    transport, actor, client: { requestSpeech: vi.fn() } as unknown as GameVoice,
    masterClientId: 'master', masterName: 'Мастер', pack: demoPack, packBytes: bytes,
    packHash: hash, authorityToken: 'master-token', onRoster: () => {},
  })
  const cache = { get: async () => cached ? bytes : null, put: async () => {}, delete: async () => {} }
  const callbacks = () => ({ onSnapshot: vi.fn(), onLobby: vi.fn(), onPackReady: vi.fn(), onError: vi.fn(), onFatalError: vi.fn() })
  const first = new JoinerSession({
    transport: room.connect('first-endpoint'), clientId: 'first', authToken: 'first-token', name: 'Игрок',
    packCache: cache, callbacks: callbacks(),
  })
  await vi.waitFor(() => expect(master.rosterList().find((entry) => entry.clientId === 'first')?.hashOk).toBe(true), { interval: 1 })
  first.sendReady()
  await vi.advanceTimersByTimeAsync(0)
  expect(master.rosterList().find((entry) => entry.clientId === 'first')).toMatchObject({ hashOk: true, ready: true })
  const previousOffers = transport.sent.filter((message) => message.type === 'packOffer' && message.targetClientId === 'first').length
  first.dispose()

  let finishParse!: () => void
  const parsing = new Promise<void>((resolve) => { finishParse = resolve })
  const cb = callbacks()
  cb.onPackReady = vi.fn(() => parsing)
  const reloaded = new JoinerSession({
    transport: room.connect('reloaded-endpoint'), clientId: 'first', authToken: 'first-token', name: 'Игрок',
    packCache: cache, callbacks: cb,
  })
  try {
    await vi.waitFor(() => expect(cb.onPackReady).toHaveBeenCalledTimes(1), { interval: 1 })
    expect(master.rosterList().find((entry) => entry.clientId === 'first')).toMatchObject({ hashOk: false, ready: false })
    reloaded.sendReady()
    expect(master.rosterList().find((entry) => entry.clientId === 'first')?.ready).toBe(false)
    finishParse()
    await vi.waitFor(() => expect(master.rosterList().find((entry) => entry.clientId === 'first')?.ready).toBe(true), { interval: 1 })
    expect(cb.onLobby).toHaveBeenLastCalledWith(expect.objectContaining({ percent: 100, hashOk: true, readySent: true }))
    expect(master.rosterList().find((entry) => entry.clientId === 'first')).toMatchObject({ percent: 100, hashOk: true, ready: true })
    expect(cb.onError).not.toHaveBeenCalled()
    expect(cb.onFatalError).not.toHaveBeenCalled()
    const offers = transport.sent.filter((message) => message.type === 'packOffer' && message.targetClientId === 'first')
    if (cached) {
      expect(offers).toHaveLength(0)
      expect(transport.sent.some((message) => message.type === 'packChunk')).toBe(false)
    } else {
      expect(offers.length).toBeGreaterThan(previousOffers)
    }
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS * 2)
    expect(transport.sent.filter((message) => message.type === 'packOffer' && message.targetClientId === 'first')).toHaveLength(offers.length)
  } finally {
    finishParse()
    reloaded.dispose()
    master.dispose()
    actor.stop()
  }
})


it('апелляции: подтверждение, чужой playerId, дубли, lost ACK по snapshot и потеря запроса', async () => {
  const room = new Room()
  const transport = room.connect('master')
  const actor = createActor(gameMachine).start()
  const players = [{ id: 1, name: 'Мастер', score: 0, clientId: 'master' }, { id: 2, name: 'Гость', score: 0, clientId: 'guest' }]
  actor.send({ type: 'START_GAME', pack: demoPack, players })
  actor.send({ type: 'CONNECTED' }); actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
  actor.send({ type: 'QUESTION_SELECTED', themeId: 'history', value: 100 })
  await vi.advanceTimersByTimeAsync(1080)
  actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
  const normal = (playerId: number, status: 'incorrect' | 'correct') => {
    actor.send({ type: 'BUZZER_PRESSED', playerId }); actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({ type: 'ANSWER_JUDGED', judgment: { questionId: 'history-100', playerId, attemptId: actor.getSnapshot().context.attemptId, status, heard: 'ответ', reason: '' } })
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'announce' })
  }
  normal(2, 'incorrect'); normal(1, 'correct')
  const bytes = new Uint8Array([1, 2, 3])
  const hash = await sha256Hex(bytes)
  const master = new MasterSession({ transport, actor, client: { requestSpeech: vi.fn() } as unknown as GameVoice,
    masterClientId: 'master', masterName: 'Мастер', pack: demoPack, packBytes: bytes, packHash: hash, authorityToken: 'master-token', onRoster: () => {}, resumePlayers: players })
  const guest = room.connect('guest-endpoint')
  const callbacks = { onSnapshot: vi.fn(), onLobby: vi.fn(), onPackReady: vi.fn(), onError: vi.fn(), onFatalError: vi.fn() }
  let joiner = new JoinerSession({ transport: guest, clientId: 'guest', authToken: 'guest-token', name: 'Гость', callbacks,
    packCache: { get: async () => bytes, put: async () => {}, delete: async () => {} } })
  try {
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(master.rosterList().find((entry) => entry.clientId === 'guest')?.hashOk).toBe(true), { interval: 1 })
    const a = actor.getSnapshot().context.appeal!
    const request = { questionId: a.questionId, windowId: a.windowId, playerId: 2, requestId: 'accepted' }
    const foreign = joiner.sendAppeal({ ...request, playerId: 1, requestId: 'foreign' })
    await vi.advanceTimersByTimeAsync(0)
    expect(await foreign).toEqual({ accepted: false, reason: 'Чужой игрок' })
    const stale = joiner.sendAppeal({ ...request, windowId: 9999, requestId: 'stale' })
    await vi.advanceTimersByTimeAsync(0)
    expect((await stale).accepted).toBe(false)
    room.dropAppealRequests = true
    const lost = joiner.sendAppeal({ ...request, requestId: 'lost' })
    await vi.advanceTimersByTimeAsync(4000)
    expect(await lost).toMatchObject({ accepted: false, reason: expect.stringContaining('Нет подтверждения') })
    room.dropAppealRequests = false; room.dropAppealReplies = true
    const accepted = joiner.sendAppeal(request)
    await vi.advanceTimersByTimeAsync(0)
    expect(await accepted).toEqual({ accepted: true, reason: '' })
    expect(joiner.snapshot()?.appeal?.activePlayerId).toBe(2)
    expect(joiner.snapshot()?.phase).toBe('appealCue')
    const attempt = actor.getSnapshot().context.attemptId
    guest.send({ ...request, type: 'appeal', clientId: 'guest', authToken: 'guest-token' })
    expect(actor.getSnapshot().context.attemptId).toBe(attempt)
    expect(actor.getSnapshot().context.appeal?.queue).toEqual([])
    // Reload with the same authenticated clientId restores the authoritative active request.
    joiner.dispose()
    joiner = new JoinerSession({ transport: room.connect('guest-reloaded'), clientId: 'guest', authToken: 'guest-token', name: 'Гость', callbacks,
      packCache: { get: async () => bytes, put: async () => {}, delete: async () => {} } })
    await vi.advanceTimersByTimeAsync(0)
    expect(joiner.snapshot()?.appeal?.activePlayerId).toBe(2)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'appeal' })
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
    actor.send({ type: 'ANSWER_JUDGED', judgment: { questionId: 'history-100', playerId: 2, attemptId: attempt, status: 'correct', heard: 'Август', reason: '' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(actor.getSnapshot().context.players.map((p) => p.score)).toEqual([100, 100])
    // Partial updates may arrive a tick later than the machine change; wait for the joiner view.
    for (let i = 0; i < 50 && joiner.snapshot()?.players[1]?.score !== 100; i += 1) await vi.advanceTimersByTimeAsync(20)
    expect(joiner.snapshot()?.players.map((p) => p.score)).toEqual([100, 100])
    expect(joiner.snapshot()?.outcomes).toEqual(actor.getSnapshot().context.outcomes)
  } finally { joiner.dispose(); master.dispose(); actor.stop() }
})
