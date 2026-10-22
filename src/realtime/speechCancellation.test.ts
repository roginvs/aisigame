import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTrace } from '../debug/trace.ts'
import { RealtimeClient } from './client.ts'
import { outputFlushWaitMs } from './playback.ts'

class FakeAudio { autoplay = false; muted = false; srcObject = null; pause() {} }
type Harness = { dc: unknown; handleMessage(raw: string): void }
let client: RealtimeClient
let sent: Array<Record<string, unknown>>
let feed: (event: object) => void
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('window', globalThis); vi.stubGlobal('Audio', FakeAudio)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  client = new RealtimeClient()
  sent = []
  const opened = client as unknown as Harness
  opened.dc = { readyState: 'open', send: (raw: string) => sent.push(JSON.parse(raw)), onmessage: null }
  feed = (event) => opened.handleMessage(JSON.stringify(event))
})
afterEach(() => { client.stopSession(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('отмена приглашения отвечать: дамп 22 октября 19-25-27', () => {
  it.each([true, false])('поздние события приглашения не завершают вердикт (metadata=%s)', (marked) => {
    const cursor = getTrace().at(-1)?.id ?? 0
    const finished = vi.fn(); client.onAudioFinished = finished
    const link = vi.fn(); client.onLink = link
    client.requestSpeech('buzzCall', 3, 'Дай Васе слово', undefined, true)
    feed({ type: 'response.created', response: { id: 'buzz', ...(marked ? { metadata: { purpose: 'buzzCall', turn: '3' } } : {}) } })
    client.interruptSpeech('игрок заговорил на ответе')
    expect(sent.filter((event) => event.type === 'response.cancel')).toEqual([{ type: 'response.cancel', response_id: 'buzz' }])
    // Сервер ещё не подтвердил отмену; игрок уже ответил «Квадрат», оценка готова.
    client.requestSpeech('announce', 4, 'Верно, Вася, плюс 100', undefined, true)
    vi.advanceTimersByTime(outputFlushWaitMs)
    link.mockClear()
    feed({ type: 'output_audio_buffer.started', response_id: 'buzz' })
    feed({ type: 'response.output_item.added', response_id: 'buzz', item: { id: 'buzz-item' } })
    feed({ type: 'response.output_audio_transcript.done', response_id: 'buzz', item_id: 'buzz-item', transcript: 'Вася, говори.' })
    feed({ type: 'response.done', response: { id: 'buzz', ...(marked ? { metadata: { purpose: 'buzzCall', turn: '3' } } : {}), output: [
      { id: 'buzz-item', type: 'message', content: [{ type: 'output_audio', transcript: 'Вася, говори.' }] },
    ] } })
    feed({ type: 'output_audio_buffer.stopped', response_id: 'buzz' })
    expect(finished).not.toHaveBeenCalled()
    expect(link).not.toHaveBeenCalledWith({ host: 'speaking' })
    expect(getTrace().filter((event) => event.id > cursor && event.kind === 'chat' && event.title === 'Ведущая')).toHaveLength(0)
    feed({ type: 'response.created', response: { id: 'announce', ...(marked ? { metadata: { purpose: 'announce', turn: '4' } } : {}) } })
    feed({ type: 'output_audio_buffer.started', response_id: 'announce' })
    // Даже после начала вердикта старый stopped ничего не заканчивает.
    feed({ type: 'output_audio_buffer.stopped', response_id: 'buzz' })
    expect(finished).not.toHaveBeenCalled()
    feed({ type: 'response.done', response: { id: 'announce', output: [] } })
    feed({ type: 'output_audio_buffer.stopped', response_id: 'announce' })
    expect(finished.mock.calls).toEqual([[{ purpose: 'announce', turn: 4 }]])
  })

  it.each([true, false])('отменяет приглашение, чей created пришёл уже после обрыва (metadata=%s)', (marked) => {
    const finished = vi.fn(); client.onAudioFinished = finished
    client.requestSpeech('buzzCall', 3, 'Дай Васе слово', undefined, true)
    client.interruptSpeech('игрок заговорил до создания ответа')
    client.requestSpeech('announce', 4, 'Верно, Вася', undefined, true)
    vi.advanceTimersByTime(outputFlushWaitMs)
    feed({ type: 'response.created', response: { id: 'late-buzz', ...(marked ? { metadata: { purpose: 'buzzCall', turn: '3' } } : {}) } })
    expect(sent.at(-1)).toEqual({ type: 'response.cancel', response_id: 'late-buzz' })
    feed({ type: 'response.created', response: { id: 'announce', ...(marked ? { metadata: { purpose: 'announce', turn: '4' } } : {}) } })
    feed({ type: 'output_audio_buffer.started', response_id: 'announce' })
    feed({ type: 'output_audio_buffer.stopped', response_id: 'late-buzz' })
    expect(finished).not.toHaveBeenCalled()
    feed({ type: 'output_audio_buffer.stopped', response_id: 'announce' })
    expect(finished.mock.calls).toEqual([[{ purpose: 'announce', turn: 4 }]])
  })
})
