import { describe, expect, it } from 'vitest'
import { isConferenceMessage } from './messages.ts'

describe('isConferenceMessage', () => {
  it('принимает только структурно полное hello', () => {
    expect(
      isConferenceMessage({ type: 'hello', clientId: 'client', authToken: 'secret', name: 'Игрок' }),
    ).toBe(true)
    expect(isConferenceMessage({ type: 'hello', clientId: 'client', name: 'Игрок' })).toBe(false)
    expect(isConferenceMessage({ type: 'hello', clientId: {}, authToken: 'secret', name: 'Игрок' })).toBe(false)
  })

  it('отбрасывает неизвестные, чрезмерные и неполные сообщения', () => {
    expect(isConferenceMessage({ type: 'destroyEverything' })).toBe(false)
    expect(
      isConferenceMessage({
        type: 'chat',
        clientId: 'client',
        authToken: 'secret',
        text: 'x'.repeat(4_001),
      }),
    ).toBe(false)
    expect(isConferenceMessage({ type: 'snapshot', authorityToken: 'master', phase: 'lobby' })).toBe(false)
    expect(
      isConferenceMessage({
        type: 'packOffer',
        authorityToken: 'master',
        hash: 'hash',
        size: 121 * 1024 * 1024,
        name: 'слишком большой',
        summary: '',
      }),
    ).toBe(false)
  })

  it('принимает packOffer и snapshot с commit и без него', () => {
    expect(
      isConferenceMessage({
        type: 'packOffer',
        authorityToken: 'master',
        commit: 'abc1234',
        hash: 'hash',
        size: 10,
        name: 'Пакет',
        summary: '',
      }),
    ).toBe(true)
    expect(
      isConferenceMessage({
        type: 'packOffer',
        authorityToken: 'master',
        hash: 'hash',
        size: 10,
        name: 'Пакет',
        summary: '',
      }),
    ).toBe(true)
  })

  it('проверяет отдельное подтверждение сверки пакета', () => {
    expect(
      isConferenceMessage({
        type: 'packVerified',
        clientId: 'client',
        authToken: 'secret',
        hash: 'sha256',
      }),
    ).toBe(true)
    expect(isConferenceMessage({ type: 'packVerified', clientId: 'client', authToken: 'secret' })).toBe(false)
  })

  it('проверяет статус загрузки/сверки клиента и оставляет ready отдельным действием', () => {
    const message = { type: 'packStatus', clientId: 'client', authToken: 'secret', hash: 'sha256', percent: 99, packPhase: 'verifying' }
    expect(isConferenceMessage(message)).toBe(true)
    expect(isConferenceMessage({ ...message, percent: -1 })).toBe(false)
    expect(isConferenceMessage({ ...message, percent: 100 })).toBe(false)
    expect(isConferenceMessage({ ...message, packPhase: 'ready' })).toBe(false)
    expect(isConferenceMessage({ ...message, hash: '' })).toBe(false)
  })

  it('принимает только ограниченный debug-батч игрока', () => {
    expect(
      isConferenceMessage({
        type: 'debugLog',
        clientId: 'client',
        authToken: 'secret',
        entries: [{ at: new Date().toISOString(), kind: 'note', title: 'ошибка камеры' }],
      }),
    ).toBe(true)
    expect(
      isConferenceMessage({
        type: 'debugLog',
        clientId: 'client',
        authToken: 'secret',
        entries: [{ at: 'now', kind: 'unknown', title: 'подмена' }],
      }),
    ).toBe(false)
    expect(
      isConferenceMessage({
        type: 'debugLog',
        clientId: 'client',
        authToken: 'secret',
        entries: Array.from({ length: 25 }, () => ({ at: 'now', kind: 'note', title: 'x' })),
      }),
    ).toBe(false)
  })
})
