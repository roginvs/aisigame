import { describe, expect, it } from 'vitest'
import type { Player } from '../game/types.ts'
import { canBuzzPlayer, canPickCell, conferenceSoloListenHint, conferenceTurnTitle } from './conferenceTurn.ts'

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

describe('conferenceTurnTitle', () => {
  const context = {
    players,
    chooserId: 1,
    activePlayerId: 1,
    finalists: [1, 2],
    finalCursor: 0,
    rounds: [
      { index: 0, name: 'Раунд', kind: 'normal' as const },
      { index: 1, name: 'Финал', kind: 'final' as const },
    ],
    roundIndex: 0,
  }

  it('показывает наблюдателю, кто выбирает вопрос, вместо общей команды', () => {
    expect(conferenceTurnTitle('choosing.listening', true, context)).toBe('Аня выбирает вопрос')
    expect(conferenceTurnTitle('choosing.clarifying', true, context)).toBe('Аня выбирает вопрос')
  })

  it('называет выбор темы финала', () => {
    expect(
      conferenceTurnTitle('choosing.listening', true, { ...context, roundIndex: 1 }),
    ).toBe('Аня выбирает тему финала')
  })

  it('показывает чужой ответ и ставку', () => {
    expect(conferenceTurnTitle('answering.waiting', true, context)).toBe('Аня отвечает')
    expect(conferenceTurnTitle('answering.hearing', true, context)).toBe('Аня отвечает')
    expect(conferenceTurnTitle('finalBets.hearing', true, context)).toBe('Аня делает ставку')
  })

  it('оставляет прежнюю подпись вне персонального хода или конференции', () => {
    expect(conferenceTurnTitle('answering.waiting', false, context)).toBeNull()
    expect(conferenceTurnTitle('judging', true, context)).toBeNull()
  })
})

describe('conferenceSoloListenHint', () => {
  it('показывает узкий слух на выборе и ответе', () => {
    expect(conferenceSoloListenHint('choosing.listening', true)).toBe('Никого другого не слушаю')
    expect(conferenceSoloListenHint('choosing.clarifying', true)).toBe('Никого другого не слушаю')
    expect(conferenceSoloListenHint('answering.waiting', true)).toBe('Никого другого не слушаю')
    expect(conferenceSoloListenHint('answering.hearing', true)).toBe('Никого другого не слушаю')
  })

  it('не показывает узкий слух, когда модель слышит всех', () => {
    expect(conferenceSoloListenHint('buzzing.open', true)).toBeNull()
    expect(conferenceSoloListenHint('finalBets.hearing', true)).toBeNull()
    expect(conferenceSoloListenHint('choosing.listening', false)).toBeNull()
  })
})
