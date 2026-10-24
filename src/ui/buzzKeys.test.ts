import { describe, expect, it } from 'vitest'
import { localSeatKeyLabel, playerFromBuzzKey, playerIdFromLocalBuzzKey } from './buzzKeys.ts'

const plain = { alt: false, ctrl: false, meta: false, shift: false }

describe('playerFromBuzzKey', () => {
  it('maps left ctrl, space and right ctrl to the three players', () => {
    expect(playerFromBuzzKey('ControlLeft', { ...plain, ctrl: true })).toBe(1)
    expect(playerFromBuzzKey('Space', plain)).toBe(2)
    expect(playerFromBuzzKey('ControlRight', { ...plain, ctrl: true })).toBe(3)
  })

  it('на конференции клавиша бьёт местное место, а не глобальный id', () => {
    expect(playerIdFromLocalBuzzKey('Space', plain, [4])).toBe(4)
    expect(playerIdFromLocalBuzzKey('ControlLeft', { ...plain, ctrl: true }, [4, 7])).toBe(4)
    expect(playerIdFromLocalBuzzKey('ControlRight', { ...plain, ctrl: true }, [4, 7])).toBe(7)
    expect(playerIdFromLocalBuzzKey('Space', plain, [4, 7])).toBeNull()
    expect(playerIdFromLocalBuzzKey('Space', plain, [8, 9, 10, 11])).toBe(9)
    expect(playerIdFromLocalBuzzKey('Enter', plain, [4, 7])).toBeNull()
    expect(localSeatKeyLabel(0, 1)).toBe('пробел')
    expect(localSeatKeyLabel(1, 2)).toBe('правый Ctrl')
    expect(localSeatKeyLabel(3, 4)).toBeNull()
  })

  it('ignores other keys and modified space', () => {
    expect(playerFromBuzzKey('Enter', plain)).toBeNull()
    expect(playerFromBuzzKey('Control', { ...plain, ctrl: true })).toBeNull()
    expect(playerFromBuzzKey('Space', { ...plain, shift: true })).toBeNull()
    expect(playerFromBuzzKey('Space', { ...plain, ctrl: true })).toBeNull()
  })
})
