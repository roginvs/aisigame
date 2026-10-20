import { describe, expect, it } from 'vitest'
import { hostInstructions } from '../config.ts'
import { sessionTools } from './tools.ts'
import {
  qwenSessionBody,
  qwenSdpUrl,
  qwenTool,
  qwenTranslateInbound,
  qwenTranslateOutbound,
  qwenVoice,
  qwenTranscriptionModel,
} from './qwenWire.ts'

describe('qwen wire: исходящие', () => {
  it('место сессии: OpenAI-тело уходит в форму DashScope целиком', () => {
    const { events } = qwenTranslateOutbound({
      type: 'session.update',
      session: {
        instructions: 'Будь ведущей',
        output_modalities: ['audio'],
        audio: { output: { voice: 'marin' } },
        tools: sessionTools,
      },
    })
    expect(events).toHaveLength(1)
    const session = (events[0] as { session: Record<string, unknown> }).session
    expect(session).toMatchObject({
      modalities: ['text', 'audio'],
      voice: qwenVoice,
      instructions: 'Будь ведущей',
      input_audio_format: 'pcm',
      output_audio_format: 'pcm',
      input_audio_transcription: { model: qwenTranscriptionModel },
      turn_detection: { type: 'semantic_vad', create_response: false, interrupt_response: false },
    })
    const tools = session.tools as { type: string; function: { name: string } }[]
    expect(tools).toHaveLength(sessionTools.length)
    const select = tools.find((tool) => tool.function.name === 'selectQuestion')
    expect(select?.type).toBe('function')
    expect('output_modalities' in session).toBe(false)
    expect('audio' in session).toBe(false)
    expect('tool_choice' in session).toBe(false)
  })

  it('без доп. полей turn_detection, если сервер их отверг', () => {
    const body = qwenSessionBody({ vadExtras: false })
    expect(body.turn_detection).toEqual({ type: 'semantic_vad' })
  })

  it('инструменты переносятся во вложенный function', () => {
    const tool = qwenTool({
      type: 'function',
      name: 'selectQuestion',
      description: 'Передаёт игре тему и номинал.',
      parameters: { type: 'object' },
    })
    expect(tool).toEqual({
      type: 'function',
      function: { name: 'selectQuestion', description: 'Передаёт игре тему и номинал.', parameters: { type: 'object' } },
    })
  })

  it('реплика-подсказка: реплика хода отдельным сообщением, инструкции хода в сессию, затем голый response.create', () => {
    const { events, drop } = qwenTranslateOutbound({
      type: 'response.create',
      response: {
        instructions: 'Говори по-русски коротко',
        output_modalities: ['audio'],
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Привет, Вася' }] }],
        tool_choice: 'none',
      },
    })
    expect(drop).toBeFalsy()
    expect(events).toHaveLength(3)
    const [item, update, create] = events as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>]
    expect(item.type).toBe('conversation.item.create')
    expect(item.item).toEqual({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Привет, Вася' }] })
    const session = update.session as Record<string, unknown>
    expect(session.instructions).toBe('Говори по-русски коротко')
    expect(session.modalities).toEqual(['text', 'audio'])
    expect(create).toEqual({ type: 'response.create' })
  })

  it('оценка ходом-функцией: только текст, инструмент указан заранее одной схемой', () => {
    const { events } = qwenTranslateOutbound({
      type: 'response.create',
      response: {
        conversation: 'none',
        output_modalities: ['text'],
        tool_choice: { type: 'function', name: 'submitAnswerJudgment' },
        tools: [{ type: 'function', name: 'submitAnswerJudgment', description: 'оценка', parameters: {} }],
        instructions: 'Оцени попытку',
      },
    })
    expect(events).toHaveLength(2)
    const update = events[0] as { session: Record<string, unknown> }
    expect(update.session.modalities).toEqual(['text'])
    const tools = update.session.tools as { function: { name: string } }[]
    expect(tools.map((tool) => tool.function.name)).toEqual(['submitAnswerJudgment'])
    expect(events[1]).toEqual({ type: 'response.create' })
  })

  it('голый response.create без инструкций ведёт базовые правила ведущей', () => {
    const { events } = qwenTranslateOutbound({ type: 'response.create' })
    const update = events[0] as { session: Record<string, unknown> }
    expect(update.session.instructions).toBe(hostInstructions)
    expect(update.session.modalities).toEqual(['text', 'audio'])
  })

  it('отмена сужается без response_id, буфер чистится локально, неизвестное отбрасывается', () => {
    expect(qwenTranslateOutbound({ type: 'response.cancel', response_id: 'resp-1' }).events).toEqual([
      { type: 'response.cancel' },
    ])
    const clear = qwenTranslateOutbound({ type: 'output_audio_buffer.clear' })
    expect(clear.clearOutput).toBe(true)
    expect(clear.events).toEqual([])
    expect(qwenTranslateOutbound({ type: 'snow.deep', deep: true }).drop).toBe(true)
    expect(qwenTranslateOutbound({ type: 'input_audio_buffer.clear' }).events).toEqual([{ type: 'input_audio_buffer.clear' }])
    expect(qwenTranslateOutbound({ type: 'input_audio_buffer.commit' }).events).toEqual([{ type: 'input_audio_buffer.commit' }])
  })

  it('выдача инструмента уходит как есть, сообщение-итог — нет', () => {
    const output = {
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: 'call_1', output: '{"ok":1}' },
    }
    expect(qwenTranslateOutbound(output).events).toEqual([output])
    const stray = { type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [] } }
    expect(qwenTranslateOutbound(stray).drop).toBe(true)
  })

  it('адрес SDP-обмена собирается из workspace-хоста и модели', () => {
    expect(qwenSdpUrl('ws-1.cn-beijing.maas.aliyuncs.com', 'qwen3.8-omni-flash-realtime')).toBe(
      'https://ws-1.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.8-omni-flash-realtime',
    )
    expect(qwenSdpUrl('https://ws-2.ap-southeast-1.maas.aliyuncs.com/', 'qwen3.8-omni-flash-realtime')).toBe(
      'https://ws-2.ap-southeast-1.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.8-omni-flash-realtime',
    )
  })
})

describe('qwen wire: входящие', () => {
  it('расшифровка с окном text+stash становится полем transcript целиком', () => {
    expect(
      qwenTranslateInbound({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'item_1',
        text: 'Солнце и ',
        stash: 'Луна',
      }),
    ).toEqual({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_1', transcript: 'Солнце и Луна' })
    expect(
      qwenTranslateInbound({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_1', transcript: 'Солнце' }),
    ).toEqual({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_1', transcript: 'Солнце' })
  })

  it('реплики ведущей переименовываются в OpenAI-обытия', () => {
    expect(
      qwenTranslateInbound({ type: 'response.audio_transcript.delta', response_id: 'resp_1', delta: 'Вопрос ' }),
    ).toEqual({ type: 'response.output_audio_transcript.delta', response_id: 'resp_1', delta: 'Вопрос ' })
    expect(
      qwenTranslateInbound({ type: 'response.audio_transcript.done', response_id: 'resp_1', transcript: 'Вопрос целиком' }),
    ).toEqual({ type: 'response.output_audio_transcript.done', response_id: 'resp_1', transcript: 'Вопрос целиком' })
    expect(qwenTranslateInbound({ type: 'response.text.done', response_id: 'resp_1', text: 'Итог' })).toEqual({
      type: 'response.output_text.done',
      response_id: 'resp_1',
      text: 'Итог',
    })
  })

  it('куски звука и MCP-события игре не нужны, прочие проходят как есть', () => {
    expect(qwenTranslateInbound({ type: 'response.audio.delta', delta: 'aGk=' })).toBeNull()
    expect(qwenTranslateInbound({ type: 'response.audio.done' })).toBeNull()
    expect(qwenTranslateInbound({ type: 'mcp_list_tools_changed' })).toBeNull()
    expect(qwenTranslateInbound({ type: 'response.mcp_call_arguments.done' })).toBeNull()
    const vad = { type: 'input_audio_buffer.speech_started', audio_start_ms: 10, item_id: 'item_2' }
    expect(qwenTranslateInbound(vad)).toEqual(vad)
    const tool = { type: 'response.function_call_arguments.done', response_id: 'r', call_id: 'c', name: 'selectQuestion', arguments: '{}' }
    expect(qwenTranslateInbound(tool)).toEqual(tool)
    const done = {
      type: 'response.done',
      response: { id: 'r', status: 'completed', usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } },
    }
    expect(qwenTranslateInbound(done)).toEqual(done)
  })
})
