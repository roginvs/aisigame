import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTrace } from '../debug/trace.ts'
import { RealtimeClient } from './client.ts'
import twoItems from './fixtures/clarify-two-items.json'

class FakeAudio { autoplay = false; muted = false; srcObject = null; pause() {} }
type Harness = { dc: unknown; wireOpen: boolean; handleMessage(raw: string): void }

let client: RealtimeClient
let feed: (event: object) => void
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('window', globalThis); vi.stubGlobal('Audio', FakeAudio)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  client = new RealtimeClient()
  const opened = client as unknown as Harness
  opened.dc = { readyState: 'open', send: vi.fn(), onmessage: null }
  opened.wireOpen = true
  feed = (event) => opened.handleMessage(JSON.stringify(event))
})
afterEach(() => { client.stopSession(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('чат ведущей: одна реплика — одна строка', () => {
  it('ответ из двух сказанных реплик (живая игра 14.10, 20:40:11): обе в чате ровно по разу', () => {
    const cursor = getTrace().at(-1)?.id ?? 0
    client.requestSpeech('clarify', 28, 'Попроси выбрать ещё раз.')
    for (const event of twoItems) feed(event)
    // Подпись звучащей реплики — когда звук доиграл.
    feed({ type: 'output_audio_buffer.stopped' })
    const host = getTrace().filter((e) => e.id > cursor && e.kind === 'chat' && e.title === 'Ведущая').map((e) => (e.detail as { text: string }).text)
    expect(host).toEqual([
      'Хорошо, давайте уточним выбор, чтобы не пропускать снова.',
      'Вася, выбери ячейку ещё раз, пожалуйста.',
    ])
  })
})

describe('чат ведущей: реплику оборвали мы — в чате только прозвучавшее и «…»', () => {
  const line = 'Вася, выбери ячейку ещё раз, пожалуйста, тему и стоимость.'
  const hostLines = (cursor: number) => getTrace().filter((e) => e.id > cursor && e.kind === 'chat' && e.title === 'Ведущая').map((e) => (e.detail as { text: string }).text)
  function speak() {
    const cursor = getTrace().at(-1)?.id ?? 0
    client.requestSpeech('clarify', 1, 'Попроси выбрать ещё раз.')
    feed({ type: 'response.created', response: { id: 'r1' } })
    feed({ type: 'response.output_item.added', response_id: 'r1', item: { id: 'it1', type: 'message', role: 'assistant' } })
    feed({ type: 'output_audio_buffer.started', response_id: 'r1' })
    return cursor
  }

  it('текст пришёл раньше обрыва: подпись ждёт, после truncated — до сыгранного места', () => {
    const cursor = speak()
    feed({ type: 'response.output_audio_transcript.done', response_id: 'r1', item_id: 'it1', transcript: line })
    expect(hostLines(cursor)).toEqual([])
    client.interruptSpeech('тест')
    // 90 мс/символ по умолчанию: 1800 мс ≈ 20 символов → «Вася, выбери ячейку».
    feed({ type: 'conversation.item.truncated', item_id: 'it1', content_index: 0, audio_end_ms: 1800 })
    expect(hostLines(cursor)).toEqual(['Вася, выбери ячейку…'])
  })

  it('порядок как в дампе 15.10: truncated раньше текста — обрезано так же', () => {
    const cursor = speak()
    client.interruptSpeech('тест')
    feed({ type: 'conversation.item.truncated', item_id: 'it1', content_index: 0, audio_end_ms: 2400 })
    feed({ type: 'response.done', response: { id: 'r1', status: 'cancelled', metadata: { purpose: 'clarify', turn: '1' }, output: [{ id: 'it1', type: 'message', role: 'assistant', content: [{ type: 'output_audio', transcript: line }] }] } })
    expect(hostLines(cursor)).toEqual(['Вася, выбери ячейку ещё…'])
  })

  it('оборвали на 60 мс (дамп: «Игорь, выберите я») — в чат ничего', () => {
    const cursor = speak()
    client.interruptSpeech('тест')
    feed({ type: 'conversation.item.truncated', item_id: 'it1', content_index: 0, audio_end_ms: 60 })
    feed({ type: 'response.done', response: { id: 'r1', status: 'cancelled', metadata: { purpose: 'clarify', turn: '1' }, output: [{ id: 'it1', type: 'message', role: 'assistant', content: [{ type: 'output_audio', transcript: 'Игорь, выберите я' }] }] } })
    expect(hostLines(cursor)).toEqual([])
  })

  it('truncated не пришёл — позиция по часам от начала звука', () => {
    const cursor = speak()
    feed({ type: 'response.output_audio_transcript.done', response_id: 'r1', item_id: 'it1', transcript: line })
    vi.advanceTimersByTime(1300)
    client.interruptSpeech('тест')
    expect(hostLines(cursor)).toEqual([])
    vi.advanceTimersByTime(2000)
    expect(hostLines(cursor)).toEqual(['Вася, выбери…'])
  })

  it('доиграла целиком — строка целиком, один раз', () => {
    const cursor = speak()
    feed({ type: 'response.output_audio_transcript.done', response_id: 'r1', item_id: 'it1', transcript: line })
    feed({ type: 'response.done', response: { id: 'r1', metadata: { purpose: 'clarify', turn: '1' }, output: [{ id: 'it1', type: 'message', role: 'assistant', content: [{ type: 'output_audio', transcript: line }] }] } })
    feed({ type: 'output_audio_buffer.stopped', response_id: 'r1' })
    expect(hostLines(cursor)).toEqual([line])
  })
})
