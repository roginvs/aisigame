import { describe, expect, it } from 'vitest'
import { HOST_JITSI_NAME, isHostJitsiParticipant } from './media.ts'

describe('isHostJitsiParticipant', () => {
  it('recognizes the bot by id even with another display name', () => {
    expect(isHostJitsiParticipant('bot-1', 'Other', 'bot-1')).toBe(true)
  })

  it('recognizes the fixed host display name for joiners', () => {
    expect(isHostJitsiParticipant('remote-9', HOST_JITSI_NAME, null)).toBe(true)
  })

  it('leaves ordinary players alone', () => {
    expect(isHostJitsiParticipant('p1', 'Вася', null)).toBe(false)
    expect(isHostJitsiParticipant('p1', 'Вася', 'bot-1')).toBe(false)
  })
})
