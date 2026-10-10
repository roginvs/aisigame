import { describe, expect, it } from 'vitest'
import { buzzKeyLabel, isKeyboardPlayer, playerFromBuzzKey } from '../ui/buzzKeys.ts'
import { defaultPlayerNames, defaultPlayers, openingChooser, playersFromNames } from './players.ts'

const plain = { alt: false, ctrl: false, meta: false, shift: false }

describe('playersFromNames', () => {
  it('берёт любое число имён и пропускает пустые строки', () => {
    expect(playersFromNames('Анна\n\n Борис \nВера\nГлеб').map((player) => player.name)).toEqual([
      'Анна',
      'Борис',
      'Вера',
      'Глеб',
    ])
    expect(playersFromNames('Анна; Борис; Вера;').map((player) => player.name)).toEqual(['Анна', 'Борис', 'Вера'])
    expect(playersFromNames('Анна; Борис\nВера').map((player) => player.name)).toEqual(['Анна', 'Борис', 'Вера'])
    expect(playersFromNames(defaultPlayerNames)).toEqual(defaultPlayers())
    expect(playersFromNames('Анна\nБорис').map((player) => player.id)).toEqual([1, 2])
    expect(playersFromNames('  \n')).toEqual(defaultPlayers())
    expect(playersFromNames(' ; ; ')).toEqual(defaultPlayers())
    expect(playersFromNames('')).toEqual(defaultPlayers())
  })

  it('клавиатура только у первых трёх, остальные только на экране', () => {
    const players = playersFromNames('Анна\nБорис\nВера\nГлеб')
    expect(players[3]?.id).toBe(4)
    expect(isKeyboardPlayer(1)).toBe(true)
    expect(isKeyboardPlayer(2)).toBe(true)
    expect(isKeyboardPlayer(3)).toBe(true)
    expect(isKeyboardPlayer(4)).toBe(false)
    expect(Object.keys(buzzKeyLabel)).toEqual(['1', '2', '3'])
    expect(playerFromBuzzKey('ControlLeft', { ...plain, ctrl: true })).toBe(1)
    expect(playerFromBuzzKey('Space', plain)).toBe(2)
    expect(playerFromBuzzKey('ControlRight', { ...plain, ctrl: true })).toBe(3)
    expect(playerFromBuzzKey('Digit4', plain)).toBeNull()
  })

  it('в начале раунда выбирает второго, а одного игрока — его самого', () => {
    expect(openingChooser(playersFromNames('А\nБ\nВ'))).toBe(2)
    expect(openingChooser(playersFromNames('Один'))).toBe(1)
  })
})
