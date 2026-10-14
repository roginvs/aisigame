import type { ChatRole, TraceEntry } from '../debug/trace.ts'
import type { ConferenceConversationLine } from './messages.ts'

export function conversationLineFromTrace(entry: TraceEntry): ConferenceConversationLine | null {
  if (entry.kind !== 'chat') return null
  const text = chatText(entry.detail)
  const note = entry.detail && typeof entry.detail === 'object' && 'note' in entry.detail && typeof entry.detail.note === 'string'
    ? entry.detail.note : undefined
  return text ? { role: chatRole(entry.detail), text, at: entry.at, ...(note ? { note } : {}) } : null
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
