import type { ChatMark, ChatRole } from '../debug/trace.ts'
import type { ConferenceChatLine, ConferenceConversationLine, ConferenceMessageRing } from '../conference/messages.ts'
import { messageRingEntries } from '../conference/messageRing.ts'

export type VoiceStreamLine = ConferenceConversationLine & { note?: string }

export type ConversationStreamItem =
  | { kind: 'voice'; key: string; at: string; role: ChatRole; text: string; note?: string; mark?: ChatMark; speakerId?: number }
  | { kind: 'typed'; key: string; at: string; name: string; text: string }

/** Конференция читает единственный буфер напрямую, без разделения и сортировки. */
export function conversationStreamFromRing(ring: ConferenceMessageRing): ConversationStreamItem[] {
  return messageRingEntries(ring).map(({ slot, message }) => {
    const key = `${slot}-${message.at ?? ''}-${message.kind}`
    return message.kind === 'chat'
      ? { kind: 'typed', key, at: message.at ?? '', name: message.name, text: message.text }
      : { kind: 'voice', key, at: message.at ?? '', role: message.role, text: message.text, ...(message.note ? { note: message.note } : {}), ...(message.mark ? { mark: message.mark } : {}), ...(message.speakerId !== undefined ? { speakerId: message.speakerId } : {}) }
  })
}

function stampMs(at: string | undefined): number {
  if (!at) return Number.POSITIVE_INFINITY
  const value = Date.parse(at)
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
}

/** Сливает голосовые реплики и текстовый чат в один хронологический поток. */
export function mergeConversationStream(
  conversation: readonly VoiceStreamLine[],
  chat: readonly ConferenceChatLine[],
): ConversationStreamItem[] {
  const items: Array<ConversationStreamItem & { order: number; time: number }> = []
  conversation.forEach((line, index) => {
    const text = line.text.trim()
    if (!text) return
    items.push({
      kind: 'voice',
      key: `voice-${index}-${line.role}-${text.slice(0, 24)}`,
      at: line.at ?? '',
      role: line.role,
      text,
      ...(line.note?.trim() ? { note: line.note.trim() } : {}),
      ...(line.mark ? { mark: line.mark } : {}),
      ...(line.speakerId !== undefined ? { speakerId: line.speakerId } : {}),
      order: index,
      time: stampMs(line.at),
    })
  })
  const voiceCount = conversation.length
  chat.forEach((line, index) => {
    const text = line.text.trim()
    if (!text) return
    items.push({
      kind: 'typed',
      key: `typed-${index}-${line.name}-${text.slice(0, 24)}`,
      at: line.at ?? '',
      name: line.name,
      text,
      order: voiceCount + index,
      time: stampMs(line.at),
    })
  })
  items.sort((left, right) => left.time - right.time || left.order - right.order)
  return items.map(({ order: _order, time: _time, ...item }) => item)
}
