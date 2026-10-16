import { createActor } from 'xstate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gameMachine } from '../game/machine.ts'
import { demoPack } from '../game/questions.ts'
import { sha256Hex } from '../game/savedGame.ts'
import type { GameVoice } from '../realtime/client.ts'
import { JoinerSession } from './joinerSession.ts'
import { MasterSession, type MasterJitsiIds } from './masterSession.ts'
import { isConferenceMessage, type ConferenceMessage, type ConferenceSnapshot } from './messages.ts'
import { clearRememberedPlayersForTests, PRESENCE_HEARTBEAT_MS } from './presence.ts'
import type { ConferenceTransport } from './transport.ts'

/** Комната: id транспорта = id соединения в Jitsi (senderId), он ≠ clientId — как в настоящем Jitsi. */
class Room {
  members: RoomTransport[] = []
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
    for (const member of this.room.members) {
      if (member === this) continue
      for (const handler of member.handlers) handler(wire, this.id)
    }
  }
  subscribe(handler: (message: ConferenceMessage, senderId: string) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }
  close(): void {
    this.handlers.clear()
    this.room.members = this.room.members.filter((member) => member !== this)
  }
}

const noCache = { get: async () => null, put: async () => {}, delete: async () => {} }

function joiner(room: Room, endpoint: string, clientId: string, name: string) {
  const onSnapshot = vi.fn<(snapshot: ConferenceSnapshot) => void>()
  const session = new JoinerSession({
    transport: room.connect(endpoint), clientId, authToken: `${clientId}-token`, name,
    callbacks: { onSnapshot, onLobby: vi.fn(), onPackReady: vi.fn(), onError: vi.fn(), onFatalError: vi.fn() },
    packCache: noCache,
  })
  return { session, onSnapshot }
}

async function startMaster(room: Room, ids: MasterJitsiIds, withConferenceIds = true) {
  const transport = room.connect(ids.self ?? 'master-endpoint')
  const actor = createActor(gameMachine).start()
  const bytes = new Uint8Array([1, 2, 3])
  const shown: ConferenceSnapshot[] = []
  const master = new MasterSession({
    transport, actor, client: { requestSpeech: vi.fn() } as unknown as GameVoice,
    masterClientId: 'master', masterName: 'Мастер', pack: demoPack, packBytes: bytes,
    packHash: await sha256Hex(bytes), authorityToken: 'master-token', onRoster: () => {},
    onSnapshot: (snapshot) => shown.push(snapshot),
    ...(withConferenceIds ? { conferenceIds: () => ({ ...ids }) } : {}),
  })
  return { master, actor, transport, shown }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', globalThis)
  clearRememberedPlayersForTests()
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('кто есть кто в Jitsi — в снимке мастера', () => {
  it('два «Васи» и игрок «Ведущая»: разные пары, служебные id отдельно; у мастера и игроков одно и то же', async () => {
    const room = new Room()
    const ids: MasterJitsiIds = { self: 'em', host: 'eh', sounds: 'es1' }
    const { master, actor, shown } = await startMaster(room, ids)
    const vasya1 = joiner(room, 'e1', 'c1', 'Вася')
    const vasya2 = joiner(room, 'e2', 'c2', 'Вася')
    const named = joiner(room, 'e3', 'c3', 'Ведущая')
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS)

    const expected = [['em', 'master'], ['e1', 'c1'], ['e2', 'c2'], ['e3', 'c3']]
    const masterView = shown.at(-1)!
    expect([...masterView.jitsiIds].sort()).toEqual([...expected].sort())
    expect(masterView.hostJitsiId).toBe('eh')
    expect(masterView.soundsJitsiId).toBe('es1')
    // Игрок «Ведущая» — обычная пара, не служебный id.
    expect(masterView.hostJitsiId).not.toBe('e3')
    for (const guest of [vasya1, vasya2, named]) {
      const view = guest.session.snapshot()!
      expect(view.jitsiIds).toEqual(masterView.jitsiIds)
      expect(view.hostJitsiId).toBe('eh')
      expect(view.soundsJitsiId).toBe('es1')
    }
    master.dispose()
    for (const guest of [vasya1, vasya2, named]) guest.session.dispose()
    actor.stop()
  })

  it('переподключение «Звуков игры» с новым id — refreshConferenceIds рассылает новый id всем', async () => {
    const room = new Room()
    const ids: MasterJitsiIds = { self: 'em', host: 'eh', sounds: 'es1' }
    const { master, actor, transport, shown } = await startMaster(room, ids)
    const guest = joiner(room, 'e1', 'c1', 'Вася')
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS)
    expect(guest.session.snapshot()!.soundsJitsiId).toBe('es1')

    ids.sounds = null
    master.refreshConferenceIds()
    await vi.advanceTimersByTimeAsync(0)
    expect(guest.session.snapshot()!.soundsJitsiId).toBeNull()

    const before = transport.sent.length
    ids.sounds = 'es2'
    master.refreshConferenceIds()
    await vi.advanceTimersByTimeAsync(10)
    const update = transport.sent.slice(before).find((message) => message.type === 'partialUpdate')
    // Уходит только разница — новый id, без всего снимка.
    expect(update && update.type === 'partialUpdate' ? update.changes : null).toMatchObject({ soundsJitsiId: 'es2' })
    expect(guest.session.snapshot()!.soundsJitsiId).toBe('es2')
    expect(shown.at(-1)!.soundsJitsiId).toBe('es2')
    master.dispose()
    guest.session.dispose()
    actor.stop()
  })

  it('игрок переподключился (новый id соединения, тот же clientId) — пара обновляется у всех', async () => {
    const room = new Room()
    const { master, actor, shown } = await startMaster(room, { self: 'em', host: 'eh', sounds: 'es' })
    const first = joiner(room, 'e1', 'c1', 'Вася')
    const other = joiner(room, 'e2', 'c2', 'Петя')
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS)
    expect(other.session.snapshot()!.jitsiIds).toContainEqual(['e1', 'c1'])

    first.session.dispose()
    const again = joiner(room, 'e1-new', 'c1', 'Вася')
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS)
    for (const view of [other.session.snapshot()!, again.session.snapshot()!, shown.at(-1)!]) {
      expect(view.jitsiIds).toContainEqual(['e1-new', 'c1'])
      expect(view.jitsiIds).not.toContainEqual(['e1', 'c1'])
      expect(view.jitsiIds.filter(([, clientId]) => clientId === 'c1')).toHaveLength(1)
    }
    master.dispose()
    again.session.dispose()
    other.session.dispose()
    actor.stop()
  })

  it('чужое соединение не может выдать себя за игрока: hello с чужим clientId и неверным секретом не меняет пару', async () => {
    const room = new Room()
    const { master, actor, shown } = await startMaster(room, { self: 'em', host: 'eh', sounds: 'es' })
    const guest = joiner(room, 'e1', 'c1', 'Вася')
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS)
    room.connect('evil').send({ type: 'hello', clientId: 'c1', authToken: 'wrong', name: 'Вася' })
    await vi.advanceTimersByTimeAsync(0)
    expect(shown.at(-1)!.jitsiIds).toContainEqual(['e1', 'c1'])
    expect(shown.at(-1)!.jitsiIds.some(([jitsiId]) => jitsiId === 'evil')).toBe(false)
    master.dispose()
    guest.session.dispose()
    actor.stop()
  })

  it('без Jitsi (BroadcastChannel, conferenceIds не задан): мастера в парах нет, служебные id — null, снимок валиден', async () => {
    const room = new Room()
    const { master, actor, transport, shown } = await startMaster(room, { self: null, host: null, sounds: null }, false)
    const guest = joiner(room, 'e1', 'c1', 'Вася')
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS)
    const view = shown.at(-1)!
    expect(view.jitsiIds).toEqual([['e1', 'c1']])
    expect(view.hostJitsiId).toBeNull()
    expect(view.soundsJitsiId).toBeNull()
    expect(transport.sent.every(isConferenceMessage)).toBe(true)
    master.refreshConferenceIds()
    master.dispose()
    guest.session.dispose()
    actor.stop()
  })

  it('игрок до первого снимка: snapshot() пуст, ничего не падает; первое состояние сразу несёт пары', async () => {
    const room = new Room()
    const guest = joiner(room, 'e1', 'c1', 'Вася')
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS)
    expect(guest.session.snapshot()).toBeNull()
    const { master, actor } = await startMaster(room, { self: 'em', host: 'eh', sounds: 'es' })
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS)
    const first = guest.onSnapshot.mock.calls[0]![0]
    expect(first.hostJitsiId).toBe('eh')
    expect(first.jitsiIds).toContainEqual(['em', 'master'])
    master.dispose()
    guest.session.dispose()
    actor.stop()
  })
})

describe('проверка формата новых полей на проводе', () => {
  it('отклоняет снимок и диф с испорченными парами или служебными id', async () => {
    const room = new Room()
    const { master, actor, transport } = await startMaster(room, { self: 'em', host: 'eh', sounds: 'es' })
    await vi.advanceTimersByTimeAsync(0)
    const snapshot = transport.sent.find((message) => message.type === 'snapshot')!
    expect(isConferenceMessage(snapshot)).toBe(true)
    const bad: unknown[] = [
      { jitsiIds: undefined },
      { jitsiIds: [['em']] },
      { jitsiIds: [['em', 'master'], ['e2', 'master']] },
      { jitsiIds: [['', 'master']] },
      { jitsiIds: 'em:master' },
      { hostJitsiId: undefined },
      { hostJitsiId: '' },
      { hostJitsiId: 5 },
      { soundsJitsiId: 'x'.repeat(201) },
      { soundsJitsiId: undefined },
    ]
    for (const patch of bad) {
      expect(isConferenceMessage({ ...snapshot, ...(patch as object) })).toBe(false)
    }
    const partial = { type: 'partialUpdate', authorityToken: 'master-token', revision: 1, baseRevision: 0 }
    expect(isConferenceMessage({ ...partial, changes: { soundsJitsiId: 'es2' } })).toBe(true)
    expect(isConferenceMessage({ ...partial, changes: { soundsJitsiId: '' } })).toBe(false)
    expect(isConferenceMessage({ ...partial, changes: { jitsiIds: [['e', 'c', 'x']] } })).toBe(false)
    master.dispose()
    actor.stop()
  })
})
