import type { ChatRole } from '../debug/trace.ts'
import type { ConferenceChatLine, ConferenceConversationLine } from '../conference/messages.ts'

export type VoiceStreamLine = ConferenceConversationLine & { note?: string }

export type ConversationStreamItem =
  | { kind: 'voice'; key: string; at: string; role: ChatRole; text: string; note?: string }
  | { kind: 'typed'; key: string; at: string; name: string; text: string }

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
