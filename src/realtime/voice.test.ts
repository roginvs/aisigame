import { describe, expect, it, vi } from 'vitest'
import { RealtimeClient } from './client.ts'
import { MockRealtimeClient } from './mockClient.ts'
import type { ToolCall } from './client.ts'
import { createVoice } from './voice.ts'

describe('createVoice', () => {
  it('отдаёт мок и живые модели через один вход', () => {
    vi.stubGlobal(
      'Audio',
      class {
        src = ''
        pause(): void {}
        load(): void {}
        play(): Promise<void> {
          return Promise.resolve()
        }
      },
    )
    expect(createVoice('mock')).toBeInstanceOf(MockRealtimeClient)
    const mini = createVoice('gpt-realtime-2.1-mini')
    const full = createVoice('gpt-realtime-2.1')
    const grok = createVoice('grok-voice-latest')
    const gemini = createVoice('gemini-3.8-live-extended-thinking')
    expect(mini).toBeInstanceOf(RealtimeClient)
    expect(full).toBeInstanceOf(RealtimeClient)
    expect(grok).toBeInstanceOf(RealtimeClient)
    expect(gemini).toBeInstanceOf(RealtimeClient)
    expect((full as RealtimeClient).model).toBe('gpt-realtime-2.1')
    expect((grok as RealtimeClient).model).toBe('grok-voice-latest')
    expect((gemini as RealtimeClient).model).toBe('gemini-3.8-live-extended-thinking')
  })
})

describe('mock judgment', () => {
  it('просит уточнить созвучие и засчитывает эталон', async () => {
    vi.useFakeTimers()
    const client = new MockRealtimeClient()
    const calls: ToolCall[] = []
    client.onToolCall = (call) => {
      if (call) calls.push(call)
    }
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout })
    client.requestTool('judge', 1, 'submitAnswerJudgment', judgment('Читов', 'Герман Титов'))
    client.requestTool('judge', 2, 'submitAnswerJudgment', judgment('Август', 'Октавиан Август; Август'))
    client.requestTool(
      'judge',
      3,
      'submitAnswerJudgment',
      `${judgment('Звёздные войны', 'D')}\nЧто появилось раньше?\nD. Звёздные войны`,
    )
    await vi.advanceTimersByTimeAsync(50)
    expect(calls.map((call) => (call.arguments as { status: string }).status)).toEqual([
      'needs_clarification',
      'correct',
      'correct',
    ])
    vi.useRealTimers()
  })
})

function judgment(heard: string, answers: string): string {
  return `questionId: q1\nplayerId: 1\nattemptId: 1\nРеплика игрока: «${heard}»\nЭталон, с которым нужно сравнить смысл: ${answers}`
}
