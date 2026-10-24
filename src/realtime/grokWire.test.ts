import { describe, expect, it } from 'vitest'
import { freshGrokTurn, grokInbound, grokOutbound, keyterms } from './grokWire.ts'
import { pcmToBase64 } from './pcm.ts'

describe('grok wire', () => {
  it('переводит сессию и не шлёт сброс выходного буфера', () => {
    const update = grokOutbound({
      type: 'session.update',
      session: {
        instructions: 'Будь ведущей',
        tools: [{ type: 'function', name: 'selectQuestion' }],
        audio: { output: { speed: 1.25 }, input: { transcription: { prompt: 'Реки 100 Космос' } } },
      },
    })
    expect(update).toMatchObject({
      type: 'session.update',
      session: {
        instructions: 'Будь ведущей',
        voice: 'eve',
        turn_detection: { type: 'server_vad' },
        audio: {
          input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { language_hint: 'ru' } },
          output: { format: { type: 'audio/pcm', rate: 24000 }, speed: 1.25 },
        },
      },
    })
    expect(grokOutbound({ type: 'output_audio_buffer.clear' })).toBe('clear-output')
    expect(grokOutbound({ type: 'response.cancel' })).toEqual({ type: 'response.cancel' })
    expect(grokOutbound({ type: 'input_audio_buffer.commit' })).toEqual({ type: 'input_audio_buffer.commit' })
    expect(grokOutbound({ type: 'input_audio_buffer.clear' })).toEqual({ type: 'input_audio_buffer.clear' })
    expect(keyterms('Реки, реки 100')).toEqual(['Реки', '100'])
  })

  it('собирает расшифровку к концу реплики и не дублирует вызов функции', () => {
    let turn = freshGrokTurn()
    const started = grokInbound({ type: 'input_audio_buffer.speech_started', item_id: 'u1' }, turn)
    turn = started.turn
    const updated = grokInbound(
      { type: 'conversation.item.input_audio_transcription.updated', item_id: 'u1', transcript: 'Август' },
      turn,
    )
    turn = updated.turn
    // Промежуточный текст — черновик для чата (delta с полным transcript).
    expect(updated.events).toEqual([{ type: 'conversation.item.input_audio_transcription.delta', item_id: 'u1', transcript: 'Август' }])
    const stopped = grokInbound({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' }, turn)
    expect(stopped.events[1]).toMatchObject({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'Август',
    })

    const pcm = pcmToBase64(Int16Array.from([1, -1]))
    const audio = grokInbound({ type: 'response.output_audio.delta', delta: pcm, response_id: 'r1' }, turn)
    expect(audio.audio).toBeInstanceOf(Int16Array)
    expect(audio.events).toEqual([])

    const call = grokInbound(
      { type: 'response.function_call_arguments.done', name: 'selectQuestion', call_id: 'c1', arguments: '{"value":100}' },
      freshGrokTurn(),
    )
    expect(call.events[0]).toMatchObject({
      type: 'response.done',
      response: { output: [{ type: 'function_call', call_id: 'c1' }] },
    })
    const again = grokInbound(
      {
        type: 'response.done',
        response: { id: 'r1', output: [{ type: 'function_call', name: 'selectQuestion', call_id: 'c1', arguments: '{}' }] },
      },
      call.turn,
    )
    expect(asOutput(again.events[0]!)).toEqual([])
  })
})

function asOutput(event: object): unknown[] {
  const response = (event as { response?: { output?: unknown[] } }).response
  return response?.output ?? []
}

describe('grok: пустая подсказка распознавателю', () => {
  it('очищает keyterms, а не оставляет прошлые', () => {
    const events = grokOutbound({ type: 'session.update', session: { type: 'realtime', audio: { input: { transcription: { prompt: '' } } } } } as never)
    expect(JSON.stringify(events)).toContain('"keyterms":[]')
  })
})
