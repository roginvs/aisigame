import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCommit } from '../buildInfo.ts'
import { sha256Hex } from '../game/savedGame.ts'
import { chunkToWire, splitChunks } from './chunks.ts'
import { JoinerSession, type JoinerPackCache, type JoinerLobbyState } from './joinerSession.ts'
import type { ConferenceMessage, PackOfferMessage, SnapshotMessage } from './messages.ts'
import { PRESENCE_HEARTBEAT_MS, PRESENCE_STALE_MS } from './presence.ts'
import type { ConferenceTransport } from './transport.ts'
import { pushTrace } from '../debug/trace.ts'
import { messageRingEntries } from './messageRing.ts'
import { emptyMessageRing } from './stateProtocol.ts'

class TestTransport implements ConferenceTransport {
  sent: ConferenceMessage[] = []
  private handlers = new Set<(message: ConferenceMessage, senderId: string) => void>()

  send(message: ConferenceMessage): void {
    this.sent.push(message)
  }

  subscribe(handler: (message: ConferenceMessage, senderId: string) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  emit(message: ConferenceMessage, senderId = 'master-endpoint'): void {
    for (const handler of this.handlers) handler(message, senderId)
  }

  close(): void {
    this.handlers.clear()
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function eventually(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 1000, interval: 1 })
}

function makeSession(input: {
  cache: JoinerPackCache
  onReady?: (bytes: Uint8Array, hash: string) => void | Promise<void>
}) {
  const transport = new TestTransport()
  const lobby: JoinerLobbyState[] = []
  const errors: string[] = []
  const fatals: string[] = []
  const onSnapshot = vi.fn()
  const onReady = vi.fn(input.onReady ?? (() => undefined))
  const session = new JoinerSession({
    transport,
    clientId: 'joiner',
    authToken: 'joiner-token',
    name: 'Игрок',
    packCache: input.cache,
    callbacks: {
      onSnapshot,
      onLobby: (state) => lobby.push(state),
      onPackReady: onReady,
      onError: (message) => errors.push(message),
      onFatalError: (message) => fatals.push(message),
    },
  })
  return { session, transport, lobby, errors, fatals, onReady, onSnapshot }
}

function offer(hash: string, size: number, commit = buildCommit()): PackOfferMessage {
  return {
    type: 'packOffer',
    authorityToken: 'master-token',
    targetClientId: 'joiner',
    commit,
    hash,
    size,
    name: 'Пакет',
    summary: 'Тест',
  }
}

function snapshot(phase = 'lobby', commit = buildCommit()): SnapshotMessage {
  return {
    type: 'snapshot',
    authorityToken: 'master-token',
    revision: 0,
    pack: null,
    ...emptyMessageRing(),
    commit,
    phase,
    players: [{ id: 1, name: 'Мастер', score: 0, clientId: 'master' }],
    presence: [
      {
        clientId: 'master',
        name: 'Мастер',
        playerId: 1,
        isMaster: true,
        stale: false,
        hidden: false,
        percent: 100,
        ready: true,
        hashOk: true,
      },
    ],
    roundIndex: 0,
    playedIds: [],
    missedIds: [],
    finalists: [],
    finalCursor: 0,
    activeQuestionId: null,
    chooserId: 1,
    answererId: null,
    falseStartIds: [],
    falseStarts: {},
    bets: {},
    betMisses: 0,
    activeStake: null,
    attemptId: 0,
    clarifications: 0,
    spokeWithoutButton: false,
    talkedDuringRead: false,
    sayFalseStart: false,
    heard: '',
    wrongHeard: [],
    sayCloseGuess: false,
    judgmentReason: '',
    judgmentStatus: null,
    announceKind: null,
    clarifyReason: '',
    statusLine: 'Ждём игроков',
    phaseDurationMs: null,
    timerRemainingMs: null,
  }
}

describe('JoinerSession pack cache and transfer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('ждёт мастера, повторяет запрос полного статуса и принимает общий ответ без своего запроса', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    const { session, transport, lobby, onSnapshot } = makeSession({ cache: { get: async () => null, put: async () => {}, delete: async () => {} } })
    expect(transport.sent.map((message) => message.type)).toEqual(['hello', 'statusRequest'])
    expect(lobby.at(-1)?.waitingMaster).toBe(true)
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS)
    expect(session.snapshot()).toBeNull()
    expect(transport.sent.filter((message) => message.type === 'statusRequest')).toHaveLength(2)
    transport.emit(snapshot())
    await vi.advanceTimersByTimeAsync(0)
    expect(lobby.at(-1)?.waitingMaster).toBe(false)
    expect(onSnapshot).toHaveBeenCalledTimes(1)
    transport.emit({ type: 'partialUpdate', authorityToken: 'master-token', baseRevision: 0, revision: 1, changes: { statusLine: 'Диф' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(session.snapshot()?.statusLine).toBe('Диф')
    // Этот полный статус мастер прислал в ответ другому игроку.
    transport.emit({ ...snapshot(), revision: 2, statusLine: 'Общий полный статус' })
    await vi.advanceTimersByTimeAsync(0)
    expect(session.snapshot()?.statusLine).toBe('Общий полный статус')
    const requestCount = transport.sent.filter((message) => message.type === 'statusRequest').length
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS)
    expect(transport.sent.filter((message) => message.type === 'statusRequest')).toHaveLength(requestCount)
    session.requestStatus()
    expect(transport.sent.at(-1)?.type).toBe('statusRequest')
    session.dispose()
  })

  it('пустой диф поддерживает presence мастера и снимает баннер offline после паузы трафика', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    const { session, transport, lobby, onSnapshot } = makeSession({ cache: { get: async () => null, put: async () => {}, delete: async () => {} } })
    transport.emit(snapshot())
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(PRESENCE_STALE_MS + PRESENCE_HEARTBEAT_MS)
    expect(lobby.at(-1)?.masterOffline).toBe(true)
    transport.emit({ type: 'partialUpdate', authorityToken: 'master-token', baseRevision: 0, revision: 0, changes: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(lobby.at(-1)?.masterOffline).toBe(false)
    expect(onSnapshot).toHaveBeenCalledTimes(1)
    session.dispose()
  })

  it('при пропуске дифа запрашивает снимок; heartbeat выявляет пропуск последнего изменения', async () => {
    vi.stubGlobal('window', globalThis)
    const { session, transport, onSnapshot } = makeSession({ cache: { get: async () => null, put: async () => {}, delete: async () => {} } })
    transport.emit(snapshot())
    await eventually(() => expect(onSnapshot).toHaveBeenCalledTimes(1))
    transport.emit({ type: 'partialUpdate', authorityToken: 'master-token', baseRevision: 1, revision: 2, changes: { phase: 'finished' } })
    await eventually(() => expect(transport.sent.filter((message) => message.type === 'statusRequest')).toHaveLength(2))
    expect(session.snapshot()?.phase).toBe('lobby')
    transport.emit({ ...snapshot(), revision: 2, statusLine: 'Восстановлено' })
    await eventually(() => expect(session.snapshot()?.statusLine).toBe('Восстановлено'))
    transport.emit({ type: 'partialUpdate', authorityToken: 'master-token', baseRevision: 3, revision: 3, changes: {} })
    await eventually(() => expect(transport.sent.filter((message) => message.type === 'statusRequest')).toHaveLength(3))
    transport.emit({ ...snapshot(), revision: 3 })
    await eventually(() => expect(session.snapshot()?.statusLine).toBe('Ждём игроков'))
    transport.emit({ type: 'partialUpdate', authorityToken: 'master-token', baseRevision: 3, revision: 4, changes: { messageIndex: 0, message0: { kind: 'chat', name: 'Игрок', text: 'Один слот' } } })
    await eventually(() => expect(messageRingEntries(session.snapshot()!).map(({ message }) => message)).toEqual([{ kind: 'chat', name: 'Игрок', text: 'Один слот' }]))
    const count = onSnapshot.mock.calls.length
    // Дубликат не публикует запись ещё раз; чужой endpoint не меняет состояние.
    transport.emit({ type: 'partialUpdate', authorityToken: 'master-token', baseRevision: 3, revision: 4, changes: { statusLine: 'Дубликат' } })
    transport.emit({ type: 'partialUpdate', authorityToken: 'master-token', baseRevision: 4, revision: 5, changes: { phase: 'finished' } }, 'attacker-endpoint')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(onSnapshot).toHaveBeenCalledTimes(count)
    expect(session.snapshot()?.phase).toBe('lobby')
    session.dispose()
  })

  it('раз в две секунды отправляет мастеру новый ограниченный debug-батч', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    const cache: JoinerPackCache = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    }
    const { session, transport } = makeSession({ cache })
    pushTrace('note', 'мобильная проверка', { detail: 'экран' })

    vi.advanceTimersByTime(1_999)
    expect(transport.sent.some((message) => message.type === 'debugLog')).toBe(false)
    vi.advanceTimersByTime(1)

    const debug = transport.sent.find((message) => message.type === 'debugLog')
    expect(debug?.entries).toEqual([
      expect.objectContaining({ kind: 'note', title: 'мобильная проверка' }),
    ])
    session.dispose()
  })

  it('проверяет кэш по размеру и hash, не запрашивает чанки и парсит один раз', async () => {
    vi.stubGlobal('window', globalThis)
    const bytes = new TextEncoder().encode('cached pack')
    const hash = await sha256Hex(bytes)
    const cache: JoinerPackCache = {
      get: vi.fn(async () => bytes),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    }
    const { session, transport, lobby, onReady } = makeSession({ cache })

    transport.emit(offer(hash, bytes.byteLength))
    await eventually(() => expect(onReady).toHaveBeenCalledTimes(1))
    transport.emit(offer(hash, bytes.byteLength))
    await eventually(() => {
      expect(transport.sent.filter((message) => message.type === 'packAck').at(-1)).toMatchObject({
        hash,
        nextIndex: 1,
      })
    })

    expect(cache.get).toHaveBeenCalledTimes(1)
    expect(cache.put).not.toHaveBeenCalled()
    expect(lobby.at(-1)).toMatchObject({ percent: 100, hashOk: true })
    expect(transport.sent).toContainEqual({
      type: 'packVerified',
      clientId: 'joiner',
      authToken: 'joiner-token',
      hash,
    })
    session.dispose()
  })

  it('сериализует offer и ранний chunk, затем сохраняет и парсит ровно один раз', async () => {
    vi.stubGlobal('window', globalThis)
    const bytes = new TextEncoder().encode('wire pack')
    const hash = await sha256Hex(bytes)
    const cacheRead = deferred<Uint8Array | null>()
    const cache: JoinerPackCache = {
      get: vi.fn(() => cacheRead.promise),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    }
    const { session, transport, onReady } = makeSession({ cache })
    const wire = chunkToWire(hash, splitChunks(bytes)[0]!)

    transport.emit(offer(hash, bytes.byteLength))
    transport.emit({ type: 'packChunk', targetClientId: 'joiner', authorityToken: 'master-token', ...wire })
    await Promise.resolve()
    expect(onReady).not.toHaveBeenCalled()

    cacheRead.resolve(null)
    await eventually(() => expect(onReady).toHaveBeenCalledTimes(1))
    transport.emit({ type: 'packChunk', targetClientId: 'joiner', authorityToken: 'master-token', ...wire })
    await eventually(() => expect(cache.put).toHaveBeenCalledTimes(1))

    expect(onReady).toHaveBeenCalledTimes(1)
    expect(
      transport.sent.some((message) => message.type === 'packAck' && message.nextIndex === 0),
    ).toBe(true)
    session.dispose()
  })

  it('удаляет битый кэш и явно просит передачу с нулевого чанка', async () => {
    vi.stubGlobal('window', globalThis)
    const bytes = new TextEncoder().encode('valid pack')
    const bad = bytes.slice()
    bad[0] ^= 0xff
    const hash = await sha256Hex(bytes)
    const cache: JoinerPackCache = {
      get: vi.fn(async () => bad),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    }
    const { session, transport, onReady } = makeSession({ cache })

    transport.emit(offer(hash, bytes.byteLength))
    await eventually(() => expect(cache.delete).toHaveBeenCalledWith(hash))
    expect(onReady).not.toHaveBeenCalled()
    expect(transport.sent.filter((message) => message.type === 'packAck').at(-1)).toMatchObject({
      hash,
      nextIndex: 0,
    })
    session.dispose()
  })

  it('после ошибки итогового hash сбрасывает приёмник и запрашивает пакет заново', async () => {
    vi.stubGlobal('window', globalThis)
    const bytes = new TextEncoder().encode('valid pack')
    const hash = await sha256Hex(bytes)
    const cache: JoinerPackCache = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    }
    const { session, transport, errors, lobby, onReady } = makeSession({ cache })
    session.setTamperPack(true)
    const wire = chunkToWire(hash, splitChunks(bytes)[0]!)

    transport.emit(offer(hash, bytes.byteLength))
    transport.emit({ type: 'packChunk', targetClientId: 'joiner', authorityToken: 'master-token', ...wire })
    await eventually(() => expect(errors).toContain('Пакет повредился при передаче. Загружаем заново.'))

    expect(onReady).not.toHaveBeenCalled()
    expect(lobby.at(-1)).toMatchObject({ percent: 0, hashOk: false })
    expect(transport.sent.filter((message) => message.type === 'packAck').at(-1)).toMatchObject({
      hash,
      nextIndex: 0,
    })
    session.dispose()
  })

  it('снимает «ждём мастера» по снимку и не принимает смену мастера с чужим секретом', async () => {
    vi.stubGlobal('window', globalThis)
    const cache: JoinerPackCache = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    }
    const { session, transport, lobby } = makeSession({ cache })

    transport.emit(snapshot())
    await eventually(() => expect(lobby.at(-1)).toMatchObject({ waitingMaster: false, masterOffline: false }))
    expect(lobby.at(-1)?.rosterNames).toEqual(['Мастер'])

    const forged = snapshot('finished')
    forged.authorityToken = 'attacker-token'
    transport.emit(forged, 'attacker-endpoint')
    await Promise.resolve()
    expect(session.snapshot()?.phase).toBe('lobby')
    session.dispose()
  })

  it('кусок пакета от мастера тоже считает его живым, даже без свежего снимка', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    const bytes = new TextEncoder().encode('alive pack')
    const hash = await sha256Hex(bytes)
    const cache: JoinerPackCache = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    }
    const { session, transport, lobby } = makeSession({ cache })
    const wire = chunkToWire(hash, splitChunks(bytes)[0]!)

    transport.emit(snapshot())
    await eventually(() => expect(lobby.at(-1)?.masterOffline).toBe(false))

    // Долго нет снимка — без кусков мастер стал бы offline.
    vi.advanceTimersByTime(PRESENCE_STALE_MS + PRESENCE_HEARTBEAT_MS)
    expect(lobby.at(-1)?.masterOffline).toBe(true)

    transport.emit(offer(hash, bytes.byteLength))
    transport.emit({ type: 'packChunk', targetClientId: 'joiner', authorityToken: 'master-token', ...wire })
    await eventually(() => expect(lobby.at(-1)?.masterOffline).toBe(false))

    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS)
    expect(lobby.at(-1)?.masterOffline).toBe(false)
    session.dispose()
    vi.useRealTimers()
  })

  it('после позднего входа в идущую игру автоматически становится ready, когда пакет проверен', async () => {
    vi.stubGlobal('window', globalThis)
    const bytes = new TextEncoder().encode('late join pack')
    const hash = await sha256Hex(bytes)
    const cache: JoinerPackCache = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    }
    const { session, transport } = makeSession({ cache })
    const wire = chunkToWire(hash, splitChunks(bytes)[0]!)

    transport.emit(snapshot('choosing.listening'))
    transport.emit(offer(hash, bytes.byteLength))
    transport.emit({
      type: 'packChunk',
      targetClientId: 'joiner',
      authorityToken: 'master-token',
      ...wire,
    })

    await eventually(() => {
      expect(transport.sent.some((message) => message.type === 'ready')).toBe(true)
    })
    transport.sent.length = 0
    transport.emit(snapshot('choosing.listening'), 'reloaded-master-endpoint')
    await eventually(() => {
      expect(transport.sent.some((message) => message.type === 'hello')).toBe(true)
      expect(transport.sent.some((message) => message.type === 'ready')).toBe(true)
    })
    session.dispose()
  })

  it('отказывается при чужом commit мастера и больше не принимает пакет', async () => {
    vi.stubGlobal('window', globalThis)
    const bytes = new TextEncoder().encode('wrong build pack')
    const hash = await sha256Hex(bytes)
    const cache: JoinerPackCache = {
      get: vi.fn(async () => bytes),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    }
    const { transport, fatals, onReady } = makeSession({ cache })

    transport.emit(snapshot('lobby', 'other-commit'))
    await eventually(() => {
      expect(fatals[0]).toMatch(/Версия не совпадает с мастером/)
      expect(fatals[0]).toContain('other-commit')
      expect(fatals[0]).toContain(buildCommit())
    })
    transport.emit(offer(hash, bytes.byteLength, 'other-commit'))
    await Promise.resolve()
    expect(onReady).not.toHaveBeenCalled()
  })
})
