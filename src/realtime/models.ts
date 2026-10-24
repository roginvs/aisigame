import { storageKey } from '../config.ts'

/** Какая модель говорит за ведущую. Ключ провайдера лежит отдельно и не стирается при смене модели. */
export type VoiceProvider = 'openai' | 'xai' | 'google' | 'qwen' | 'mock'

export type VoiceModel = {
  id: string
  label: string
  provider: VoiceProvider
  /** Gemini 3.8 Live Extended Thinking: рассуждение идёт фоном, функции не блокируют реплику. */
  thinking?: boolean
}

export const voiceModelStorageKey = 'aisigame.voiceModel'

/** Одноразовая пометка: модель сменили в партии, страница открылась заново. */
export const modelSwitchNoticeKey = 'aisigame.modelSwitchNotice'

export const providerStorageKeys = {
  openai: storageKey,
  xai: 'aisigame.xaiApiKey',
  google: 'aisigame.googleApiKey',
  qwen: 'aisigame.qwenApiKey',
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
  { id: 'qwen3.8-omni-flash-realtime', label: 'Qwen Omni Realtime Flash', provider: 'qwen' },
  { id: 'mock', label: 'Мок для тестов', provider: 'mock' },
]

const fallbackModel: VoiceModel = voiceModels[0]!
const fallbackId = fallbackModel.id

export function voiceById(id: string): VoiceModel {
  return voiceModels.find((item) => item.id === id) ?? fallbackModel
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

/** `?mock=1` после перезагрузки снова включил бы мок, хотя id уже другой. */
export function hrefAfterModelSwitch(href: string): string {
  const url = new URL(href)
  url.searchParams.delete('mock')
  return url.href
}

export function markModelSwitch(storage: Storage = sessionStorage): void {
  storage.setItem(modelSwitchNoticeKey, '1')
}

export function takeModelSwitchNotice(storage: Storage = sessionStorage): boolean {
  const marked = storage.getItem(modelSwitchNoticeKey) === '1'
  if (marked) storage.removeItem(modelSwitchNoticeKey)
  return marked
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
  if (provider === 'qwen') return 'Ключ DashScope'
  if (provider === 'mock') return 'Ключ не нужен'
  return 'Ключ OpenAI'
}

/** workspace-адрес Qwen у DashScope соединение требует отдельно от ключа ({workspaceId}.{регион}.maas.aliyuncs.com). */
export const qwenEndpointStorageKey = 'aisigame.qwenEndpoint'

export function readQwenEndpoint(storage: Storage = localStorage): string {
  return storage.getItem(qwenEndpointStorageKey) ?? ''
}

export function writeQwenEndpoint(value: string, storage: Storage = localStorage): void {
  storage.setItem(qwenEndpointStorageKey, value)
}

/** DashScope не отдаёт браузеру CORS и не берёт ключ из адреса WebSocket: SDP-обмен идёт через релей. */
export const qwenRelayStorageKey = 'aisigame.qwenRelay'

export function readQwenRelay(storage: Storage = localStorage): string {
  return storage.getItem(qwenRelayStorageKey) ?? ''
}

export function writeQwenRelay(value: string, storage: Storage = localStorage): void {
  storage.setItem(qwenRelayStorageKey, value)
}

/**
 * Не копить текст чтения и оценки в истории сессии Qwen и Gemini.
 * Пустое значение — включено. «0» — выключено, ход снова пишется в историю.
 * OpenAI и Grok не читают этот флаг: у них ход и так вне основной истории.
 */
export const isolateSessionHistoryKey = 'aisigame.isolateSessionHistory'

export function readIsolateSessionHistory(storage?: Pick<Storage, 'getItem'>): boolean {
  try {
    const store = storage ?? globalThis.localStorage
    return store.getItem(isolateSessionHistoryKey) !== '0'
  } catch {
    return true
  }
}

export function writeIsolateSessionHistory(enabled: boolean, storage?: Pick<Storage, 'setItem'>): void {
  try {
    const store = storage ?? globalThis.localStorage
    store.setItem(isolateSessionHistoryKey, enabled ? '1' : '0')
  } catch {
    // Текущая страница всё равно держит переключатель в состоянии.
  }
}
