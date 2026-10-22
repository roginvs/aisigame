import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QwenWire } from './qwenWire.ts'

class FakeAudio {
  autoplay = false
  pause() {}
}

type Harness = {
  dc: unknown
  sink: unknown
  onMessage(data: string): void
}

describe('Qwen: откат дополнительных полей VAD', () => {
  let wire: QwenWire
  let feed: (event: object) => void
  let sent: Array<Record<string, unknown>>
  let received: Array<Record<string, unknown>>

  beforeEach(() => {
    vi.stubGlobal('Audio', FakeAudio)
    wire = new QwenWire('qwen', 'workspace')
    sent = []
    received = []
    const harness = wire as unknown as Harness
    harness.dc = { readyState: 'open', send: (raw: string) => sent.push(JSON.parse(raw)) }
    harness.sink = { message: (raw: string) => received.push(JSON.parse(raw)) }
    feed = (event) => harness.onMessage(JSON.stringify(event))
  })

  afterEach(() => { vi.unstubAllGlobals() })

  it('сохраняет инструкции, modalities и инструменты текущего хода; обработанная ошибка не проваливает tool', () => {
    wire.send({ type: 'response.create', response: { instructions: 'Прочитай вопрос', output_modalities: ['text'], tools: [] } })
    feed({ type: 'error', error: { param: 'turn_detection.interrupt_response', message: 'unsupported turn_detection field' } })
    expect(sent.at(-1)).toMatchObject({
      type: 'session.update',
      session: { instructions: 'Прочитай вопрос', modalities: ['text'], tools: [], turn_detection: { type: 'semantic_vad' } },
    })
    expect(received).toEqual([])
    // Если и упрощённые настройки отвергнуты, ошибка должна дойти до клиента.
    feed({ type: 'error', error: { param: 'turn_detection', message: 'unsupported turn_detection' } })
    expect(received).toHaveLength(1)
  })

  it('после отката следующие ходы также не отправляют отвергнутые поля', () => {
    wire.send({ type: 'session.update', session: { instructions: 'Ведущая' } })
    feed({ type: 'error', error: { param: 'turn_detection', message: 'unsupported' } })
    wire.send({ type: 'response.create', response: { metadata: { purpose: 'buzzCall' }, instructions: 'Имя, отвечайте' } })
    expect(sent.at(-2)).toMatchObject({ session: { instructions: 'Имя, отвечайте', turn_detection: { type: 'semantic_vad' } } })
  })

  it('подсказка распознавателю и скорость после заказа чтения не сбрасывают инструкции хода', () => {
    wire.send({ type: 'response.create', response: { instructions: 'Прочитай дословно', tools: [] } })
    const count = sent.length
    wire.send({ type: 'session.update', session: { audio: { input: { transcription: { prompt: '' } } } } })
    wire.send({ type: 'session.update', session: { audio: { output: { speed: 1.1 } } } })
    expect(sent).toHaveLength(count)
    expect(sent.at(-2)).toMatchObject({ session: { instructions: 'Прочитай дословно', tools: [] } })
  })
})
