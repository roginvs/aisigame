import { describe, expect, it } from 'vitest'
import { emptyMessageRing, readMessageRing, messageRingEntries } from '../conference/messageRing.ts'
import { storageKey } from '../config.ts'
import type { GameContext } from './types.ts'
import {
  clearSavedGame,
  gameStorageKey,
  packCanResume,
  persistConferenceLobby,
  persistConferenceHistory,
  persistMatch,
  readMatchMode,
  readSavedGame,
  savedGameVersion,
  decideResumeFile,
  resumeFileName,
  resumeNeedsFile,
  resumePackTitle,
  restoredMatch,
  sha256Hex,
  type SavedGame,
  hearTurnOnlyOf,
} from './savedGame.ts'
import { demoPack } from './questions.ts'

function memory(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => {
      map.delete(key)
    },
    setItem: (key, value) => {
      map.set(key, value)
    },
  }
}

function context(patch: Partial<GameContext> = {}): GameContext {
  return {
    players: [
      { id: 1, name: 'Игрок 1', score: 0 },
      { id: 2, name: 'Игрок 2', score: 0 },
      { id: 3, name: 'Игрок 3', score: 0 },
    ],
    packName: 'Демо',
    rounds: [{ index: 0, name: 'Первый раунд', kind: 'normal' }],
    roundIndex: 0,
    warnings: [],
    questions: [
      {
        id: 'history-100',
        roundIndex: 0,
        themeId: 'history',
        themeName: 'История',
        value: 100,
        text: 'вопрос',
        answers: ['секретный эталон'],
        media: [{ kind: 'image', name: 'star.png', url: 'blob:http://127.0.0.1/secret' }],
      },
    ],
    playedIds: [],
    missedIds: [],
    finalists: [],
    finalCursor: 0,
    bets: [],
    betMisses: 0,
    activeStake: null,
    activeQuestionId: null,
    activePlayerId: null,
    chooserId: 2,
    attemptId: 0,
    clarifications: 0,
    spokeWithoutButton: false,
    talkedDuringRead: false,
    sayFalseStart: false,
    wrongHeard: [],
    sayCloseGuess: false,
    heard: '',
    judgmentReason: 'это не Солнце',
    judgmentStatus: null,
    announceKind: null,
    clarifyReason: '',
    error: null,
    resumePath: '',
    resumeStatus: '',
    statusLine: '',
    phaseStartedAt: 10,
    phaseDurationMs: 20,
    earlyLeftMs: 30,
    earlyStartedAt: 40,
    pauseStartedAt: null,
    falseStarts: { 1: 5 },
    ...patch,
  }
}

function sample(patch: Partial<SavedGame> = {}): SavedGame {
  return {
    version: savedGameVersion,
    packId: 'demo',
    packFile: 'demo.siq',
    packName: 'Демо',
    packHash: '',
    players: [
      { id: 1, name: 'Игрок 1', score: 100 },
      { id: 2, name: 'Игрок 2', score: -40 },
      { id: 3, name: 'Игрок 3', score: 0 },
    ],
    roundIndex: 1,
    playedIds: ['q1'],
    missedIds: [2],
    chooserId: 1,
    finalists: [1, 3],
    bets: [{ playerId: 1, amount: 20 }],
    finalCursor: 1,
    betMisses: 0,
    activeQuestionId: 'q2',
    activePlayerId: 3,
    activeStake: 20,
    attemptId: 4,
    clarifications: 1,
    heard: 'Тибр',
    wrongHeard: [],
    sayCloseGuess: false,
    announceKind: 'incorrect',
    judgmentStatus: 'incorrect',
    phase: 'announcing',
    ...patch,
  }
}

describe('saved game', () => {
  it('пишет снимок отдельным ключом и не кладёт туда ключ API', () => {
    const storage = memory()
    storage.setItem(storageKey, 'sk-test-should-stay')
    const saved = persistMatch(
      {
        packId: 'demo',
        packFile: 'demo.siq',
        path: 'choosing.listening',
        context: context({
          players: [
            { id: 1, name: 'Игрок 1', score: 100 },
            { id: 2, name: 'Игрок 2', score: 0 },
            { id: 3, name: 'Игрок 3', score: 0 },
          ],
          playedIds: ['history-100'],
          chooserId: 1,
        }),
      },
      storage,
    )
    const raw = storage.getItem(gameStorageKey) ?? ''
    expect(gameStorageKey).toBe('aisigame.game')
    expect(gameStorageKey).not.toBe(storageKey)
    expect(saved?.players[0]?.score).toBe(100)
    expect(saved?.phase).toBe('choosing.listening')
    expect(saved?.playedIds).toEqual(['history-100'])
    expect(raw).not.toContain('sk-test-should-stay')
    expect(raw).not.toContain('openaiApiKey')
    expect(raw).not.toContain('apiKey')
    expect(raw).not.toContain('blob:')
    expect(raw).not.toContain('секретный эталон')
    expect(raw).not.toContain('это не Солнце')
    expect(raw).not.toContain('judgmentReason')
    expect(storage.getItem(storageKey)).toBe('sk-test-should-stay')
    expect(readSavedGame(storage)?.chooserId).toBe(1)
  })

  it('на каждом ходе обновляет снимок, а остановка и пауза не затирают фазу', () => {
    const storage = memory()
    persistMatch(
      {
        packId: 'tournament',
        packFile: 'tournament.siq',
        path: 'judging',
        context: context({
          players: [
            { id: 1, name: 'Игрок 1', score: 300 },
            { id: 2, name: 'Игрок 2', score: 0 },
            { id: 3, name: 'Игрок 3', score: 0 },
          ],
          roundIndex: 2,
          activeQuestionId: 'history-100',
        }),
      },
      storage,
    )
    expect(readSavedGame(storage)?.phase).toBe('answering.waiting')
    expect(readSavedGame(storage)?.roundIndex).toBe(2)

    persistMatch(
      {
        packId: 'tournament',
        packFile: 'tournament.siq',
        path: 'paused',
        context: context({ resumePath: 'reading.armed', roundIndex: 2 }),
      },
      storage,
    )
    expect(readSavedGame(storage)?.phase).toBe('reading.armed')

    persistMatch(
      {
        packId: 'tournament',
        packFile: 'tournament.siq',
        path: 'stopped',
        context: context({ roundIndex: 0, players: context().players }),
      },
      storage,
    )
    expect(readSavedGame(storage)?.phase).toBe('reading.armed')
    expect(readSavedGame(storage)?.roundIndex).toBe(2)

    persistMatch(
      {
        packId: 'tournament',
        packFile: 'tournament.siq',
        path: 'failed',
        context: context(),
      },
      storage,
    )
    expect(readSavedGame(storage)?.phase).toBe('reading.armed')
  })

  it('новая партия затирает снимок, выход его удаляет, свой файл с диска можно продолжить', () => {
    const storage = memory()
    persistMatch(
      { packId: 'demo', packFile: 'demo.siq', path: 'choosing.listening', context: context() },
      storage,
    )
    persistMatch(
      {
        packId: 'studio',
        packFile: 'studio.siq',
        path: 'connecting',
        context: context({ packName: 'Наглядно', resumePath: '' }),
      },
      storage,
    )
    expect(readSavedGame(storage)?.packId).toBe('studio')
    expect(readSavedGame(storage)?.phase).toBe('welcoming')

    persistMatch(
      {
        packId: 'studio',
        packFile: 'studio.siq',
        path: 'connecting',
        context: context({ resumePath: 'announcing', announceKind: 'nobody', activeQuestionId: 'history-100' }),
      },
      storage,
    )
    expect(readSavedGame(storage)?.phase).toBe('announcing')

    clearSavedGame(storage)
    expect(readSavedGame(storage)).toBeNull()
    const catalog = ['demo', 'studio', 'tournament']
    expect(packCanResume(null, catalog)).toBe(false)
    expect(packCanResume(sample({ packId: 'gone-pack' }), catalog)).toBe(false)
    expect(packCanResume(sample({ packId: 'demo' }), catalog)).toBe(true)
    const disk = sample({ packId: 'file', packFile: 'chill.siq', packName: 'чиллово-кнопочный #3' })
    expect(packCanResume(disk, catalog)).toBe(true)
    expect(resumeNeedsFile(disk)).toBe(true)
    expect(resumeNeedsFile(sample({ packId: 'demo' }))).toBe(false)
    expect(resumeNeedsFile(null)).toBe(false)
    expect(resumePackTitle(disk)).toBe('chill.siq')
    expect(resumePackTitle(sample({ packId: 'file', packName: '  ', packFile: 'other.xml' }))).toBe('other.xml')
    expect(resumePackTitle(sample({ packId: 'demo' }))).toBe('Демо')
    expect(resumePackTitle(sample({ packId: 'legacy', packName: '  ' }))).toBe('legacy')
    expect(readSavedGame(memory())).toBeNull()
    storage.setItem(gameStorageKey, '{')
    expect(readSavedGame(storage)).toBeNull()
    storage.setItem(gameStorageKey, JSON.stringify({ ...sample(), apiKey: 'sk-live', version: savedGameVersion }))
    const raw = storage.getItem(gameStorageKey) ?? ''
    expect(raw).toContain('sk-live')
    const cleaned = readSavedGame(storage)
    expect(cleaned).not.toBeNull()
    expect(JSON.stringify(cleaned)).not.toContain('sk-live')
    expect(JSON.stringify(cleaned)).not.toContain('apiKey')
    expect(cleaned?.version).toBe(savedGameVersion)
    storage.setItem(gameStorageKey, JSON.stringify({ ...sample(), version: savedGameVersion + 1 }))
    expect(readSavedGame(storage)).toBeNull()
  })

  it('возвращает в сохранённую фазу только если вопрос ещё есть в пакете', () => {
    const restored = restoredMatch(demoPack, sample({
      phase: 'reading.sealed',
      roundIndex: 0,
      activeQuestionId: 'history-100',
      playedIds: ['history-200'],
      chooserId: 3,
    }))
    expect(restored.resumePath).toBe('reading.sealed')
    expect(restored.activeQuestionId).toBe('history-100')
    expect(restored.playedIds).toEqual(['history-200'])
    expect(restored.chooserId).toBe(3)

    const missing = restoredMatch(demoPack, sample({ phase: 'buzzing.open', activeQuestionId: 'nope', roundIndex: 0 }))
    expect(missing.resumePath).toBe('choosing.listening')
    expect(missing.activeQuestionId).toBeNull()
    expect(missing.players[0]?.score).toBe(100)

    const numbered = restoredMatch(
      { ...demoPack, rounds: [{ index: 0, name: '2', kind: 'normal' }] },
      sample({ phase: 'choosing.listening', chooserId: 1, roundIndex: 0 }),
    )
    expect(numbered.statusLine).toBe('назовите тему и стоимость')
    const finalTheme = restoredMatch(
      { ...demoPack, rounds: [{ index: 0, name: '1', kind: 'final' }] },
      sample({ phase: 'choosing.listening', chooserId: 1, roundIndex: 0 }),
    )
    expect(finalTheme.statusLine).toBe('Выберите тему финала')
  })

  it('хранит сколько угодно игроков и не кладёт ключ', () => {
    const storage = memory()
    storage.setItem(storageKey, 'sk-four-players')
    const players = [
      { id: 1, name: 'Анна', score: 10 },
      { id: 2, name: 'Борис', score: 20 },
      { id: 3, name: 'Вера', score: 0 },
      { id: 4, name: 'Глеб', score: -5 },
    ]
    persistMatch(
      {
        packId: 'demo',
        packFile: 'demo.siq',
        path: 'choosing.listening',
        context: context({
          players,
          missedIds: [4],
          chooserId: 4,
          finalists: [1, 2, 4],
          bets: [{ playerId: 4, amount: 3 }],
        }),
      },
      storage,
    )
    const saved = readSavedGame(storage)
    expect(saved?.players).toEqual(players)
    expect(saved?.missedIds).toEqual([4])
    expect(saved?.chooserId).toBe(4)
    expect(saved?.finalists).toEqual([1, 2, 4])
    expect(saved?.bets).toEqual([{ playerId: 4, amount: 3 }])
    const raw = storage.getItem(gameStorageKey) ?? ''
    expect(raw).not.toContain('sk-four-players')
    expect(raw).not.toContain('openaiApiKey')
    expect(storage.getItem(storageKey)).toBe('sk-four-players')
    expect(readSavedGame(storage)?.players).toHaveLength(4)
  })

  it('помнит неверные реплики открытого вопроса и монетку объявления', () => {
    const storage = memory()
    persistMatch(
      {
        packId: 'demo',
        packFile: 'demo.siq',
        path: 'announcing',
        context: context({
          activeQuestionId: 'history-100',
          announceKind: 'nobody',
          wrongHeard: ['Братство кольца'],
          sayCloseGuess: true,
        }),
      },
      storage,
    )
    const saved = readSavedGame(storage)
    expect(saved?.wrongHeard).toEqual(['Братство кольца'])
    expect(saved?.sayCloseGuess).toBe(true)
    const announcing = restoredMatch(demoPack, saved ?? sample())
    expect(announcing.wrongHeard).toEqual(['Братство кольца'])
    expect(announcing.sayCloseGuess).toBe(true)

    const buzzing = restoredMatch(
      demoPack,
      sample({
        phase: 'buzzing.open',
        roundIndex: 0,
        activeQuestionId: 'history-100',
        wrongHeard: ['Братство кольца'],
        sayCloseGuess: true,
      }),
    )
    expect(buzzing.wrongHeard).toEqual(['Братство кольца'])
    expect(buzzing.sayCloseGuess).toBe(false)

    const choosing = restoredMatch(
      demoPack,
      sample({ phase: 'choosing.listening', wrongHeard: ['Братство кольца'], sayCloseGuess: true }),
    )
    expect(choosing.wrongHeard).toEqual([])
    expect(choosing.sayCloseGuess).toBe(false)

    const legacy = { ...sample() } as Record<string, unknown>
    delete legacy.wrongHeard
    delete legacy.sayCloseGuess
    storage.setItem(gameStorageKey, JSON.stringify(legacy))
    expect(readSavedGame(storage)?.wrongHeard).toEqual([])
    expect(readSavedGame(storage)?.sayCloseGuess).toBe(false)
    storage.setItem(gameStorageKey, JSON.stringify({ ...sample(), wrongHeard: 'нет' }))
    expect(readSavedGame(storage)).toBeNull()
  })

  it('сверяет sha256 своего файла: совпадение продолжает, чужой файл нет, старый снимок без хеша можно', async () => {
    const hash = 'ab'.repeat(32)
    const other = 'cd'.repeat(32)
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )

    expect(decideResumeFile({ savedHash: hash.toUpperCase(), chosenHash: hash, fileName: 'chill.siq' })).toEqual({
      ok: true,
    })
    const miss = decideResumeFile({ savedHash: hash, chosenHash: other, fileName: 'chill.siq' })
    expect(miss.ok).toBe(false)
    if (!miss.ok) {
      expect(miss.message).toContain('не из сохранённой игры')
      expect(miss.message).toContain('«chill.siq»')
      expect(miss.message).toContain(hash)
      expect(miss.message).toContain(other)
    }
    expect(decideResumeFile({ savedHash: '', chosenHash: other, fileName: 'chill.siq' }).ok).toBe(true)
    expect(decideResumeFile({ savedHash: undefined, chosenHash: other, fileName: 'old.siq' }).ok).toBe(true)
    expect(decideResumeFile({ savedHash: '   ', chosenHash: other, fileName: 'old.siq' }).ok).toBe(true)
    const nameless = decideResumeFile({ savedHash: hash, chosenHash: other, fileName: '  ' })
    expect(nameless.ok).toBe(false)
    if (!nameless.ok) {
      expect(nameless.message).not.toContain('«')
      expect(nameless.message).toContain(hash)
      expect(nameless.message).toContain(other)
    }

    const storage = memory()
    persistMatch(
      {
        packId: 'file',
        packFile: 'chill.siq',
        packHash: hash.toUpperCase(),
        path: 'choosing.listening',
        context: context({ packName: 'Чил' }),
      },
      storage,
    )
    const saved = readSavedGame(storage)
    expect(saved?.packFile).toBe('chill.siq')
    expect(saved?.packHash).toBe(hash)
    const raw = storage.getItem(gameStorageKey) ?? ''
    expect(raw).toContain('chill.siq')
    expect(raw).toContain(hash)
    expect(raw).not.toContain('fileBytes')
    expect(resumeFileName(saved)).toBe('chill.siq')

    persistMatch(
      {
        packId: 'file',
        packFile: 'chill.siq',
        path: 'buzzing.open',
        context: context({ packName: 'Чил', roundIndex: 0, activeQuestionId: 'history-100' }),
      },
      storage,
    )
    expect(readSavedGame(storage)?.packHash).toBe(hash)

    persistMatch(
      {
        packId: 'file',
        packFile: 'other.siq',
        path: 'choosing.listening',
        context: context({ packName: 'Чил' }),
      },
      storage,
    )
    expect(readSavedGame(storage)?.packFile).toBe('other.siq')
    expect(readSavedGame(storage)?.packHash).toBe('')

    persistMatch(
      { packId: 'demo', packFile: 'demo.siq', path: 'choosing.listening', context: context() },
      storage,
    )
    expect(readSavedGame(storage)?.packHash).toBe('')
    expect(resumeFileName(readSavedGame(storage))).toBe('')

    const legacy = { ...sample(), packId: 'file', packFile: 'legacy.siq', packName: 'Название внутри' } as Record<
      string,
      unknown
    >
    delete legacy.packHash
    storage.setItem(gameStorageKey, JSON.stringify(legacy))
    const old = readSavedGame(storage)
    expect(old?.packFile).toBe('legacy.siq')
    expect(old?.packHash).toBe('')
    expect(resumeFileName(old)).toBe('legacy.siq')
    expect(resumeFileName(sample({ packId: 'file', packFile: '   ', packName: 'Не имя файла' }))).toBe('')
    expect(decideResumeFile({ savedHash: old?.packHash, chosenHash: other, fileName: old?.packFile ?? '' }).ok).toBe(
      true,
    )

    storage.setItem(gameStorageKey, JSON.stringify({ ...legacy, packHash: 12, packFile: 'kept.siq' }))
    const weird = readSavedGame(storage)
    expect(weird?.packFile).toBe('kept.siq')
    expect(weird?.packHash).toBe('')
    expect(weird).not.toBeNull()
  })

  it('старый снимок без mode читается как стол', () => {
    const storage = memory()
    storage.setItem(gameStorageKey, JSON.stringify(sample()))
    const saved = readSavedGame(storage)
    expect(saved).not.toBeNull()
    expect(saved?.mode).toBeUndefined()
    expect(readMatchMode(saved)).toBe('table')
  })

  it('поля конференции сохраняются и читаются обратно', () => {
    const storage = memory()
    const chat = [
      { name: 'Аня', text: 'привет' },
      { name: 'Боря', text: 'ответ' },
    ]
    persistMatch(
      {
        packId: 'demo',
        packFile: 'demo.siq',
        path: 'choosing.listening',
        context: context({
          players: [
            { id: 1, name: 'Хост', score: 0, clientId: 'host-1' },
            { id: 2, name: 'Гость', score: 0, clientId: 'guest-2' },
          ],
        }),
        conference: {
          mode: 'conference',
          jitsiUrl: 'https://meet.example/jitsi',
          roomId: 'room-abc',
          chat,
        },
      },
      storage,
    )
    const saved = readSavedGame(storage)
    expect(saved?.mode).toBe('conference')
    expect(saved?.jitsiUrl).toBe('https://meet.example/jitsi')
    expect(saved?.roomId).toBe('room-abc')
    expect(saved?.chat).toBeUndefined()
    expect(messageRingEntries(saved as Parameters<typeof messageRingEntries>[0]).map(({ message }) => message)).toEqual(chat.map((line) => ({ kind: 'chat', ...line })))
    expect(saved?.players[0]?.clientId).toBe('host-1')
    expect(readMatchMode(saved)).toBe('conference')
  })

  it('хранит все 200 физических слотов и индекс одинаково в лобби, партии и после повторного чтения', () => {
    const storage = memory()
    const ring = emptyMessageRing()
    ring.messageIndex = 37
    for (let slot = 0; slot < 200; slot++) {
      ring[`message${slot}`] = slot % 2
        ? { kind: 'chat', name: 'Гость', text: `чат ${slot}`, at: '2026-10-12T12:00:00.000Z' }
        : { kind: 'conversation', role: 'host', text: `реплика ${slot}`, note: `эталон ${slot}`, at: '2026-10-12T12:00:00.000Z' }
    }
    persistConferenceLobby({
      packId: 'demo', packFile: 'demo.siq', pack: demoPack,
      master: { id: 1, name: 'Мастер', score: 0, clientId: 'master' },
      jitsiUrl: 'https://meet.example/jitsi', roomId: 'history-room', messageRing: ring,
    }, storage)
    expect(readMessageRing(readSavedGame(storage))).toEqual(ring)
    const raw = JSON.parse(storage.getItem(gameStorageKey)!)
    expect(Object.keys(raw).filter((key) => /^message\d+$/.test(key))).toHaveLength(200)
    expect(raw).not.toHaveProperty('chat')
    expect(raw).not.toHaveProperty('conversation')
    persistMatch({
      packId: 'demo', packFile: 'demo.siq', path: 'choosing.listening', context: context(),
      conference: { mode: 'conference', conferenceLobby: false, roomId: 'history-room' },
    }, storage)
    expect(readMessageRing(readSavedGame(storage))).toEqual(ring)
    const next = { ...ring, messageIndex: 38, message38: { kind: 'conversation' as const, role: 'judge' as const, text: 'Верно', note: 'Правильный ответ: Август' } }
    const saved = persistConferenceHistory('history-room', next, storage)
    expect(saved?.phase).toBe('choosing.listening')
    expect(readMessageRing(readSavedGame(storage))).toEqual(next)
    expect(messageRingEntries(next).at(-1)?.message).toEqual(next.message38)
    const before = storage.getItem(gameStorageKey)
    expect(persistConferenceHistory('other-room', ring, storage)).toBeNull()
    expect(storage.getItem(gameStorageKey)).toBe(before)
    persistMatch({ packId: 'demo', packFile: 'demo.siq', path: 'choosing.listening', context: context(), conference: { mode: 'table' } }, storage)
    expect(readSavedGame(storage)?.messageIndex).toBeUndefined()
  })

  it('мигрирует старый chat в слоты, а неизвестные поля реплики не сохраняет', () => {
    const storage = memory()
    storage.setItem(gameStorageKey, JSON.stringify({ ...sample(), mode: 'conference', roomId: 'legacy', chat: [{ name: 'Мастер', text: 'Старый чат' }] }))
    const legacy = readSavedGame(storage)
    expect(legacy?.messageIndex).toBe(0)
    expect(legacy?.message0).toEqual({ kind: 'chat', name: 'Мастер', text: 'Старый чат' })
    expect(legacy?.chat).toBeUndefined()
    const ring = emptyMessageRing()
    ring.messageIndex = 0
    Object.assign(ring, { authorityToken: 'do-not-store' })
    ring.message0 = Object.assign({ kind: 'conversation' as const, role: 'host' as const, text: 'Реплика', note: 'Подпись' }, { authToken: 'do-not-store' })
    persistConferenceHistory('legacy', ring, storage)
    expect(readSavedGame(storage)?.message0).toEqual({ kind: 'conversation', role: 'host', text: 'Реплика', note: 'Подпись' })
    expect(storage.getItem(gameStorageKey)).not.toContain('do-not-store')
  })

  it('сохраняет онлайн-лобби до старта машины и отличает его от начатой партии', () => {
    const storage = memory()
    const lobby = persistConferenceLobby(
      {
        packId: 'demo',
        packFile: 'demo.siq',
        packHash: 'ab'.repeat(32),
        pack: demoPack,
        master: { id: 1, name: 'Мастер', score: 0, clientId: 'master-1' },
        jitsiUrl: 'https://meet.example/jitsi',
        roomId: 'room-lobby',
      },
      storage,
    )
    expect(lobby).toMatchObject({
      mode: 'conference',
      conferenceLobby: true,
      roomId: 'room-lobby',
      phase: 'welcoming',
    })
    expect(lobby?.players).toEqual([{ id: 1, name: 'Мастер', score: 0, clientId: 'master-1' }])
    expect(packCanResume(readSavedGame(storage), ['demo'])).toBe(true)

    persistMatch(
      {
        packId: 'demo',
        packFile: 'demo.siq',
        packHash: 'ab'.repeat(32),
        path: 'choosing.listening',
        context: context(),
        conference: {
          mode: 'conference',
          conferenceLobby: false,
          jitsiUrl: 'https://meet.example/jitsi',
          roomId: 'room-lobby',
        },
      },
      storage,
    )
    expect(readSavedGame(storage)?.conferenceLobby).toBeUndefined()

    persistMatch(
      {
        packId: 'demo',
        packFile: 'demo.siq',
        path: 'choosing.listening',
        context: context(),
        conference: { mode: 'table' },
      },
      storage,
    )
    expect(readSavedGame(storage)).toMatchObject({ mode: 'table' })
    expect(readSavedGame(storage)?.roomId).toBeUndefined()
  })

  it('«Меньше слышать» по умолчанию вкл., явное значение уважается', () => {
    expect(hearTurnOnlyOf(null)).toBe(true)
    expect(hearTurnOnlyOf({})).toBe(true)
    expect(hearTurnOnlyOf({ hearTurnOnly: false })).toBe(false)
    expect(hearTurnOnlyOf({ hearTurnOnly: true })).toBe(true)
  })

  it('сохраняет и снимает галку «Меньше слышать»', () => {
    const storage = memory()
    persistMatch(
      {
        packId: 'demo',
        packFile: 'demo.siq',
        path: 'choosing.listening',
        context: context(),
        hearTurnOnly: true,
        conference: { mode: 'conference', roomId: 'r1', jitsiUrl: 'https://meet.example/jitsi' },
      },
      storage,
    )
    expect(readSavedGame(storage)?.hearTurnOnly).toBe(true)

    persistMatch(
      {
        packId: 'demo',
        packFile: 'demo.siq',
        path: 'choosing.listening',
        context: context(),
        hearTurnOnly: false,
        conference: { mode: 'conference', roomId: 'r1', jitsiUrl: 'https://meet.example/jitsi' },
      },
      storage,
    )
    expect(readSavedGame(storage)?.hearTurnOnly).toBe(false)

    persistConferenceLobby(
      {
        packId: 'demo',
        packFile: 'demo.siq',
        pack: demoPack,
        master: { id: 1, name: 'Мастер', score: 0, clientId: 'm1' },
        jitsiUrl: 'https://meet.example/jitsi',
        roomId: 'lobby-1',
        hearTurnOnly: true,
      },
      storage,
    )
    expect(readSavedGame(storage)?.hearTurnOnly).toBe(true)

    persistMatch(
      {
        packId: 'demo',
        packFile: 'demo.siq',
        path: 'startMenu',
        context: context(),
        hearTurnOnly: false,
      },
      storage,
    )
    expect(readSavedGame(storage)?.hearTurnOnly).toBe(false)
  })
})
