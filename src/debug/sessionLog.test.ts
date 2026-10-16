import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCommit } from '../buildInfo.ts'
import { debugLogGame, getTrace, joinDebugLogFor, noteSession, startDebugLogFor, wipeDebugLog } from './trace.ts'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  }
}

describe('лог принадлежит игре', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('игрок: та же игра — лог остаётся, другая — стирается; мастер стирает всегда', async () => {
    vi.stubGlobal('localStorage', memoryStorage())
    const wipe = vi.fn(async () => undefined)
    expect(joinDebugLogFor('room-a', wipe)).toBe(true)
    expect(joinDebugLogFor('room-a', wipe)).toBe(false)
    expect(wipe).toHaveBeenCalledTimes(1)
    expect(joinDebugLogFor('room-b', wipe)).toBe(true)
    expect(debugLogGame()).toBe('room-b')
    await startDebugLogFor('game-c')
    expect(debugLogGame()).toBe('game-c')
    await wipeDebugLog()
    expect(debugLogGame()).toBe('')
  })

  it('запись о сессии: роль, игра, имя, сборка', () => {
    noteSession({ role: 'игрок', gameId: 'room-a', name: 'Вася' })
    const last = getTrace().at(-1)
    expect(last?.title).toBe(`[сессия] игрок: игра room-a, имя Вася, сборка ${buildCommit()}`)
  })
})
