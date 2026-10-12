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
