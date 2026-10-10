import { describe, expect, it } from 'vitest'
import { hostSpeaking, hostTitle, linkLive, linkTitle, micLive, micTitle } from './airStatus.ts'

describe('airStatus', () => {
  it('names a live session with short hover text', () => {
    expect(linkTitle('connected')).toBe('на связи')
    expect(linkLive('connected')).toBe(true)
    expect(micTitle('live')).toBe('микрофон открыт')
    expect(micLive('live')).toBe(true)
    expect(hostTitle('speaking')).toBe('ведущая говорит')
    expect(hostSpeaking('speaking')).toBe(true)
  })

  it('marks a dropped, stopped, or still-connecting link as down', () => {
    expect(linkLive('idle')).toBe(false)
    expect(linkLive('connecting')).toBe(false)
    expect(linkLive('error')).toBe(false)
    expect(linkTitle('idle')).toBe('нет связи')
    expect(linkTitle('connecting')).toBe('подключение')
    expect(linkTitle('error')).toBe('связь прервалась')
    expect(micTitle('muted')).toBe('микрофон выключен')
    expect(micTitle('idle')).toBe('микрофон выключен')
    expect(micLive('muted')).toBe(false)
    expect(hostTitle('idle')).toBe('ведущая молчит')
    expect(hostSpeaking('idle')).toBe(false)
  })
})
