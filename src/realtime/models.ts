import { storageKey } from '../config.ts'

/** Какая модель говорит за ведущую. Ключ провайдера лежит отдельно и не стирается при смене модели. */
export type VoiceProvider = 'openai' | 'xai' | 'google' | 'mock'

export type VoiceModel = {
  id: string
  label: string
  provider: VoiceProvider
  /** Gemini 3.8 Live Extended Thinking: рассуждение идёт фоном, функции не блокируют реплику. */
  thinking?: boolean
}

export const voiceModelStorageKey = 'aisigame.voiceModel'

export const providerStorageKeys = {
  openai: storageKey,
  xai: 'aisigame.xaiApiKey',
  google: 'aisigame.googleApiKey',
} as const

export type KeyProvider = keyof typeof providerStorageKeys

export const voiceModels: readonly VoiceModel[] = [
  { id: 'gpt-realtime-2.1-mini', label: 'GPT Realtime 2.1 Mini', provider: 'openai' },
  { id: 'gpt-realtime-2.1', label: 'GPT Realtime 2.1', provider: 'openai' },
  { id: 'grok-voice-latest', label: 'Grok Voice Latest', provider: 'xai' },
  { id: 'grok-voice-think-fast-2.0', label: 'Grok Voice Think Fast 2.0', provider: 'xai' },
  { id: 'gemini-3.8-live', label: 'Gemini 3.8 Live', provider: 'google' },
  {
    id: 'gemini-3.8-live-extended-thinking',
    label: 'Gemini 3.8 Live Extended Thinking',
    provider: 'google',
    thinking: true,
  },
  { id: 'mock', label: 'Мок для тестов', provider: 'mock' },
]

const fallbackId = voiceModels[0].id

export function voiceById(id: string): VoiceModel {
  return voiceModels.find((item) => item.id === id) ?? voiceModels[0]
}

export function readVoiceModelId(storage: Storage = localStorage): string {
  const saved = storage.getItem(voiceModelStorageKey) ?? ''
  return voiceModels.some((item) => item.id === saved) ? saved : fallbackId
}

export function writeVoiceModelId(id: string, storage: Storage = localStorage): string {
  const next = voiceById(id).id
  storage.setItem(voiceModelStorageKey, next)
  return next
}

export function readProviderKey(provider: KeyProvider, storage: Storage = localStorage): string {
  return storage.getItem(providerStorageKeys[provider]) ?? ''
}

export function writeProviderKey(provider: KeyProvider, value: string, storage: Storage = localStorage): void {
  const key = providerStorageKeys[provider]
  const trimmed = value.trim()
  if (trimmed) storage.setItem(key, trimmed)
  else storage.removeItem(key)
}

export function keyFieldLabel(provider: VoiceProvider): string {
  if (provider === 'xai') return 'Ключ xAI'
  if (provider === 'google') return 'Ключ Google'
  if (provider === 'mock') return 'Ключ не нужен'
  return 'Ключ OpenAI'
}
