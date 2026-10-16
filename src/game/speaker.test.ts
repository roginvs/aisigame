import { describe, expect, it } from 'vitest'
import { speakingPlayerId } from './speaker.ts'
import type { GameContext } from './types.ts'

const players = [{ id: 1, name: 'Вася', score: 0 }, { id: 2, name: 'Вася', score: 0 }, { id: 3, name: 'Маша', score: 0 }]
const ctx = (extra: Partial<GameContext> = {}) => ({ players, chooserId: 1, activePlayerId: null, finalists: [], finalCursor: 0, special: null, ...extra }) as unknown as GameContext
const special = (extra: object) => ({ kind: 'cat', giverId: 1, recipientId: 3, ...extra })

describe('кто говорит — подпись реплики игрока', () => {
  it('лобби, меню и конец игры — без имени («Услышано»)', () => {
    for (const path of ['startMenu', 'connecting', 'restoring', 'finished', 'failed', 'stopped']) expect(speakingPlayerId(path, ctx())).toBeNull()
    expect(speakingPlayerId('choosing.listening', ctx({ players: [] }))).toBeNull()
  })
  it('выбор ячейки — выбирающий', () => {
    expect(speakingPlayerId('choosing.listening', ctx({ chooserId: 3 }))).toBe(3)
  })
  it('ответ — отвечающий, по id: второй «Вася» — это игрок 2', () => {
    expect(speakingPlayerId('answering.hearing', ctx({ activePlayerId: 2 }))).toBe(2)
  })
  it('кот в мешке: отдаёт выбравший, ставку называет получатель', () => {
    expect(speakingPlayerId('cat.picking', ctx({ special: special({}) as never }))).toBe(1)
    expect(speakingPlayerId('cat.staking', ctx({ special: special({}) as never }))).toBe(3)
    expect(speakingPlayerId('cat.staking', ctx({ special: special({ recipientId: null }) as never }))).toBe(1)
  })
  it('аукцион — кого сейчас спрашиваем, иначе открывший', () => {
    expect(speakingPlayerId('auction.listening', ctx({ special: special({ kind: 'auction', recipientId: 2 }) as never }))).toBe(2)
    expect(speakingPlayerId('auction.listening', ctx({ special: special({ kind: 'auction', recipientId: null }) as never }))).toBe(1)
  })
  it('ставки финала — финалист по курсору', () => {
    expect(speakingPlayerId('finalBets.hearing', ctx({ finalists: [3, 1], finalCursor: 0 }))).toBe(3)
    expect(speakingPlayerId('finalBets.hearing', ctx({ finalists: [3, 1], finalCursor: 5 }))).toBeNull()
  })
})
