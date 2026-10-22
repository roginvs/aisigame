import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealtimeClient } from './client.ts'

class FakeAudio { pause() {} }
type Harness = { handleMessage(raw: string): void }
let client: RealtimeClient
let feed: (event: object) => void

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('Audio', FakeAudio)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  client = new RealtimeClient()
  feed = (event) => (client as unknown as Harness).handleMessage(JSON.stringify(event))
})
afterEach(() => { client.stopSession(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function transcript(itemId: string, text: string) {
  feed({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript: text })
}

describe('расшифровка принадлежит только явно указанной реплике и сессии', () => {
  it('без id не возвращает уже завершённый ответ и не ждёт следующий', async () => {
    feed({ type: 'input_audio_buffer.speech_started', item_id: 'old' })
    feed({ type: 'input_audio_buffer.speech_stopped', item_id: 'old' })
    transcript('old', 'старый ответ')
    const result = client.waitForTranscript(null, 100)
    transcript('next', 'следующий ответ')
    expect(await result).toEqual({ text: '', arrived: false, confidence: null })
  })

  it('без id не заимствует текущую незавершённую реплику', async () => {
    feed({ type: 'input_audio_buffer.speech_started', item_id: 'live' })
    const result = client.waitForTranscript(null, 100)
    transcript('live', 'это другая реплика')
    expect(await result).toEqual({ text: '', arrived: false, confidence: null })
  })

  it('по id дожидается своей расшифровки, даже когда уже началась следующая речь', async () => {
    const result = client.waitForTranscript('wanted', 100)
    let resolved = false
    void result.then(() => { resolved = true })
    feed({ type: 'input_audio_buffer.speech_started', item_id: 'other' })
    transcript('other', 'чужой ответ')
    await Promise.resolve()
    expect(resolved).toBe(false)
    transcript('wanted', 'нужный ответ')
    expect(await result).toEqual({ text: 'нужный ответ', arrived: true, confidence: null })
  })

  it('ожидание старой сессии не возвращает текст новой с тем же id', async () => {
    const result = client.waitForTranscript('same', 100)
    client.stopSession()
    transcript('same', 'новая сессия')
    await vi.advanceTimersByTimeAsync(100)
    expect(await result).toEqual({ text: '', arrived: false, confidence: null })
    expect(await client.waitForTranscript('same', 100)).toMatchObject({ text: 'новая сессия', arrived: true })
  })
})
