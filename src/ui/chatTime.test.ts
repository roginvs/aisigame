import { describe, expect, it } from 'vitest'
import { formatChatTime } from './chatTime.ts'

describe('formatChatTime', () => {
  it('форматирует ISO до секунд', () => {
    const text = formatChatTime('2026-10-12T19:15:03.123Z')
    expect(text).toMatch(/^\d{2}:\d{2}:\d{2}$/)
    // Та же секунда в локальной зоне: минуты/секунды из UTC+смещение.
    expect(text.endsWith(':03')).toBe(true)
  })

  it('пустой или битый штамп — пустая строка', () => {
    expect(formatChatTime(undefined)).toBe('')
    expect(formatChatTime('')).toBe('')
    expect(formatChatTime('не время')).toBe('')
  })
})
