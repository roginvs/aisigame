import { describe, expect, it, beforeEach } from 'vitest'
import {
  PRESENCE_HIDE_MS,
  PRESENCE_STALE_MS,
  applyPresence,
  clearRememberedPlayersForTests,
  lookupRememberedPlayer,
  mergeReturningPlayer,
  rememberPlayer,
} from './presence.ts'
import { ConferenceRoster } from './roster.ts'

beforeEach(() => {
  clearRememberedPlayersForTests()
})

describe('applyPresence', () => {
  const base = {
    clientId: 'c1',
    name: 'Вася',
    score: 100,
    playerId: 1,
  }

  it('свежий игрок не серый и не скрыт', () => {
    const now = 1_000_000
    const [view] = applyPresence([{ ...base, lastSeen: now }], now)
    expect(view?.stale).toBe(false)
    expect(view?.hidden).toBe(false)
  })

  it('10 секунд — stale, меньше минуты — ещё виден', () => {
    const now = 100_000
    const [view] = applyPresence([{ ...base, lastSeen: now - PRESENCE_STALE_MS }], now)
    expect(view?.stale).toBe(true)
    expect(view?.hidden).toBe(false)
  })

  it('минута — hidden', () => {
    const now = 200_000
    const [view] = applyPresence([{ ...base, lastSeen: now - PRESENCE_HIDE_MS }], now)
    expect(view?.hidden).toBe(true)
  })
})

describe('rememberPlayer / returning', () => {
  it('тот же clientId сохраняет playerId и счёт', () => {
    rememberPlayer({ clientId: 'c1', playerId: 2, score: 300, name: 'Маша' })
    const now = 50_000
    const back = mergeReturningPlayer('c1', 'Маша', now)
    expect(back).toEqual({ playerId: 2, score: 300, name: 'Маша', lastSeen: now })
    const [view] = applyPresence(
      [{ clientId: 'c1', name: 'Маша', score: 300, playerId: 2, lastSeen: now }],
      now,
    )
    expect(view?.hidden).toBe(false)
  })

  it('восстанавливает clientId, playerId и резервирует новые id после максимального', () => {
    const roster = new ConferenceRoster('master-client', 'Новый мастер')
    roster.restorePlayers([
      { id: 1, name: 'Мастер', score: 700, clientId: 'master-client' },
      { id: 4, name: 'Маша', score: 300, clientId: 'returning-client' },
    ])

    const returning = roster.upsertHello('returning-client', 'Маша')
    expect(returning.playerId).toBe(4)
    expect(lookupRememberedPlayer('returning-client')).toMatchObject({ playerId: 4, score: 300 })

    roster.upsertHello('new-client', 'Новый игрок')
    expect(roster.assignPlayerId('new-client')).toBe(5)
  })
})
