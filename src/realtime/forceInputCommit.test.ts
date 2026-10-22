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
    expect(stopped).toHaveBeenCalledWith({ durationMs: 1400, itemId: 'item-9' })
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
    expect(stopped).toHaveBeenCalledWith({ durationMs: 1400, itemId: 'q1' })
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
    expect(stopped).toHaveBeenCalledExactlyOnceWith({ durationMs: 1600, itemId: 'new' })
  })

  it('закрытие сессии снимает незавершённый commit перед новым подключением', () => {
    const { client } = open()
    client.forceInputCommit(1400)
    client.stopSession()
    harness(client).dc = { readyState: 'open', onmessage: null, send: () => {} }
    expect(client.forceInputCommit(1600)).toBe(true)
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
