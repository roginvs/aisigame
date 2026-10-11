import type { Player, PlayerId } from '../game/types.ts'

/**
 * In conference mode only the client assigned to the chooser may use the board.
 * Table mode deliberately keeps the local shared-board behaviour.
 */
export function canPickCell(
  path: string,
  conferenceLayout: boolean,
  selfClientId: string | undefined,
  chooserId: PlayerId | null,
  players: readonly Player[],
): boolean {
  if (path !== 'choosing.listening') return false
  if (!conferenceLayout) return true
  if (!selfClientId || chooserId === null) return false
  return players.some((player) => player.id === chooserId && player.clientId === selfClientId)
}

/** В конференции каждый браузер управляет только назначенным ему игроком. */
export function canBuzzPlayer(
  conferenceLayout: boolean,
  selfClientId: string | undefined,
  player: Player,
): boolean {
  if (!conferenceLayout) return true
  if (!selfClientId) return false
  return player.clientId === selfClientId
}
