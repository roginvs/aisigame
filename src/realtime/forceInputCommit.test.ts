import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { RealtimeClient } from './client.ts'
import type { VoiceWire } from './wire.ts'

beforeAll(() => {
  vi.stubGlobal('Audio', class {
    pause(): void {}
    play(): Promise<void> {
      return Promise.resolve()
    }
  })
})
afterAll(() => vi.unstubAllGlobals())


type OpenChannel = {
  dc: { readyState: string; onmessage: null; send: (data: string) => void }
  wireOpen: boolean
  handleMessage(raw: string): void
}

function harness(client: RealtimeClient): OpenChannel {
  return client as unknown as OpenChannel
}

function open() {
  const sent: string[] = []
  const client = new RealtimeClient()
  const opened = harness(client)
  opened.dc = {
    readyState: 'open',
    onmessage: null,
    send(data: string) {
      const event = JSON.parse(data) as { type?: string }
      if (event.type) sent.push(event.type)
    },
  }
  return { sent, feed: (event: object) => opened.handleMessage(JSON.stringify(event)), client }
}

describe('запасной commit: модель молчит, коммитим буфер сами (fa584db п. 1)', () => {
  it('шлёт input_audio_buffer.commit, по committed отдаёт синтетический конец речи', () => {
    const { sent, feed, client } = open()
    const stopped = vi.fn()
    client.onSpeechStopped = stopped
    client.forceInputCommit(1400)
    expect(sent).toContain('input_audio_buffer.commit')
    // Реплика ещё не коммитилась — события конца нет.
    expect(stopped).not.toHaveBeenCalled()
    feed({ type: 'input_audio_buffer.committed', item_id: 'item-9' })
    expect(stopped).toHaveBeenCalledTimes(1)
    expect(stopped).toHaveBeenCalledWith({ durationMs: 1400, itemId: 'item-9', forced: true })
    // Обычный коммит серверной VAD (не наш) ничего не синтезирует.
    feed({ type: 'input_audio_buffer.committed', item_id: 'item-10' })
    expect(stopped).toHaveBeenCalledTimes(1)
  })

  it('ошибка пустого буфера глушится: синтетического конца речи нет', () => {
    const { sent, feed, client } = open()
    const stopped = vi.fn()
    client.onSpeechStopped = stopped
    client.forceInputCommit(1200)
    feed({ type: 'error', error: { code: 'input_audio_buffer_commit_empty', message: 'buffer empty' } })
    expect(stopped).not.toHaveBeenCalled()
    // После сброса можно коммитить заново (следующая реплика).
    expect(client.forceInputCommit(1200)).toBe(true)
    expect(sent.filter((type) => type === 'input_audio_buffer.commit')).toHaveLength(2)
    expect(stopped).not.toHaveBeenCalled()
  })

  it('Qwen явно поддерживает commit: событие проходит через провод, committed завершает реплику', () => {
    const send = vi.fn(() => true)
    const wire: VoiceWire = {
      supportsInputCommit: true,
      open: async () => {}, send, close: () => {}, setMicEnabled: () => {}, setOutputMuted: () => {},
      attachHostOutput: () => {}, setInputStream: () => {},
    }
    const client = new RealtimeClient({ wire })
    harness(client).wireOpen = true
    const stopped = vi.fn()
    client.onSpeechStopped = stopped
    expect(client.forceInputCommit(1400)).toBe(true)
    expect(send).toHaveBeenCalledWith({ type: 'input_audio_buffer.commit' })
    harness(client).handleMessage(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'q1' }))
    expect(stopped).toHaveBeenCalledWith({ durationMs: 1400, itemId: 'q1', forced: true })
  })

  it('сброс аудиобуфера снимает ожидание commit: поздний committed не становится ответом', () => {
    const { feed, client } = open()
    const stopped = vi.fn()
    client.onSpeechStopped = stopped
    client.forceInputCommit(1400)
    client.discardInputAudio()
    feed({ type: 'input_audio_buffer.committed', item_id: 'old' })
    expect(stopped).not.toHaveBeenCalled()
    expect(client.forceInputCommit(1600)).toBe(true)
    feed({ type: 'input_audio_buffer.committed', item_id: 'new' })
    expect(stopped).toHaveBeenCalledExactlyOnceWith({ durationMs: 1600, itemId: 'new', forced: true })
  })

  it('закрытие сессии снимает незавершённый commit перед новым подключением', () => {
    const { client } = open()
    client.forceInputCommit(1400)
    client.stopSession()
    harness(client).dc = { readyState: 'open', onmessage: null, send: () => {} }
    expect(client.forceInputCommit(1600)).toBe(true)
  })

  it('включение микрофона не сбрасывает уже открытую реплику, ни в проводе, ни в WebRTC', () => {
    const sent: string[] = []
    const wire: VoiceWire = {
      supportsInputCommit: true,
      open: async () => {},
      send(event: object) {
        const type = (event as { type?: string }).type
        if (type) sent.push(type)
        return true
      },
      close: () => {},
      setMicEnabled: () => {},
      setOutputMuted: () => {},
      attachHostOutput: () => {},
      setInputStream: () => {},
    }
    const client = new RealtimeClient({ wire })
    harness(client).wireOpen = true
    const clears = () => sent.filter((type) => type === 'input_audio_buffer.clear').length
    client.setMicEnabled(true)
    expect(clears()).toBe(1)
    harness(client).handleMessage(JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: 'open-1' }))
    client.setMicEnabled(false)
    client.setMicEnabled(true)
    expect(clears()).toBe(1)
    harness(client).handleMessage(JSON.stringify({ type: 'input_audio_buffer.speech_stopped', item_id: 'open-1', audio_end_ms: 800 }))
    client.setMicEnabled(false)
    client.setMicEnabled(true)
    expect(clears()).toBe(2)
    client.forceInputCommit(1400)
    client.setMicEnabled(false)
    client.setMicEnabled(true)
    expect(clears()).toBe(2)
    client.discardInputAudio()
    expect(clears()).toBe(3)

    const web: string[] = []
    const webClient = new RealtimeClient()
    const opened = harness(webClient)
    const track = { enabled: false, kind: 'audio' }
    opened.dc = {
      readyState: 'open',
      onmessage: null,
      send(data: string) {
        const event = JSON.parse(data) as { type?: string }
        if (event.type) web.push(event.type)
      },
    }
    const bits = webClient as unknown as {
      mic: { getAudioTracks(): Array<{ enabled: boolean }> }
      pc: { getSenders(): Array<{ track: { kind: string; enabled: boolean } | null }> }
    }
    bits.mic = { getAudioTracks: () => [track] }
    bits.pc = { getSenders: () => [{ track }] }
    const webClears = () => web.filter((type) => type === 'input_audio_buffer.clear').length
    webClient.setMicEnabled(true)
    expect(webClears()).toBe(1)
    opened.handleMessage(JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: 'open-2' }))
    webClient.setMicEnabled(false)
    webClient.setMicEnabled(true)
    expect(webClears()).toBe(1)
    opened.handleMessage(JSON.stringify({ type: 'input_audio_buffer.speech_stopped', item_id: 'open-2', audio_end_ms: 800 }))
    webClient.setMicEnabled(false)
    webClient.setMicEnabled(true)
    expect(webClears()).toBe(2)
  })

  it('провод провайдера (Grok/Gemini) коммит не шлёт — реплика остаётся на его VAD', () => {
    const sent: string[] = []
    const wire = {
      setMicEnabled: () => {},
      setTranscriptionPrompt: () => {},
    } as never
    const client = new RealtimeClient({ model: 'grok-voice-latest', wire })
    const opened = harness(client)
    opened.dc = {
      readyState: 'open',
      onmessage: null,
      send(data: string) {
        const event = JSON.parse(data) as { type?: string }
        if (event.type) sent.push(event.type)
      },
    }
    const stopped = vi.fn()
    client.onSpeechStopped = stopped
    client.forceInputCommit(1400)
    expect(sent).not.toContain('input_audio_buffer.commit')
    expect(stopped).not.toHaveBeenCalled()
  })
})
