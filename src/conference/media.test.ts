import { describe, expect, it } from 'vitest'
import {
  HOST_JITSI_NAME,
  SOUNDS_JITSI_NAME,
  isHostJitsiParticipant,
  isSoundsJitsiParticipant,
  modelHearsParticipant,
  resolveServiceIds,
} from './media.ts'

describe('служебные участники узнаются только по id', () => {
  it('«Ведущая» — по id соединения, с любым именем', () => {
    expect(isHostJitsiParticipant('bot-1', 'bot-1')).toBe(true)
    expect(isHostJitsiParticipant('p1', 'bot-1')).toBe(false)
  })

  it('без известного id никто не «Ведущая» и не «Звуки игры» (до первого снимка)', () => {
    expect(isHostJitsiParticipant('p1', null)).toBe(false)
    expect(isSoundsJitsiParticipant('p1', null)).toBe(false)
    expect(isHostJitsiParticipant('', null)).toBe(false)
    expect(isSoundsJitsiParticipant('', null)).toBe(false)
  })

  it('«Звуки игры» — по своему id и это не ведущая', () => {
    expect(isSoundsJitsiParticipant('snd', 'snd')).toBe(true)
    expect(isHostJitsiParticipant('snd', 'bot-1')).toBe(false)
  })

  it('имена «Ведущая»/«Звуки игры» в сигнатурах больше не участвуют', () => {
    // Функции принимают только id: имя игрока не может сделать его служебным.
    expect(isHostJitsiParticipant.length).toBe(2)
    expect(isSoundsJitsiParticipant.length).toBe(2)
    expect(modelHearsParticipant.length).toBe(2)
    expect(HOST_JITSI_NAME).toBe('Ведущая')
    expect(SOUNDS_JITSI_NAME).toBe('Звуки игры')
  })
})

describe('modelHearsParticipant', () => {
  const ids = { host: 'bot-2', sounds: 'snd' }
  it('не кладёт в микс модели «Ведущую» и «Звуки игры» по их id', () => {
    expect(modelHearsParticipant('bot-2', ids)).toBe(false)
    expect(modelHearsParticipant('snd', ids)).toBe(false)
  })
  it('игрок с любым именем (в т.ч. «Ведущая») слышен — его id не служебный', () => {
    expect(modelHearsParticipant('p-named-host', ids)).toBe(true)
    expect(modelHearsParticipant('p1', { host: null, sounds: null })).toBe(true)
  })
  it('после переподключения «Звуков игры» старый id снова обычный, новый — служебный', () => {
    const after = { host: 'bot-2', sounds: 'snd-2' }
    expect(modelHearsParticipant('snd', after)).toBe(true)
    expect(modelHearsParticipant('snd-2', after)).toBe(false)
  })
})

describe('resolveServiceIds', () => {
  it('у мастера свои соединения важнее снимка (снимок мог отстать)', () => {
    expect(resolveServiceIds({ host: 'bot', sounds: 'snd-new' }, { host: 'bot', sounds: 'snd-old' }))
      .toEqual({ host: 'bot', sounds: 'snd-new' })
  })
  it('у игрока своих нет — берём из снимка', () => {
    expect(resolveServiceIds({ host: null, sounds: null }, { host: 'bot', sounds: 'snd' }))
      .toEqual({ host: 'bot', sounds: 'snd' })
  })
  it('мастер без «Звуков игры» (переподключаются) — не берёт чужое из снимка, если его нет', () => {
    expect(resolveServiceIds({ host: 'bot', sounds: null }, { host: null, sounds: null }))
      .toEqual({ host: 'bot', sounds: null })
  })
})
