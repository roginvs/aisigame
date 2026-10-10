import { describe, expect, it, beforeEach } from 'vitest'
import { billedTokens, estimateUsd, formatTokens, formatUsd, getUsageSnapshot, recordResponseUsage, resetUsage } from './usage.ts'

const sample = {
  id: 'resp_1',
  usage: {
    total_tokens: 973,
    input_tokens: 657,
    output_tokens: 316,
    input_token_details: {
      text_tokens: 657,
      audio_tokens: 0,
      image_tokens: 0,
      cached_tokens: 0,
      cached_tokens_details: { text_tokens: 0, audio_tokens: 0, image_tokens: 0 },
    },
    output_token_details: { text_tokens: 98, audio_tokens: 218, reasoning_tokens: 33 },
  },
}

describe('usage', () => {
  beforeEach(() => resetUsage())

  it('складывает usage из response.done и не считает ответ дважды', () => {
    recordResponseUsage(sample)
    recordResponseUsage(sample)
    const { totals, usd } = getUsageSnapshot()
    expect(totals.responses).toBe(1)
    expect(totals.textIn).toBe(657)
    expect(totals.textOut).toBe(98)
    expect(totals.audioOut).toBe(218)
    expect(billedTokens(totals)).toBe(657 + 98 + 218)
    expect(usd).toBeCloseTo((657 * 0.6 + 98 * 2.4 + 218 * 20) / 1_000_000, 8)
    expect(formatUsd(usd)).toBe('≈ $0.0050')
  })

  it('кэш считает дешевле свежих токенов', () => {
    const usd = estimateUsd({
      responses: 1,
      textIn: 1000,
      cachedTextIn: 400,
      textOut: 0,
      audioIn: 1000,
      cachedAudioIn: 800,
      audioOut: 0,
      imageIn: 0,
      cachedImageIn: 0,
    })
    expect(usd).toBeCloseTo((600 * 0.6 + 400 * 0.06 + 200 * 10 + 800 * 0.3) / 1_000_000, 8)
  })

  it('сокращает токены через K и M', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(973)).toBe('973')
    expect(formatTokens(1500)).toBe('1.5K')
    expect(formatTokens(12400)).toBe('12.4K')
    expect(formatTokens(120000)).toBe('120K')
    expect(formatTokens(1_240_000)).toBe('1.2M')
    expect(formatTokens(12_000_000)).toBe('12M')
  })

  it('без детализации берёт общие input и output как текст', () => {
    recordResponseUsage({ id: 'resp_plain', usage: { input_tokens: 100, output_tokens: 20 } })
    const { totals } = getUsageSnapshot()
    expect(totals.textIn).toBe(100)
    expect(totals.textOut).toBe(20)
  })
})
