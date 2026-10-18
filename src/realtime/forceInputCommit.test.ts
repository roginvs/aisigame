import { describe, expect, it, vi, beforeAll } from 'vitest'
import { RealtimeClient } from './client.ts'

beforeAll(() => {
  vi.stubGlobal('Audio', class {
    pause(): void {}
    play(): Promise<void> {
      return Promise.resolve()
    }
  })
})


type OpenChannel = {
  dc: { readyState: string; onmessage: null; send: (data: string) => void }
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
    const { feed, client } = open()
    const stopped = vi.fn()
    client.onSpeechStopped = stopped
    client.forceInputCommit(1200)
    feed({ type: 'error', error: { code: 'input_audio_buffer_commit_empty', message: 'buffer empty' } })
    expect(stopped).not.toHaveBeenCalled()
    // После сброса можно коммитить заново (следующая реплика).
    const { sent } = open()
    void sent
    client.forceInputCommit(1200)
    expect(stopped).not.toHaveBeenCalled()
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
