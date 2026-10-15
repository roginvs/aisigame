import { describe, expect, it } from 'vitest'
import { HOST_JITSI_NAME, isHostJitsiParticipant, modelHearsParticipant } from './media.ts'

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

import { SOUNDS_JITSI_NAME, isSoundsJitsiParticipant, isHostJitsiParticipant as isHostForSounds } from './media.ts'

describe('участник «Звуки игры»', () => {
  it('узнаётся по id своего бота и по имени у остальных, и это не ведущая', () => {
    expect(isSoundsJitsiParticipant('abc', 'Маша', 'abc')).toBe(true)
    expect(isSoundsJitsiParticipant('x', SOUNDS_JITSI_NAME, null)).toBe(true)
    expect(isSoundsJitsiParticipant('x', 'Маша', null)).toBe(false)
    expect(isHostForSounds('x', SOUNDS_JITSI_NAME, null)).toBe(false)
  })
})

describe('modelHearsParticipant', () => {
  const ids = { bot: 'bot-2', sounds: 'snd' }
  it('не кладёт в микс модели «Ведущую» прошлой сессии (другой id, то же имя)', () => {
    expect(modelHearsParticipant('bot-1', HOST_JITSI_NAME, ids)).toBe(false)
    expect(modelHearsParticipant('bot-2', '', ids)).toBe(false)
    expect(modelHearsParticipant('x', SOUNDS_JITSI_NAME, ids)).toBe(false)
  })
  it('людей кладёт', () => {
    expect(modelHearsParticipant('p1', 'Маша', ids)).toBe(true)
  })
})
