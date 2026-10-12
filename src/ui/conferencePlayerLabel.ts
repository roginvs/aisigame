/**
 * Пока у joiner нет снимка с пакетом, локальная машина ещё с «Игрок 1…» —
 * на экране это выглядит как мусор. Пишем «нет данных».
 */
export function conferencePlayerLabel(name: string, hasMatchData: boolean): string {
  if (!hasMatchData) return 'нет данных'
  const trimmed = name.trim()
  return trimmed || 'нет данных'
}
