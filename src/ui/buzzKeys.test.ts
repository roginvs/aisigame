import { describe, expect, it } from 'vitest'
import { playerFromBuzzKey } from './buzzKeys.ts'

const plain = { alt: false, ctrl: false, meta: false, shift: false }

describe('playerFromBuzzKey', () => {
  it('maps left ctrl, space and right ctrl to the three players', () => {
    expect(playerFromBuzzKey('ControlLeft', { ...plain, ctrl: true })).toBe(1)
    expect(playerFromBuzzKey('Space', plain)).toBe(2)
    expect(playerFromBuzzKey('ControlRight', { ...plain, ctrl: true })).toBe(3)
  })

  it('ignores other keys and modified space', () => {
    expect(playerFromBuzzKey('Enter', plain)).toBeNull()
    expect(playerFromBuzzKey('Control', { ...plain, ctrl: true })).toBeNull()
    expect(playerFromBuzzKey('Space', { ...plain, shift: true })).toBeNull()
    expect(playerFromBuzzKey('Space', { ...plain, ctrl: true })).toBeNull()
  })
})
