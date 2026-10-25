import { describe, expect, it } from 'vitest'
import { freshGrokTurn, grokFunctionTool, grokInbound, grokOutbound, grokReleaseDraft, keyterms } from './grokWire.ts'
import { selectQuestionTool, submitAnswerJudgmentTool } from './tools.ts'
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

describe('grok: финальная расшифровка и инструменты', () => {
  it('нарастающие completed не запирают первый черновик; поздняя правка после финала не уходит', () => {
    let turn = freshGrokTurn()
    const started = grokInbound({ type: 'input_audio_buffer.speech_started', item_id: 'd2' }, turn)
    turn = started.turn
    const early = grokInbound(
      { type: 'conversation.item.input_audio_transcription.completed', item_id: 'd2', transcript: 'Text', status: 'in_progress' },
      turn,
    )
    turn = early.turn
    expect(early.events).toEqual([{ type: 'conversation.item.input_audio_transcription.delta', item_id: 'd2', transcript: 'Text' }])
    const stopped = grokInbound({ type: 'input_audio_buffer.speech_stopped', item_id: 'd2', audio_end_ms: 33041 }, turn)
    turn = stopped.turn
    expect(stopped.holdDraft).toBe(true)
    expect(stopped.events.some((event) => (event as { type?: string }).type?.endsWith('completed'))).toBe(false)
    const grown = grokInbound(
      { type: 'conversation.item.input_audio_transcription.completed', item_id: 'd2', transcript: 'Текст 100.', status: 'in_progress' },
      turn,
    )
    turn = grown.turn
    expect(grown.events[0]).toMatchObject({ type: 'conversation.item.input_audio_transcription.delta', transcript: 'Текст 100.' })
    const final = grokInbound(
      { type: 'conversation.item.input_audio_transcription.completed', item_id: 'd2', transcript: 'Текст 100.', status: 'completed' },
      turn,
    )
    expect(final.events).toEqual([
      { type: 'conversation.item.input_audio_transcription.completed', item_id: 'd2', transcript: 'Текст 100.', status: 'completed' },
    ])
    const late = grokInbound(
      { type: 'conversation.item.input_audio_transcription.completed', item_id: 'd2', transcript: 'Текст 100. лишнее', status: 'completed' },
      final.turn,
    )
    expect(late.events).toEqual([])
  })

  it('без финала после конца речи черновик можно отдать один раз', () => {
    let turn = freshGrokTurn()
    turn = grokInbound({ type: 'input_audio_buffer.speech_started', item_id: 'u' }, turn).turn
    turn = grokInbound(
      { type: 'conversation.item.input_audio_transcription.completed', item_id: 'u', transcript: 'Текст 100.', status: 'in_progress' },
      turn,
    ).turn
    turn = grokInbound({ type: 'input_audio_buffer.speech_stopped', item_id: 'u' }, turn).turn
    const released = grokReleaseDraft(turn)
    expect(released.event).toMatchObject({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Текст 100.' })
    expect(grokReleaseDraft(released.turn).event).toBeNull()
  })

  it('response.create вкладывает function, session и function_call_output не выдумывают полей', () => {
    const created = grokOutbound({
      type: 'response.create',
      response: {
        max_output_tokens: 800,
        tool_choice: { type: 'function', name: 'submitAnswerJudgment' },
        tools: [selectQuestionTool, submitAnswerJudgmentTool, { type: 'web_search' }],
      },
    }) as { response: { max_output_tokens?: unknown; tool_choice: unknown; tools: unknown[] } }
    expect(created.response.max_output_tokens).toBeUndefined()
    expect(created.response.tool_choice).toEqual({ type: 'function', name: 'submitAnswerJudgment' })
    expect(created.response.tools[0]).toEqual({
      type: 'function',
      function: {
        name: selectQuestionTool.name,
        description: selectQuestionTool.description,
        parameters: selectQuestionTool.parameters,
      },
    })
    expect(created.response.tools[1]).toMatchObject({
      type: 'function',
      function: { name: 'submitAnswerJudgment' },
    })
    expect(created.response.tools[2]).toEqual({ type: 'web_search' })
    const nested = grokFunctionTool({ type: 'function', function: { name: 'selectQuestion', description: 'уже' } })
    expect(nested).toEqual({ type: 'function', function: { name: 'selectQuestion', description: 'уже' } })
    const output = {
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: 'c1', output: '{"accepted":true}' },
    }
    expect(grokOutbound(output)).toEqual(output)
    const call = grokInbound(
      { type: 'response.function_call_arguments.done', name: 'submitAnswerJudgment', call_id: 'c1', arguments: '{"status":"correct"}' },
      freshGrokTurn(),
    )
    expect(call.events[0]).toMatchObject({
      type: 'response.done',
      response: { output: [{ type: 'function_call', name: 'submitAnswerJudgment', call_id: 'c1', arguments: '{"status":"correct"}' }] },
    })
  })
})

describe('grok: пустая подсказка распознавателю', () => {
  it('очищает keyterms, а не оставляет прошлые', () => {
    const events = grokOutbound({ type: 'session.update', session: { type: 'realtime', audio: { input: { transcription: { prompt: '' } } } } } as never)
    expect(JSON.stringify(events)).toContain('"keyterms":[]')
  })
})
