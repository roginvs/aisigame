import { describe, expect, it } from 'vitest'
import { findQuestion, nextInCell } from './pack.ts'
import type { Question } from './types.ts'

const stack: Question[] = [
  {
    id: 'r0-t0-100-0',
    roundIndex: 0,
    themeId: 'r0-t0',
    themeName: 'Тема 1',
    value: 100,
    text: 'Первый',
    answers: ['да'],
  },
  {
    id: 'r0-t0-100-2',
    roundIndex: 0,
    themeId: 'r0-t0',
    themeName: 'Тема 1',
    value: 100,
    text: 'Следующий',
    answers: ['да'],
  },
  {
    id: 'r0-t1-100-0',
    roundIndex: 0,
    themeId: 'r0-t1',
    themeName: 'Тема 2',
    value: 100,
    text: 'Другая',
    answers: ['да'],
  },
]

describe('стопка вопросов одной цены', () => {
  it('оставляет ячейку, пока сыгран не весь номинал, и открывает следующий вопрос', () => {
    const played = ['r0-t0-100-0']
    expect(nextInCell(stack, 0, 'r0-t0', 100, played)?.id).toBe('r0-t0-100-2')
    expect(findQuestion(stack, 0, 'Тема 1', 100, 'normal', played)?.id).toBe('r0-t0-100-2')
    expect(nextInCell(stack, 0, 'r0-t1', 100, played)?.id).toBe('r0-t1-100-0')
  })

  it('убирает ячейку, когда сыграны все вопросы этой цены', () => {
    const played = ['r0-t0-100-0', 'r0-t0-100-2']
    expect(nextInCell(stack, 0, 'r0-t0', 100, played)).toBeUndefined()
    expect(findQuestion(stack, 0, 'r0-t0', 100, 'normal', played)).toBeUndefined()
    expect(nextInCell(stack, 0, 'r0-t1', 100, played)?.id).toBe('r0-t1-100-0')
  })
})
