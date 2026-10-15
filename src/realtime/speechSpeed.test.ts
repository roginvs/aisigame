import { describe, expect, it } from 'vitest'
import { gameConfig } from '../config.ts'
import { geminiTempoRule, hostSpeechSpeed } from '../options.ts'
import { geminiSetup } from './geminiWire.ts'

describe('темп речи ведущей', () => {
  it('после приветствия — hostSpeechSpeed (в диапазоне OpenAI 0.25–1.5)', () => {
    expect(hostSpeechSpeed).toBe(1.2)
    expect(gameConfig.speechSpeed).toBe(hostSpeechSpeed)
    expect(hostSpeechSpeed).toBeGreaterThanOrEqual(0.25)
    expect(hostSpeechSpeed).toBeLessThanOrEqual(1.5)
  })
  it('Gemini без параметра скорости: просьба о темпе в systemInstruction', () => {
    const setup = geminiSetup('gemini-3.8-live', false) as { setup: { systemInstruction: { parts: Array<{ text: string }> } } }
    expect(setup.setup.systemInstruction.parts[0]!.text).toContain(geminiTempoRule)
  })
})
