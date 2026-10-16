/** Гости в комнате, которые ещё не игроки партии (качают/сверяют пакет): видны сразу, с прогрессом. */
export function pendingGuests<T extends { clientId: string; isMaster?: boolean; hidden?: boolean }>(
  roster: readonly T[],
  players: readonly { clientId?: string }[],
): T[] {
  const playing = new Set(players.map((player) => player.clientId).filter(Boolean))
  return roster.filter((entry) => !entry.isMaster && !entry.hidden && !playing.has(entry.clientId))
}
