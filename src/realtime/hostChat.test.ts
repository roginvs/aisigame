import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTrace, subscribeChatEdits, type ChatLineEdit } from '../debug/trace.ts'
import { RealtimeClient } from './client.ts'
import twoItems from './fixtures/clarify-two-items.json'
import { qwenTranslateInbound } from './qwenWire.ts'

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
  it('Qwen: transcript.done и response.done одной реплики не дублируют строку', () => {
    const cursor = getTrace().at(-1)?.id ?? 0
    client.requestSpeech('clarify', 1, 'Попроси выбрать ещё раз.')
    feed({ type: 'response.created', response: { id: 'r1' } })
    feed(qwenTranslateInbound({ type: 'response.audio_transcript.done', response_id: 'r1', item_id: 'm1', transcript: 'Выберите вопрос.' })!)
    feed({ type: 'response.done', response: { id: 'r1', output: [{ id: 'm1', type: 'message', content: [{ type: 'audio', transcript: 'Выберите вопрос.' }] }] } })
    const host = getTrace().filter((e) => e.id > cursor && e.kind === 'chat' && e.title === 'Ведущая')
    expect(host).toHaveLength(1)
  })

  it('ответ из двух сказанных реплик (живая игра 14.10, 20:40:11): обе в чате ровно по разу', () => {
    const cursor = getTrace().at(-1)?.id ?? 0
    client.requestSpeech('clarify', 28, 'Попроси выбрать ещё раз.')
    for (const event of twoItems) feed(event)
    const host = getTrace().filter((e) => e.id > cursor && e.kind === 'chat' && e.title === 'Ведущая').map((e) => (e.detail as { text: string }).text)
    expect(host).toEqual([
      'Хорошо, давайте уточним выбор, чтобы не пропускать снова.',
      'Вася, выбери ячейку ещё раз, пожалуйста.',
    ])
  })
})

describe('чат ведущей: реплику оборвали мы — строка правится до прозвучавшего и «…»', () => {
  const line = 'Вася, выбери ячейку ещё раз, пожалуйста, тему и стоимость.'
  const hostLines = (cursor: number) => getTrace()
    .filter((e) => e.id > cursor && e.kind === 'chat' && e.title === 'Ведущая' && !(e.detail as { removed?: boolean }).removed)
    .map((e) => (e.detail as { text: string }).text)
  const cutNotes = (cursor: number) => getTrace().filter((e) => e.id > cursor && e.kind === 'note' && e.title.startsWith('реплика ведущей оборвана'))
  function speak() {
    const cursor = getTrace().at(-1)?.id ?? 0
    client.requestSpeech('clarify', 1, 'Попроси выбрать ещё раз.')
    feed({ type: 'response.created', response: { id: 'r1' } })
    feed({ type: 'response.output_item.added', response_id: 'r1', item: { id: 'it1', type: 'message', role: 'assistant' } })
    feed({ type: 'output_audio_buffer.started', response_id: 'r1' })
    return cursor
  }

  it('текст сразу в чате; после нашего обрыва и truncated — та же строка обрезана', () => {
    const edits: ChatLineEdit[] = []
    const off = subscribeChatEdits((edit) => edits.push(edit))
    const cursor = speak()
    feed({ type: 'response.output_audio_transcript.done', response_id: 'r1', item_id: 'it1', transcript: line })
    expect(hostLines(cursor)).toEqual([line])
    client.interruptSpeech('тест')
    // 90 мс/символ по умолчанию: 1800 мс ≈ 20 символов → «Вася, выбери ячейку».
    feed({ type: 'conversation.item.truncated', item_id: 'it1', content_index: 0, audio_end_ms: 1800 })
    expect(hostLines(cursor)).toEqual(['Вася, выбери ячейку…'])
    expect(edits).toHaveLength(1)
    expect(edits[0]?.text).toBe('Вася, выбери ячейку…')
    const [note] = cutNotes(cursor)
    expect(note?.title).toBe('реплика ведущей оборвана (оборвали мы: тест) на 1800 мс [audio_end_ms]; в чате: «Вася, выбери ячейку…»')
    expect(note?.detail).toMatchObject({ full: line, playedMs: 1800, source: 'audio_end_ms', shown: 'Вася, выбери ячейку…' })
    off()
  })

  it('порядок как в дампе 15.10: truncated раньше текста — сразу обрезанная строка', () => {
    const cursor = speak()
    client.interruptSpeech('тест')
    feed({ type: 'conversation.item.truncated', item_id: 'it1', content_index: 0, audio_end_ms: 2400 })
    feed({ type: 'response.done', response: { id: 'r1', status: 'cancelled', metadata: { purpose: 'clarify', turn: '1' }, output: [{ id: 'it1', type: 'message', role: 'assistant', content: [{ type: 'output_audio', transcript: line }] }] } })
    expect(hostLines(cursor)).toEqual(['Вася, выбери ячейку ещё…'])
    expect(cutNotes(cursor)[0]?.detail).toMatchObject({ full: line, playedMs: 2400, source: 'audio_end_ms' })
  })

  it('оборвали на 60 мс (дамп: «Игорь, выберите я») — строка убирается', () => {
    const edits: ChatLineEdit[] = []
    const off = subscribeChatEdits((edit) => edits.push(edit))
    const cursor = speak()
    feed({ type: 'response.output_audio_transcript.done', response_id: 'r1', item_id: 'it1', transcript: 'Игорь, выберите вопрос на табло.' })
    client.interruptSpeech('тест')
    feed({ type: 'conversation.item.truncated', item_id: 'it1', content_index: 0, audio_end_ms: 60 })
    expect(hostLines(cursor)).toEqual([])
    expect(edits.at(-1)?.text).toBeNull()
    expect(cutNotes(cursor)[0]?.title).toMatch(/на 60 мс \[audio_end_ms\]; в чате: строка убрана$/)
    off()
  })

  it('truncated не пришёл — позиция по часам от начала звука', () => {
    const cursor = speak()
    feed({ type: 'response.output_audio_transcript.done', response_id: 'r1', item_id: 'it1', transcript: line })
    vi.advanceTimersByTime(1300)
    client.interruptSpeech('тест')
    expect(hostLines(cursor)).toEqual([line])
    vi.advanceTimersByTime(2000)
    expect(hostLines(cursor)).toEqual(['Вася, выбери…'])
    expect(cutNotes(cursor)[0]?.title).toBe('реплика ведущей оборвана (оборвали мы: тест) на 1300 мс [оценка по часам]; в чате: «Вася, выбери…»')
  })

  it('доиграла целиком — строка не правится', () => {
    const edits: ChatLineEdit[] = []
    const off = subscribeChatEdits((edit) => edits.push(edit))
    const cursor = speak()
    feed({ type: 'response.output_audio_transcript.done', response_id: 'r1', item_id: 'it1', transcript: 'Доиграла до конца эту реплику.' })
    feed({ type: 'response.done', response: { id: 'r1', metadata: { purpose: 'clarify', turn: '1' }, output: [{ id: 'it1', type: 'message', role: 'assistant', content: [{ type: 'output_audio', transcript: 'Доиграла до конца эту реплику.' }] }] } })
    feed({ type: 'output_audio_buffer.stopped', response_id: 'r1' })
    expect(hostLines(cursor)).toEqual(['Доиграла до конца эту реплику.'])
    expect(edits).toEqual([])
    off()
  })
})
