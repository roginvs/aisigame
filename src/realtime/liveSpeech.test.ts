import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLivePlayerLine, getTrace } from '../debug/trace.ts'
import { RealtimeClient } from './client.ts'
import { MockRealtimeClient } from './mockClient.ts'
import { throttleLatest } from './liveSpeech.ts'

class FakeAudio { autoplay = false; muted = false; srcObject = null; pause() {} }
type Harness = { dc: unknown; handleMessage(raw: string): void }
let client: RealtimeClient
let feed: (event: object) => void
const delta = (item_id: string, d: string) => feed({ type: 'conversation.item.input_audio_transcription.delta', item_id, delta: d })
const playerLines = () => getTrace().filter((e) => e.kind === 'chat' && e.title === 'Игрок').map((e) => (e.detail as { text: string }).text)

beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('window', globalThis); vi.stubGlobal('Audio', FakeAudio)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  client = new RealtimeClient()
  const opened = client as unknown as Harness
  opened.dc = { readyState: 'open', send: vi.fn(), onmessage: null }
  feed = (event) => opened.handleMessage(JSON.stringify(event))
})
afterEach(() => { client.stopSession(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('черновик речи игрока', () => {
  it('растёт по delta и заменяется итогом', () => {
    delta('i1', 'Бел'); expect(getLivePlayerLine()?.text).toBe('Бел')
    delta('i1', 'ая гвардия'); expect(getLivePlayerLine()).toMatchObject({ itemId: 'i1', text: 'Белая гвардия' })
    expect(playerLines()).not.toContain('Белая гвардия')
    feed({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'Белая гвардия.' })
    expect(getLivePlayerLine()).toBeNull()
    expect(playerLines().at(-1)).toBe('Белая гвардия.')
  })
  it('полный transcript (Grok/Gemini) заменяет, а не дописывает', () => {
    feed({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'g', transcript: 'Авг' })
    feed({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'g', transcript: 'Август' })
    expect(getLivePlayerLine()?.text).toBe('Август')
  })
  it('failed убирает черновик', () => {
    delta('f', 'шум')
    feed({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'f', error: { message: 'x' } })
    expect(getLivePlayerLine()).toBeNull()
  })
  it('suppress и gate не показывают черновик', () => {
    client.suppressPlayerChat('s'); delta('s', 'тихо')
    expect(getLivePlayerLine()).toBeNull()
    client.gatePlayerChat(true); delta('g2', 'ждём')
    expect(getLivePlayerLine()).toBeNull()
    client.allowPlayerChat('g2'); delta('g2', ' да')
    expect(getLivePlayerLine()?.text).toBe('ждём да')
    client.suppressPlayerChat('g2'); expect(getLivePlayerLine()).toBeNull()
  })
  it('delta не даёт транскрипт игре', async () => {
    delta('w', 'Пушкин')
    const result = client.waitForTranscript('w', 100)
    vi.advanceTimersByTime(150)
    expect((await result).arrived).toBe(false)
  })
})

describe('мок: hearLive', () => {
  it('показывает растущий текст, потом итог', () => {
    const mock = new MockRealtimeClient()
    mock.hearLive('Белая гвардия Булгакова', 100)
    vi.advanceTimersByTime(0); expect(getLivePlayerLine()?.text).toBe('Белая')
    vi.advanceTimersByTime(100); expect(getLivePlayerLine()?.text).toBe('Белая гвардия')
    vi.advanceTimersByTime(200)
    expect(getLivePlayerLine()).toBeNull()
    expect(playerLines().at(-1)).toBe('Белая гвардия Булгакова')
    mock.stopSession()
  })
})

describe('throttleLatest', () => {
  it('первое сразу, промежуточные схлопываются, немедленное — сразу', () => {
    const sent: number[] = []
    const t = throttleLatest<number>(250, (v) => sent.push(v))
    t.push(1); t.push(2); t.push(3)
    expect(sent).toEqual([1])
    vi.advanceTimersByTime(250); expect(sent).toEqual([1, 3])
    t.push(4); t.push(5, true); expect(sent).toEqual([1, 3, 5])
    vi.advanceTimersByTime(500); expect(sent).toEqual([1, 3, 5])
  })
})
