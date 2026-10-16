import { chatLineId, readChatMark, type ChatRole, type TraceEntry } from '../debug/trace.ts'
import type { ConferenceConversationLine } from './messages.ts'

export function conversationLineFromTrace(entry: TraceEntry): ConferenceConversationLine | null {
  if (entry.kind !== 'chat') return null
  if (entry.detail && typeof entry.detail === 'object' && 'removed' in entry.detail && entry.detail.removed === true) return null
  const text = chatText(entry.detail)
  const note = entry.detail && typeof entry.detail === 'object' && 'note' in entry.detail && typeof entry.detail.note === 'string'
    ? entry.detail.note : undefined
  const mark = entry.detail && typeof entry.detail === 'object' && 'mark' in entry.detail ? readChatMark(entry.detail.mark) : undefined
  return text ? { id: chatLineId(entry.id), role: chatRole(entry.detail), text, at: entry.at, ...(note ? { note } : {}), ...(mark ? { mark } : {}) } : null
}

function chatRole(detail: unknown): ChatRole {
  if (detail && typeof detail === 'object' && 'role' in detail) {
    const role = (detail as { role?: unknown }).role
    if (role === 'host' || role === 'player' || role === 'judge' || role === 'error' || role === 'system') return role
  }
  return 'host'
}

function chatText(detail: unknown): string {
  if (detail && typeof detail === 'object' && 'text' in detail && typeof (detail as { text: unknown }).text === 'string') {
    return (detail as { text: string }).text.trim()
  }
  return ''
}
