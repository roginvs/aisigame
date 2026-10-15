import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTrace } from '../debug/trace.ts'
import { RealtimeClient } from './client.ts'

class FakeAudio { autoplay = false; muted = false; srcObject = null; pause() {} }
type Harness = { dc: unknown; wireOpen: boolean; handleMessage(raw: string): void }

const question = 'У цветковых растений мужские половые клетки сами никуда не идут – их несут эти мелкие зёрна: на лапках пчелы, на ветру или прямо в нос аллергику.'

let client: RealtimeClient
let feed: (event: object) => void
let sent: Array<Record<string, unknown>>
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('window', globalThis); vi.stubGlobal('Audio', FakeAudio)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  client = new RealtimeClient()
  sent = []
  const opened = client as unknown as Harness
  opened.dc = { readyState: 'open', send: vi.fn((raw: string) => sent.push(JSON.parse(raw))), onmessage: null }
  opened.wireOpen = true
  feed = (event) => opened.handleMessage(JSON.stringify(event))
})
afterEach(() => { client.stopSession(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('дословное чтение вопроса (живая игра 15.10, 22:25:18)', () => {
  it('точно прочитанный вопрос не перезапускается и не обрывается', async () => {
    const cursor = getTrace().at(-1)?.id ?? 0
    const finished: string[] = []
    client.onAudioFinished = ({ purpose }) => finished.push(purpose)
    client.requestSpeech('read', 63, question, question)
    await vi.advanceTimersByTimeAsync(500)
    const r = 'resp_1'
    const item = { id: 'item_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_audio', transcript: question }] }
    feed({ type: 'response.created', response: { id: r, status: 'in_progress', output: [], metadata: { purpose: 'read', turn: '63', take: '1' } } })
    feed({ type: 'output_audio_buffer.started', response_id: r })
    feed({ type: 'response.output_audio_transcript.delta', response_id: r, delta: question })
    feed({ type: 'response.output_audio_transcript.done', response_id: r, item_id: 'item_1', transcript: question })
    feed({ type: 'response.done', response: { id: r, status: 'completed', output: [item], metadata: { purpose: 'read', turn: '63', take: '1' } } })
    const notes = getTrace().filter((e) => e.id > cursor).map((e) => e.title)
    expect(notes.some((n) => n.startsWith('не та фраза'))).toBe(false)
    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(1)
    expect(sent.some((e) => e.type === 'output_audio_buffer.clear' || e.type === 'response.cancel')).toBe(false)
    feed({ type: 'output_audio_buffer.stopped', response_id: r })
    await vi.advanceTimersByTimeAsync(3000)
    expect(finished).toEqual(['read'])
  })
  it('повтор после не той фразы: расшифровка первого дубля не засчитывается как «продолжила»', async () => {
    const cursor = getTrace().at(-1)?.id ?? 0
    client.requestSpeech('read', 64, question, question)
    await vi.advanceTimersByTimeAsync(500)
    const wrong = 'Отличный выбор, слушаем вопрос.'
    const meta = { purpose: 'read', turn: '64' }
    feed({ type: 'response.created', response: { id: 'r1', status: 'in_progress', output: [], metadata: meta } })
    feed({ type: 'response.output_audio_transcript.delta', response_id: 'r1', delta: question })
    feed({ type: 'response.done', response: { id: 'r1', status: 'completed', metadata: meta, output: [{ id: 'i1', type: 'message', content: [{ type: 'output_audio', transcript: wrong }] }] } })
    await vi.advanceTimersByTimeAsync(3000)
    feed({ type: 'response.created', response: { id: 'r2', status: 'in_progress', output: [], metadata: meta } })
    feed({ type: 'response.output_audio_transcript.delta', response_id: 'r2', delta: 'У цветковых растений мужские' })
    const notes = getTrace().filter((e) => e.id > cursor).map((e) => e.title)
    expect(notes.some((n) => n.startsWith('не та фраза'))).toBe(true)
    expect(notes.some((n) => n.startsWith('ведущая продолжила'))).toBe(false)
  })
})
