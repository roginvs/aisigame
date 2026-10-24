/** Места одного устройства: несколько игроков, один clientId, один микрофон. */

export const MAX_SEATS_PER_DEVICE = 8
export const MAX_SEAT_NAME = 40

export type RosterSeat = {
  name: string
  playerId: number | null
}

/** Имена из поля конференции: новая строка или точка с запятой. Пустые куски выкидываются. */
export function seatNamesFromText(text: string): string[] {
  const names: string[] = []
  for (const part of text.split(/[;\r\n]+/)) {
    const name = part.trim().slice(0, MAX_SEAT_NAME)
    if (!name) continue
    names.push(name)
    if (names.length >= MAX_SEATS_PER_DEVICE) break
  }
  return names
}

/** Подпись устройства в Jitsi, чате и presence: «Аня, Боря». Не длиннее 100 символов. */
export function seatLabel(names: readonly string[]): string {
  const label = names.map((name) => name.trim()).filter((name) => name.length > 0).join(', ')
  if (label.length <= 100) return label
  return `${label.slice(0, 99)}…`
}

export function conferenceDisplayName(text: string): string {
  const names = seatNamesFromText(text)
  if (names.length === 0) return text.trim().slice(0, MAX_SEAT_NAME) || 'Игрок'
  return seatLabel(names)
}

/** hello: новый клиент шлёт names, старый — одно name. Пустой список — некуда сажать. */
export function helloSeatNames(message: { name?: string; names?: readonly string[] }): string[] {
  if (message.names && message.names.length > 0) {
    const names: string[] = []
    for (const part of message.names) {
      const name = part.trim().slice(0, MAX_SEAT_NAME)
      if (!name) continue
      names.push(name)
      if (names.length >= MAX_SEATS_PER_DEVICE) break
    }
    if (names.length > 0) return names
  }
  const one = message.name?.trim().slice(0, MAX_SEAT_NAME)
  return one ? [one] : []
}

/** Нет seats в старом снимке — одно место из подписи устройства. */
export function rosterSeats(entry: {
  name: string
  playerId: number | null
  seats?: readonly RosterSeat[]
}): RosterSeat[] {
  if (entry.seats && entry.seats.length > 0) {
    return entry.seats.map((seat) => ({ name: seat.name, playerId: seat.playerId }))
  }
  return [{ name: entry.name, playerId: entry.playerId }]
}

/**
 * Чей ход на общем микрофоне устройства. Голос не делится: если ход у места этого
 * устройства — это оно; иначе первое место, которое ещё может жать кнопку.
 */
export function deviceSpeechPlayerId(input: {
  seatIds: readonly number[]
  phase: string
  answererId: number | null
  chooserId: number | null
  missedIds: readonly number[]
  listenerId: number | null
}): number | null {
  const ids = input.seatIds
  if (ids.length === 0) return null
  const has = (id: number | null): id is number => id !== null && ids.includes(id)
  const phase = input.phase
  if ((phase.startsWith('answering') || phase === 'appealCue' || phase === 'judging') && has(input.answererId)) {
    return input.answererId
  }
  if (phase.startsWith('choosing') && has(input.chooserId)) return input.chooserId
  if ((phase.startsWith('cat.') || phase.startsWith('auction.')) && has(input.listenerId)) return input.listenerId
  const missed = new Set(input.missedIds)
  return ids.find((id) => !missed.has(id)) ?? ids[0] ?? null
}
