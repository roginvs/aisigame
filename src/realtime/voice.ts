import { MockRealtimeClient } from './mockClient.ts'
import { readQwenEndpoint, voiceById } from './models.ts'
import { RealtimeClient, type GameVoice } from './client.ts'
import { GeminiWire } from './geminiWire.ts'
import { GrokWire } from './grokWire.ts'
import { QwenWire } from './qwenWire.ts'

/** Одна ведущая для партии: модель выбирает провод, контроллер говорит с одним интерфейсом. */
export function createVoice(modelId: string): GameVoice {
  const model = voiceById(modelId)
  if (model.provider === 'mock') return new MockRealtimeClient()
  if (model.provider === 'xai') return new RealtimeClient({ model: model.id, wire: new GrokWire(model.id) })
  if (model.provider === 'google') {
    return new RealtimeClient({ model: model.id, wire: new GeminiWire(model.id, Boolean(model.thinking)) })
  }
  if (model.provider === 'qwen') {
    return new RealtimeClient({ model: model.id, wire: new QwenWire(model.id, readQwenEndpoint()) })
  }
  return new RealtimeClient({ model: model.id })
}
