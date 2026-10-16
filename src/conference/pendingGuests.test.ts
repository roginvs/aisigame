import { describe, expect, it } from 'vitest'
import { pendingGuests } from '../ui/pendingGuests.ts'
import { commentaryContext, setPendingGuests } from '../game/commentary.ts'
import type { GameContext } from '../game/types.ts'

describe('гость посреди партии, ещё качает пакет', () => {
  it('в ряду: гость ростера без игрока партии, не мастер и не скрытый', () => {
    const roster = [
      { clientId: 'm', isMaster: true, hidden: false },
      { clientId: 'a', hidden: false },
      { clientId: 'b', hidden: false },
      { clientId: 'c', hidden: true },
    ]
    expect(pendingGuests(roster, [{ clientId: 'a' }]).map((entry) => entry.clientId)).toEqual(['b'])
  })

  it('ведущая знает: в комнате, но не играет', () => {
    const context = { packName: 'P', rounds: [], roundIndex: 0, players: [{ id: 1, name: 'Аня', score: 0 }], chooserId: 1, activePlayerId: null, heard: '', judgmentStatus: null, playedIds: [] } as unknown as GameContext
    setPendingGuests(['Боря'])
    const text = commentaryContext(context, [])
    expect(text).toContain('"joiningNotPlaying":["Боря"]')
    expect(text).toContain('ещё не играют')
    setPendingGuests([])
    expect(commentaryContext(context, [])).not.toContain('joiningNotPlaying')
  })
})
