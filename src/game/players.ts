import type { Player, PlayerId } from './types.ts'

/** То, что стоит в поле имён, пока человек ничего не вписал. Пустое поле даёт тех же троих. */
export const defaultPlayerNames = 'Игрок 1; Игрок 2; Игрок 3;'

export function defaultPlayers(): Player[] {
  return [
    { id: 1, name: 'Игрок 1', score: 0 },
    { id: 2, name: 'Игрок 2', score: 0 },
    { id: 3, name: 'Игрок 3', score: 0 },
  ]
}

/** Имена через перевод строки или точку с запятой. Пустые куски пропускаются. Пустое поле — три игрока по умолчанию. */
export function playersFromNames(text: string): Player[] {
  const names = text
    .split(/[;\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (names.length === 0) return defaultPlayers()
  return names.map((name, index) => ({ id: index + 1, name, score: 0 }))
}

/** В начале раунда выбирает второй, если игроков хотя бы двое, иначе первый. */
export function openingChooser(players: readonly Player[]): PlayerId {
  if (players.length >= 2) return players.find((player) => player.id === 2)?.id ?? players[1]?.id ?? 1
  return players[0]?.id ?? 1
}

export function playerName(players: readonly Player[], id: PlayerId | null): string {
  if (id === null) return ''
  return players.find((player) => player.id === id)?.name ?? ''
}

/** «Отвечает Вася»: по имени игрока, а не по его id. */
export function answererStatus(context: { readonly players: readonly Player[] }, id: PlayerId | null | undefined): string {
  const name = context.players.find((player) => player.id === id)?.name?.trim()
  return name ? `Отвечает ${name}` : 'Отвечает игрок'
}

/** Строка в «Разговор» после нажатия кнопки: только при входе в ответ из чтения/кнопок. */
export function buzzAnswererLine(from: string, path: string, players: readonly Player[], activePlayerId: PlayerId | null): string | null {
  if (!path.startsWith('answering') || activePlayerId === null) return null
  if (!(from.startsWith('reading') || from.startsWith('buzzing') || from === 'falseStartCue')) return null
  return answererStatus({ players }, activePlayerId)
}
