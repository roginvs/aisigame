import { describe, expect, it } from 'vitest'
import { storageKey } from '../config.ts'
import {
  keyFieldLabel,
  providerStorageKeys,
  readProviderKey,
  readVoiceModelId,
  voiceById,
  voiceModelStorageKey,
  writeProviderKey,
  writeVoiceModelId,
} from './models.ts'

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

describe('voice models', () => {
  it('помнит модель и ключи разных провайдеров отдельно', () => {
    const storage = memory()
    expect(readVoiceModelId(storage)).toBe('gpt-realtime-2.1-mini')
    expect(writeVoiceModelId('grok-voice-think-fast-2.0', storage)).toBe('grok-voice-think-fast-2.0')
    expect(readVoiceModelId(storage)).toBe('grok-voice-think-fast-2.0')
    writeVoiceModelId('нет такой', storage)
    expect(readVoiceModelId(storage)).toBe('gpt-realtime-2.1-mini')

    writeProviderKey('openai', 'sk-openai', storage)
    writeProviderKey('xai', 'xai-key', storage)
    writeProviderKey('google', 'google-key', storage)
    writeProviderKey('xai', '', storage)
    expect(readProviderKey('openai', storage)).toBe('sk-openai')
    expect(readProviderKey('xai', storage)).toBe('')
    expect(readProviderKey('google', storage)).toBe('google-key')
    expect(providerStorageKeys.openai).toBe(storageKey)
    expect(voiceModelStorageKey).not.toBe(storageKey)
    expect(keyFieldLabel('google')).toBe('Ключ Google')
    expect(voiceById('gemini-3.8-live-extended-thinking').thinking).toBe(true)
    expect(voiceById('mock').provider).toBe('mock')
  })
})
