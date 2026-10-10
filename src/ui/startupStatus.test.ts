import { describe, expect, it } from 'vitest'
import { startupStatus } from './startupStatus.ts'

describe('startupStatus', () => {
  it('names the microphone request before the WebRTC handshake', () => {
    expect(startupStatus({ mic: 'requesting' })).toBe('Открываем микрофон')
    expect(startupStatus({ mic: 'muted' })).toBe('Подключаемся')
    expect(startupStatus({ mic: 'idle' })).toBe('Подключаемся')
  })
})
