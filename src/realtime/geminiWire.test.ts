import { describe, expect, it } from 'vitest'
import { absorbTranscript, geminiSetup, responseCue } from './geminiWire.ts'

describe('gemini wire', () => {
  it('собирает setup живой модели и отдельно модель с рассуждением', () => {
    const live = geminiSetup('gemini-3.8-live', false) as {
      setup: {
        model: string
        generationConfig: { thinkingConfig?: unknown }
        tools: Array<{ functionDeclarations: Array<{ behavior?: string }> }>
        contextWindowCompression: { slidingWindow: Record<string, unknown> }
        sessionResumption: { handle?: string }
      }
    }
    expect(live.setup.model).toBe('models/gemini-3.8-live')
    expect(live.setup.generationConfig.thinkingConfig).toBeUndefined()
    expect(live.setup.tools[0]?.functionDeclarations[0]?.behavior).toBeUndefined()
    // Длинная партия: сжатие контекста включено, сервер присылает токены восстановления.
    expect(live.setup.contextWindowCompression).toEqual({ slidingWindow: {} })
    expect(live.setup.sessionResumption).toEqual({})

    const thinking = geminiSetup('gemini-3.8-live-extended-thinking', true) as typeof live
    expect(thinking.setup.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' })
    expect(thinking.setup.tools[0]?.functionDeclarations.every((item) => item.behavior === 'NON_BLOCKING')).toBe(true)

    const resumed = geminiSetup('gemini-3.8-live', false, { resumptionHandle: 'tok-1' }) as typeof live
    expect(resumed.setup.sessionResumption).toEqual({ handle: 'tok-1' })
  })

  it('достаёт текст реплики и имя функции из response.create', () => {
    expect(absorbTranscript('Ав', 'Август')).toBe('Август')
    expect(absorbTranscript('Август', 'Август')).toBe('Август')
    const cue = responseCue({
      type: 'response.create',
      response: {
        tool_choice: { type: 'function', name: 'submitAnswerJudgment' },
        instructions: 'Оцени реплику',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Август' }] }],
      },
    })
    expect(cue).toEqual({ text: 'Оцени реплику\nАвгуст', tool: 'submitAnswerJudgment' })
  })
})
