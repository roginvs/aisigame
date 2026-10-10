import { describe, expect, it } from 'vitest'
import { storageKey } from '../config.ts'
import type { GameContext } from './types.ts'
import {
  clearSavedGame,
  gameStorageKey,
  packCanResume,
  persistMatch,
  readSavedGame,
  resumeNeedsFile,
  resumePackTitle,
  restoredMatch,
  type SavedGame,
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
    version: 1,
    packId: 'demo',
    packFile: 'demo.siq',
    packName: 'Демо',
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
    expect(resumePackTitle(disk)).toBe('чиллово-кнопочный #3')
    expect(resumePackTitle(sample({ packId: 'file', packName: '  ', packFile: 'other.xml' }))).toBe('other.xml')
    expect(resumePackTitle(sample({ packId: 'demo' }))).toBe('')
    expect(readSavedGame(memory())).toBeNull()
    storage.setItem(gameStorageKey, '{')
    expect(readSavedGame(storage)).toBeNull()
    storage.setItem(gameStorageKey, JSON.stringify({ ...sample(), apiKey: 'sk-live', version: 1 }))
    const raw = storage.getItem(gameStorageKey) ?? ''
    expect(raw).toContain('sk-live')
    const cleaned = readSavedGame(storage)
    expect(cleaned).not.toBeNull()
    expect(JSON.stringify(cleaned)).not.toContain('sk-live')
    expect(JSON.stringify(cleaned)).not.toContain('apiKey')
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
})
