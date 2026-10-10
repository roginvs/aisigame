import { describe, expect, it } from 'vitest'
import { storageKey } from '../config.ts'
import { clearSavedGame, gameStorageKey } from './savedGame.ts'
import { preferredPackId, readStartPrefs, startStorageKey, writeStartPrefs } from './startPrefs.ts'

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

const catalog = ['studio', 'demo']

describe('start prefs', () => {
  it('помнит строки имён и пакет каталога, свой файл и ключ не пишет', () => {
    const storage = memory()
    storage.setItem(storageKey, 'sk-should-stay')
    storage.setItem(gameStorageKey, '{"packId":"old"}')
    const saved = writeStartPrefs({ names: 'Вася\n\nМаша', packId: 'demo' }, catalog, storage)
    expect(saved).toEqual({ names: 'Вася\n\nМаша', packId: 'demo' })
    expect(readStartPrefs(storage)).toEqual(saved)
    expect(startStorageKey).toBe('aisigame.start')
    expect(startStorageKey).not.toBe(gameStorageKey)
    expect(startStorageKey).not.toBe(storageKey)
    const raw = storage.getItem(startStorageKey) ?? ''
    expect(raw).not.toContain('sk-should-stay')
    expect(raw).not.toContain('openaiApiKey')
    expect(raw).not.toContain('apiKey')
    expect(storage.getItem(storageKey)).toBe('sk-should-stay')

    writeStartPrefs({ names: 'Вася\n\nМаша', packId: 'file' }, catalog, storage)
    expect(readStartPrefs(storage).packId).toBe('demo')
    expect(preferredPackId('file', catalog, 'studio')).toBe('studio')
    expect(preferredPackId('demo', catalog, 'studio')).toBe('demo')
    expect(preferredPackId('', catalog, 'studio')).toBe('studio')

    clearSavedGame(storage)
    expect(storage.getItem(gameStorageKey)).toBeNull()
    expect(readStartPrefs(storage).names).toBe('Вася\n\nМаша')
    expect(readStartPrefs(storage).packId).toBe('demo')
  })
})
