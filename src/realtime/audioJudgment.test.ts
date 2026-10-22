import { toolTurnInput } from './speechMatch.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTrace } from '../debug/trace.ts'
import { RealtimeClient } from './client.ts'
import type { JudgeRequestContext } from './judgmentRequest.ts'
import { audioJudgmentCapable, judgmentModeFromUrl } from './judgmentRequest.ts'
class FakeAudio { autoplay = false; muted = false; srcObject = null; pause() {} }
type Harness = { dc: unknown; handleMessage(raw: string): void }

let client: RealtimeClient
let send: ReturnType<typeof vi.fn>
let feed: (event: object) => void
function request(role: 'primary' | 'shadow' = 'primary'): JudgeRequestContext {
  return { requestId: role, role, turn: 2, questionId: 'q', playerId: 1, attemptId: 4, audio: client.audioReference('a') }
}
function ready() {
  feed({ type: 'input_audio_buffer.speech_stopped', item_id: 'a' })
  feed({ type: 'input_audio_buffer.committed', item_id: 'a' })
}
function done(role: string, heard = 'Белая гвардия') {
  feed({ type: 'response.done', response: { id: `resp-${role}`, status: 'completed', metadata: { requestId: role, source: 'audio' },
    output: [{ type: 'function_call', name: 'submitAnswerJudgment', call_id: 'c', arguments: JSON.stringify({ questionId: 'q', playerId: 1, attemptId: 4, status: 'correct', heard, reason: 'Верно' }) }] } })
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('window', globalThis); vi.stubGlobal('Audio', FakeAudio)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  client = new RealtimeClient()
  send = vi.fn()
  const opened = client as unknown as Harness
  opened.dc = { readyState: 'open', send, onmessage: null }
  feed = (event) => opened.handleMessage(JSON.stringify(event))
})
afterEach(() => { client.stopSession(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('native audio dispatcher', () => {
  it('отмена речи по id не отменяет параллельную аудиооценку', async () => {
    ready()
    const primary = client.requestAudioJudgment(request(), 'question + answers')
    feed({ type: 'response.created', response: { id: 'resp-primary', metadata: { requestId: 'primary' } } })
    client.requestSpeech('buzzCall', 3, 'Вася, говори', undefined, true)
    feed({ type: 'response.created', response: { id: 'buzz', metadata: { purpose: 'buzzCall', turn: '3' } } })
    client.interruptSpeech('игрок отвечает')
    expect(send.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .filter((event) => event.type === 'response.cancel')).toEqual([{ type: 'response.cancel', response_id: 'buzz' }])
    done('primary')
    expect((await primary).name).toBe('submitAnswerJudgment')
  })

  it('sends only question context plus the ready audio reference and one tool', async () => {
    ready()
    const primary = client.requestAudioJudgment(request(), 'question + answers')
    const payload = JSON.parse(send.mock.calls.at(-1)![0])
    expect(payload.event_id).toBe('primary')
    expect(payload.response.conversation).toBe('none')
    expect(payload.response.output_modalities).toEqual(['text'])
    expect(payload.response.tools.map((tool: { name: string }) => tool.name)).toEqual(['submitAnswerJudgment'])
    expect(payload.response.tools[0].parameters.properties.playerId).toBeUndefined()
    expect(payload.response.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: toolTurnInput('submitAnswerJudgment') }] },
      { type: 'item_reference', id: 'a' },
    ])
    expect(payload.response.instructions).toContain('question + answers')
    const generic = vi.fn(); client.onToolCall = generic
    done('primary'); done('primary')
    expect((await primary).name).toBe('submitAnswerJudgment')
    expect(generic).not.toHaveBeenCalled()
  })
  it('never cancels or rewrites host speech for shadow response events', async () => {
    ready()
    client.requestSpeech('welcome', 99, 'host')
    feed({ type: 'response.created', response: { id: 'host', metadata: { purpose: 'welcome', turn: '99' } } })
    const finished = vi.fn(); client.onAudioFinished = finished
    send.mockClear()
    const shadow = client.requestAudioJudgment(request('shadow'), 'q')
    feed({ type: 'response.created', response: { id: 'resp-shadow', metadata: { requestId: 'shadow' } } })
    feed({ type: 'response.output_text.done', response_id: 'resp-shadow', text: 'must not be host chat' })
    done('shadow'); await shadow
    expect(send.mock.calls.map(([raw]) => JSON.parse(raw).type)).toEqual(['response.create'])
    feed({ type: 'output_audio_buffer.started', response_id: 'host' })
    feed({ type: 'output_audio_buffer.stopped', response_id: 'host' })
    expect(finished).toHaveBeenCalledExactlyOnceWith({ purpose: 'welcome', turn: 99 })
    expect(getTrace().some((entry) => entry.kind === 'chat' && JSON.stringify(entry.detail).includes('must not be host chat'))).toBe(false)
  })
  it('cancels by response id even when created arrives after local cancellation', async () => {
    ready()
    const abort = new AbortController()
    const rejected = client.requestAudioJudgment(request(), 'q', abort.signal).catch((e: Error) => e.message)
    abort.abort()
    expect(await rejected).toBe('cancelled')
    feed({ type: 'response.created', response: { id: 'resp-primary', metadata: { requestId: 'primary' } } })
    expect(JSON.parse(send.mock.calls.at(-1)![0])).toEqual({ type: 'response.cancel', response_id: 'resp-primary' })
    const generic = vi.fn(); client.onToolCall = generic
    done('primary')
    expect(generic).not.toHaveBeenCalled()
  })
  it('attributes API errors only to the originating request', async () => {
    ready()
    const primary = client.requestAudioJudgment(request(), 'q').catch((e: Error) => e.message)
    const shadow = client.requestAudioJudgment(request('shadow'), 'q')
    feed({ type: 'error', error: { event_id: 'primary', message: 'unsupported reference' } })
    expect(await primary).toBe('unsupported reference')
    done('shadow'); expect((await shadow).name).toBe('submitAnswerJudgment')
  })
  it('publishes audio heard once and ignores delayed ASR after ungating', () => {
    client.gatePlayerChat(true)
    client.suppressPlayerChat('a')
    client.publishAudioPlayerChat('a', 'пылесосел')
    client.gatePlayerChat(false)
    feed({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'пылесос и осел' })
    const lines = getTrace().filter((entry) => entry.title === 'Игрок' && entry.kind === 'chat').map((entry) => (entry.detail as { text: string }).text)
    expect(lines.at(-1)).toBe('пылесосел')
    expect(lines).not.toContain('пылесос и осел')
  })
  it('rejects absent audio and never advertises unknown providers/models', async () => {
    await expect(client.requestAudioJudgment(request(), 'q')).rejects.toThrow('audio-item-not-ready')
    for (const model of ['grok-voice-latest', 'gemini-3.8-live', 'unknown', 'gpt-realtime-future']) expect(audioJudgmentCapable(model)).toBe(false)
    expect(new RealtimeClient({ model: 'grok-voice-latest' }).judgmentCapabilities().isolatedAudioReference).toBe(false)
    expect(judgmentModeFromUrl('https://example.test/?judge=audio')).toBe('audio')
    expect(judgmentModeFromUrl('https://example.test/?judge=shadow')).toBe('shadow')
    expect(judgmentModeFromUrl('https://example.test/?judge=typo')).toBe('text')
  })
})

it('defaults to new audio and respects a saved rollback and explicit URL', async () => {
  const { judgmentModeStorageKey, writeJudgmentMode } = await import('./judgmentRequest.ts')
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  expect(judgmentModeFromUrl('https://example.test/', 'gpt-realtime-2.1-mini', storage)).toBe('audio')
  writeJudgmentMode('text', storage)
  expect(values.get(judgmentModeStorageKey)).toBe('text')
  expect(judgmentModeFromUrl('https://example.test/', 'gpt-realtime-2.1', storage)).toBe('text')
  expect(judgmentModeFromUrl('https://example.test/?judge=audio', 'gpt-realtime-2.1-mini', storage)).toBe('audio')
  writeJudgmentMode('audio', storage)
  expect(judgmentModeFromUrl('https://example.test/', 'gpt-realtime-2.1-mini', storage)).toBe('audio')
})
