import type { GameContext, Player, PlayerId } from '../game/types.ts'

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

/** В конференции персональный ход подписываем именем вместо противоречивого общего запрета говорить. */
export function conferenceTurnTitle(
  path: string,
  conferenceLayout: boolean,
  context: Pick<
    GameContext,
    'players' | 'chooserId' | 'activePlayerId' | 'finalists' | 'finalCursor' | 'rounds' | 'roundIndex'
  >,
): string | null {
  if (!conferenceLayout) return null

  let playerId: PlayerId | null = null
  let action = ''
  if (path === 'choosing.listening' || path === 'choosing.clarifying') {
    playerId = context.chooserId
    const finalRound = context.rounds.find((round) => round.index === context.roundIndex)?.kind === 'final'
    action = finalRound ? 'выбирает тему финала' : 'выбирает вопрос'
  } else if (path === 'answering.waiting' || path === 'answering.hearing') {
    playerId = context.activePlayerId
    action = 'отвечает'
  } else if (path === 'finalBets.hearing') {
    playerId = context.finalists[context.finalCursor] ?? null
    action = 'делает ставку'
  }

  if (playerId === null) return null
  const player = context.players.find((candidate) => candidate.id === playerId)
  if (!player) return null
  return `${player.name} ${action}`
}

/**
 * Что модель сейчас слышит в миксе — строка под карточкой ведущей.
 * На выборе/ответе: «Слушаю Имя». С галкой «Меньше слышать» вне хода: «Ничего не слышу»;
 * в лобби при галке — «Слушаю всех». Без галки вне узкого хода подписи нет (микс общий).
 */
export function conferenceSoloListenHint(
  path: string,
  conferenceLayout: boolean,
  options: { hearTurnOnly?: boolean; focusName?: string | null } = {},
): string | null {
  if (!conferenceLayout) return null
  const root = path.split('.')[0] ?? path
  const name = options.focusName?.trim() || ''
  if (root === 'choosing' || root === 'answering') {
    return name ? `Слушаю ${name}` : 'Слушаю одного игрока'
  }
  if (!options.hearTurnOnly) return null
  if (root === 'startMenu' || root === 'connecting' || root === 'failed') return 'Слушаю всех'
  return 'Ничего не слышу'
}
