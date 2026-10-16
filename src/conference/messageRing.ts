import {
  CONFERENCE_HISTORY_LIMIT,
  validConferenceMessageRing,
  type ConferenceHistoryMessage,
  type ConferenceMessageRing,
  type ConferenceMessageSlot,
} from './messages.ts'

export function emptyMessageRing(): ConferenceMessageRing {
  const ring: ConferenceMessageRing = { messageIndex: -1 }
  for (let i = 0; i < CONFERENCE_HISTORY_LIMIT; i++) ring[`message${i}`] = null
  return ring
}

/** Копирует только слоты и содержимое реплик, без полей партии и секретов протокола. */
export function readMessageRing(value: unknown): ConferenceMessageRing | null {
  if (!validConferenceMessageRing(value)) return null
  const ring = emptyMessageRing()
  ring.messageIndex = value.messageIndex
  for (let i = 0; i < CONFERENCE_HISTORY_LIMIT; i++) {
    const line = value[`message${i}`]
    if (!line) continue
    const at = line.at === undefined ? {} : { at: line.at }
    ring[`message${i}`] = line.kind === 'chat'
      ? { kind: 'chat', name: line.name, text: line.text, ...at }
      : { kind: 'conversation', ...(line.id === undefined ? {} : { id: line.id }), role: line.role, text: line.text, ...at,
          ...(line.note === undefined ? {} : { note: line.note }),
          ...(line.mark === undefined ? {} : { mark: line.mark }) }
  }
  return ring
}

/** Читает общий поток в порядке записи, включая одинаковые timestamps. */
export function messageRingEntries(ring: ConferenceMessageRing): Array<{ slot: ConferenceMessageSlot; message: ConferenceHistoryMessage }> {
  if (ring.messageIndex < 0) return []
  const entries: Array<{ slot: ConferenceMessageSlot; message: ConferenceHistoryMessage }> = []
  for (let offset = 1; offset <= CONFERENCE_HISTORY_LIMIT; offset++) {
    const slot: ConferenceMessageSlot = `message${(ring.messageIndex + offset) % CONFERENCE_HISTORY_LIMIT}`
    const message = ring[slot]
    if (message) entries.push({ slot, message })
  }
  return entries
}

/** Только миграция старого сохранения: ещё не записанные реплики восстановить нельзя. */
export function messageRingFromLegacyChat(chat: readonly { name: string; text: string; at?: string }[]): ConferenceMessageRing {
  const ring = emptyMessageRing()
  for (const line of chat.slice(-CONFERENCE_HISTORY_LIMIT)) {
    ring.messageIndex = (ring.messageIndex + 1) % CONFERENCE_HISTORY_LIMIT
    ring[`message${ring.messageIndex}`] = { kind: 'chat', ...line }
  }
  return ring
}
