import { MockRealtimeClient } from './mockClient.ts'
import { voiceById } from './models.ts'
import { RealtimeClient, type GameVoice } from './client.ts'
import { GeminiWire } from './geminiWire.ts'
import { GrokWire } from './grokWire.ts'

/** Одна ведущая для партии: модель выбирает провод, контроллер говорит с одним интерфейсом. */
export function createVoice(modelId: string): GameVoice {
  const model = voiceById(modelId)
  if (model.provider === 'mock') return new MockRealtimeClient()
  if (model.provider === 'xai') return new RealtimeClient({ model: model.id, wire: new GrokWire(model.id) })
  if (model.provider === 'google') {
    return new RealtimeClient({ model: model.id, wire: new GeminiWire(model.id, Boolean(model.thinking)) })
  }
  return new RealtimeClient({ model: model.id })
}
