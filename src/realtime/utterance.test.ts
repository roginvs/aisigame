import { describe, expect, it } from 'vitest'
import { transcriptionConfidence, transcriptOf, type StoredTranscript } from './utterance.ts'

describe('transcriptOf', () => {
  it('берёт только расшифровку этой реплики', () => {
    const stored = new Map<string, StoredTranscript>([
      ['older', { text: 'Hallo, rikis', confidence: null }],
      ['current', { text: 'Реки — сто.', confidence: 0.8 }],
    ])
    expect(transcriptOf('current', stored)).toEqual({ text: 'Реки — сто.', arrived: true, confidence: 0.8 })
    expect(transcriptOf('missing', stored)).toBeNull()
  })
})

describe('transcriptionConfidence', () => {
  it('берёт самую низкую вероятность слова и пропускает пробел', () => {
    const confidence = transcriptionConfidence([
      { token: 'Нов', logprob: Math.log(0.2) },
      { token: ' ', logprob: 0 },
      { token: 'оселов', logprob: Math.log(0.5) },
    ])
    expect(confidence).toBeCloseTo(0.2)
  })

  it('возвращает null, если уверенности нет', () => {
    expect(transcriptionConfidence(undefined)).toBeNull()
    expect(transcriptionConfidence([])).toBeNull()
    expect(transcriptionConfidence([{ token: '.', logprob: -0.1 }])).toBeNull()
  })
})
