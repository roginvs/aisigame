import { describe, expect, it } from 'vitest'
import type { Player } from '../game/types.ts'
import { canBuzzPlayer, canPickCell } from './conferenceTurn.ts'

const players: Player[] = [
  { id: 1, name: 'Аня', score: 0, clientId: 'client-a' },
  { id: 2, name: 'Борис', score: 0, clientId: 'client-b' },
]

describe('canPickCell', () => {
  it('keeps the shared board available in table mode', () => {
    expect(canPickCell('choosing.listening', false, undefined, 2, players)).toBe(true)
  })

  it('allows the assigned chooser in conference mode', () => {
    expect(canPickCell('choosing.listening', true, 'client-b', 2, players)).toBe(true)
  })

  it('blocks another conference participant', () => {
    expect(canPickCell('choosing.listening', true, 'client-a', 2, players)).toBe(false)
  })

  it('blocks selection outside the choosing phase', () => {
    expect(canPickCell('buzzing.open', true, 'client-b', 2, players)).toBe(false)
  })

  it('fails closed when the online identity is missing', () => {
    expect(canPickCell('choosing.listening', true, undefined, 2, players)).toBe(false)
    expect(canPickCell('choosing.listening', true, 'client-b', null, players)).toBe(false)
  })
})

describe('canBuzzPlayer', () => {
  it('keeps every local button available at one table', () => {
    expect(canBuzzPlayer(false, undefined, players[1]!)).toBe(true)
  })

  it('allows only the player assigned to this conference client', () => {
    expect(canBuzzPlayer(true, 'client-a', players[0]!)).toBe(true)
    expect(canBuzzPlayer(true, 'client-a', players[1]!)).toBe(false)
  })

  it('fails closed without an online identity', () => {
    expect(canBuzzPlayer(true, undefined, players[0]!)).toBe(false)
  })
})
